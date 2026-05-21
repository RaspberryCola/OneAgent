//! JSON-RPC process transport layer and client handlers.
//!
//! This module handles spawning and communicating with ACP agent processes
//! via JSON-RPC over stdin/stdout, including fs and terminal client methods.

use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, Mutex},
    time::{timeout, Duration},
};
use uuid::Uuid;

use crate::{
    agent_adapters::{AdapterError, AdapterResult, RuntimeStreamEvent},
    capability_services::agent_launch::{resolve_launch, LaunchResolutionError},
    domain::AgentProfile,
};

use super::parser::jsonrpc_error_message;
use super::types::{
    jsonrpc_request, to_value_or_err, AcpClientCapabilities, AcpClientFsCapabilities,
    AcpClientInfo, ACP_PROTOCOL_VERSION, FsReadTextFileParams, FsWriteTextFileParams,
    InitializeParams, TerminalCreateParams, TerminalIdParams, TerminalOutputParams,
};

/// A handle to a spawned terminal process.
#[derive(Clone)]
pub(crate) struct TerminalHandle {
    child: Arc<Mutex<Child>>,
    cwd: Option<String>,
    command: String,
    args: Vec<String>,
    stdout: Option<Arc<Mutex<BufReader<tokio::process::ChildStdout>>>>,
    stderr: Option<Arc<Mutex<BufReader<tokio::process::ChildStderr>>>>,
}

/// A JSON-RPC process connection to an ACP agent.
pub(crate) struct JsonRpcProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    session_cwd: PathBuf,
    pub(crate) current_turn_id: Option<String>,
    pub(crate) current_event_tx: Option<mpsc::UnboundedSender<RuntimeStreamEvent>>,
    pub(crate) terminals: Arc<Mutex<BTreeMap<String, TerminalHandle>>>,
    stderr_lines: Arc<Mutex<VecDeque<String>>>,
}

impl JsonRpcProcess {
    /// Spawn a new agent process for the given profile.
    pub(crate) async fn spawn(profile: &AgentProfile) -> AdapterResult<Self> {
        let resolved = resolve_launch(profile).map_err(map_launch_resolution_error)?;
        eprintln!("OneAgent ACP launch: {}", resolved.summary);
        tracing::debug!("OneAgent ACP launch: {}", resolved.summary);
        let mut command = Command::new(&resolved.command);
        command
            .args(&resolved.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &resolved.cwd {
            command.current_dir(cwd);
        }
        command.envs(resolved.env);
        let mut child = command.spawn().map_err(|error| {
            AdapterError::AdapterSpawnFailed(format!(
                "Failed to spawn {}: {error}",
                resolved.summary
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Protocol("child stdin unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Protocol("child stdout unavailable".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AdapterError::Protocol("child stderr unavailable".to_string()))?;
        let stderr_lines = Arc::new(Mutex::new(VecDeque::with_capacity(12)));
        spawn_stderr_reader(stderr, stderr_lines.clone());
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            session_cwd: PathBuf::from("."),
            current_turn_id: None,
            current_event_tx: None,
            terminals: Arc::new(Mutex::new(BTreeMap::new())),
            stderr_lines,
        })
    }

    /// Set the session working directory for path resolution.
    pub(crate) fn set_session_cwd(&mut self, cwd: &str) {
        self.session_cwd = PathBuf::from(cwd);
    }

    /// Bind the process to a specific turn for event emission.
    pub(crate) fn bind_turn(
        &mut self,
        turn_id: &str,
        event_tx: &mpsc::UnboundedSender<RuntimeStreamEvent>,
    ) {
        self.current_turn_id = Some(turn_id.to_string());
        self.current_event_tx = Some(event_tx.clone());
    }

    /// Clear the turn binding.
    pub(crate) fn clear_turn(&mut self) {
        self.current_turn_id = None;
        self.current_event_tx = None;
    }

    /// Emit a terminal event to the current event channel.
    fn emit_terminal_event(
        &self,
        terminal_id: &str,
        event: &str,
        cwd: Option<String>,
        command: Option<String>,
        args: serde_json::Value,
        stream: Option<String>,
        content: Option<String>,
        exit_code: Option<i64>,
    ) {
        if let (Some(turn_id), Some(tx)) = (&self.current_turn_id, &self.current_event_tx) {
            let _ = tx.send(RuntimeStreamEvent::TerminalEvent {
                turn_id: turn_id.clone(),
                terminal_id: terminal_id.to_string(),
                event: event.to_string(),
                cwd,
                command,
                args,
                stream,
                content,
                exit_code,
            });
        }
    }

    /// Initialize the ACP session with the agent.
    pub(crate) async fn initialize(&mut self) -> AdapterResult<Value> {
        let params = InitializeParams {
            protocol_version: ACP_PROTOCOL_VERSION,
            client_capabilities: AcpClientCapabilities {
                fs: AcpClientFsCapabilities {
                    read_text_file: true,
                    write_text_file: true,
                },
                terminal: true,
            },
            client_info: AcpClientInfo {
                name: "oneagent",
                title: "OneAgent Desktop",
                version: "0.1.0",
            },
        };
        let params_value = to_value_or_err(params, "initialize")?;
        match self.request("initialize", params_value).await {
            Ok(value) => Ok(value),
            Err(error) => Err(classify_initialize_error(
                error,
                self.stderr_excerpt().await,
            )),
        }
    }

    pub(crate) fn next_id(&mut self) -> i64 {
        let current = self.next_id;
        self.next_id += 1;
        current
    }

    /// Send a JSON-RPC request and wait for the response.
    pub(crate) async fn request(&mut self, method: &str, params: Value) -> AdapterResult<Value> {
        let id = self.next_id();
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;
        loop {
            let response = self.read_message().await?;
            if response.get("method").and_then(Value::as_str).is_some() {
                self.handle_client_request(&response).await?;
                continue;
            }
            if response.get("id").and_then(Value::as_i64) == Some(id) {
                if let Some(error_message) = jsonrpc_error_message(&response) {
                    return Err(AdapterError::Protocol(format!(
                        "{method} failed: {error_message}"
                    )));
                }
                return Ok(response);
            }
        }
    }

    /// Write a JSON-RPC message to stdin.
    pub(crate) async fn write_message(&mut self, message: Value) -> AdapterResult<()> {
        let line = serde_json::to_string(&message)?;
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Read a JSON-RPC message from stdout.
    pub(crate) async fn read_message(&mut self) -> AdapterResult<Value> {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        if line.trim().is_empty() {
            let stderr_excerpt = self.stderr_excerpt().await;
            return Err(AdapterError::Protocol(match stderr_excerpt {
                Some(stderr_excerpt) => {
                    format!("empty response from agent; stderr: {stderr_excerpt}")
                }
                None => "empty response from agent".to_string(),
            }));
        }
        Ok(serde_json::from_str(line.trim())?)
    }

    /// Close the process connection.
    pub(crate) async fn close(&mut self) -> AdapterResult<()> {
        if let Err(e) = self.child.kill().await {
            tracing::warn!("Failed to kill agent process: {}", e);
        }
        Ok(())
    }

    async fn stderr_excerpt(&self) -> Option<String> {
        let lines = self.stderr_lines.lock().await;
        if lines.is_empty() {
            None
        } else {
            Some(lines.iter().cloned().collect::<Vec<_>>().join(" | "))
        }
    }

    /// Handle a client request from the agent (fs/terminal operations).
    pub(crate) async fn handle_client_request(&mut self, message: &Value) -> AdapterResult<()> {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Ok(());
        };
        match method {
            "fs/read_text_file" => self.handle_fs_read(message).await?,
            "fs/write_text_file" => self.handle_fs_write(message).await?,
            "terminal/create" => self.handle_terminal_create(message).await?,
            "terminal/read" => self.handle_terminal_read(message).await?,
            "terminal/wait_for_exit" => self.handle_terminal_wait(message).await?,
            "terminal/kill" => self.handle_terminal_kill(message).await?,
            "terminal/release" => self.handle_terminal_release(message).await?,
            "terminal/output" => self.handle_terminal_output(message).await?,
            "session/request_permission" => {}
            _ => {
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    self.write_message(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("unsupported client method: {method}")
                        }
                    }))
                    .await?;
                }
            }
        }
        Ok(())
    }

    // FS client methods

    async fn handle_fs_read(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<FsReadTextFileParams>(message)?;
        let path = &params.path;
        let resolved = match self.resolve_workspace_path(path) {
            Ok(p) => p,
            Err(e) => return self.write_jsonrpc_error(id, -32602, &e.to_string()).await,
        };
        let raw = match tokio::fs::read_to_string(&resolved).await {
            Ok(content) => content,
            Err(e) => return self.write_jsonrpc_error(id, -32603, &e.to_string()).await,
        };
        let mime = mime_guess::from_path(&resolved)
            .first_raw()
            .unwrap_or("text/plain")
            .to_string();
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": {
                    "uri": format!("file://{}", resolved.display()),
                    "mimeType": mime,
                    "text": raw
                }
            }
        }))
        .await
    }

    async fn handle_fs_write(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<FsWriteTextFileParams>(message)?;
        let path = &params.path;
        let content = &params.content;
        let resolved = match self.resolve_workspace_path(path) {
            Ok(p) => p,
            Err(e) => return self.write_jsonrpc_error(id, -32602, &e.to_string()).await,
        };
        if let Some(parent) = resolved.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return self.write_jsonrpc_error(id, -32603, &e.to_string()).await;
            }
        }
        if let Err(e) = tokio::fs::write(&resolved, content).await {
            return self.write_jsonrpc_error(id, -32603, &e.to_string()).await;
        }
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }))
        .await
    }

    fn resolve_workspace_path(&self, requested: &str) -> AdapterResult<PathBuf> {
        let requested = PathBuf::from(requested);
        let candidate = if requested.is_absolute() {
            requested
        } else {
            self.session_cwd.join(requested)
        };
        let root = self
            .session_cwd
            .canonicalize()
            .unwrap_or_else(|_| self.session_cwd.clone());
        // Prefer canonicalize to resolve symlinks; fall back to manual normalization
        // when the path doesn't exist yet (e.g. a file about to be written).
        let normalized = candidate
            .canonicalize()
            .unwrap_or_else(|_| normalize_path(&candidate));
        if normalized.starts_with(&root) || normalized == root {
            Ok(normalized)
        } else {
            Err(AdapterError::Protocol(format!(
                "requested path {} is outside workspace {}",
                normalized.display(),
                root.display()
            )))
        }
    }

    // Terminal client methods

    async fn handle_terminal_create(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<TerminalCreateParams>(message)?;
        let command = &params.command;
        let args = &params.args;
        let cwd = params.cwd.as_deref();
        if let Some(cwd) = cwd {
            self.resolve_workspace_path(cwd)?;
        }
        let terminal_id = Uuid::new_v4().to_string();
        let mut child = if args.is_empty() && command.contains(' ') {
            if cfg!(target_os = "windows") {
                let mut c = Command::new("cmd");
                c.arg("/D").arg("/C").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        } else {
            let mut c = Command::new(command);
            c.args(args);
            c
        };
        child
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            child.current_dir(cwd);
        }
        let mut spawned = child.spawn()?;
        let stdout = spawned.stdout.take();
        let stderr = spawned.stderr.take();
        self.terminals.lock().await.insert(
            terminal_id.clone(),
            TerminalHandle {
                child: Arc::new(Mutex::new(spawned)),
                cwd: cwd.map(ToOwned::to_owned),
                command: command.to_string(),
                args: args.clone(),
                stdout: stdout.map(|s| Arc::new(Mutex::new(BufReader::new(s)))),
                stderr: stderr.map(|s| Arc::new(Mutex::new(BufReader::new(s)))),
            },
        );
        self.emit_terminal_event(
            &terminal_id,
            "created",
            cwd.map(ToOwned::to_owned),
            Some(command.to_string()),
            json!(args),
            None,
            None,
            None,
        );
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "terminalId": terminal_id
            }
        }))
        .await
    }

    async fn handle_terminal_output(&mut self, message: &Value) -> AdapterResult<()> {
        if let Ok(params) = extract_params::<TerminalOutputParams>(message) {
            let content = params.content.as_deref().unwrap_or("");
            let stream = params.stream.as_deref().unwrap_or("stdout");

            if !content.is_empty() {
                self.emit_terminal_event(
                    &params.terminal_id,
                    "output",
                    None,
                    None,
                    json!([]),
                    Some(stream.to_string()),
                    Some(content.to_string()),
                    None,
                );
            }
        }

        if let Ok(id) = message_id(message) {
            self.write_message(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": null
            }))
            .await?;
        }
        Ok(())
    }

    async fn handle_terminal_read(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<TerminalIdParams>(message)?;
        let terminal_id = &params.terminal_id;
        let (stdout, stderr, cwd, command, args) = {
            let terminals = self.terminals.lock().await;
            let handle = terminals
                .get(terminal_id)
                .ok_or_else(|| AdapterError::Protocol("unknown terminalId".to_string()))?;
            (
                handle.stdout.clone(),
                handle.stderr.clone(),
                handle.cwd.clone(),
                handle.command.clone(),
                handle.args.clone(),
            )
        };
        let stdout_text = read_available(stdout).await?;
        let stderr_text = read_available(stderr).await?;
        if !stdout_text.is_empty() {
            self.emit_terminal_event(
                terminal_id,
                "output",
                cwd.clone(),
                Some(command.clone()),
                json!(args.clone()),
                Some("stdout".to_string()),
                Some(stdout_text.clone()),
                None,
            );
        }
        if !stderr_text.is_empty() {
            self.emit_terminal_event(
                terminal_id,
                "output",
                cwd,
                Some(command),
                json!(args),
                Some("stderr".to_string()),
                Some(stderr_text.clone()),
                None,
            );
        }
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "stdout": stdout_text,
                "stderr": stderr_text
            }
        }))
        .await
    }

    async fn handle_terminal_wait(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<TerminalIdParams>(message)?;
        let terminal_id = &params.terminal_id;
        let (child, cwd, command, args) = {
            let terminals = self.terminals.lock().await;
            let handle = terminals
                .get(terminal_id)
                .ok_or_else(|| AdapterError::Protocol("unknown terminalId".to_string()))?;
            (
                handle.child.clone(),
                handle.cwd.clone(),
                handle.command.clone(),
                handle.args.clone(),
            )
        };
        let status = child.lock().await.wait().await?;
        self.emit_terminal_event(
            terminal_id,
            "exited",
            cwd,
            Some(command),
            json!(args),
            None,
            None,
            status.code().map(i64::from),
        );
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                // status.code() is None when the process was terminated by a signal.
                // Return -1 as a sentinel to avoid null, which JS destructuring cannot handle.
                "exitCode": status.code().unwrap_or(-1)
            }
        }))
        .await
    }

    async fn handle_terminal_kill(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<TerminalIdParams>(message)?;
        let terminal_id = &params.terminal_id;
        let (child, cwd, command, args) = {
            let terminals = self.terminals.lock().await;
            let handle = terminals
                .get(terminal_id)
                .ok_or_else(|| AdapterError::Protocol("unknown terminalId".to_string()))?;
            (
                handle.child.clone(),
                handle.cwd.clone(),
                handle.command.clone(),
                handle.args.clone(),
            )
        };
        let _ = child.lock().await.kill().await;
        self.emit_terminal_event(
            terminal_id,
            "killed",
            cwd,
            Some(command),
            json!(args),
            None,
            None,
            None,
        );
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }))
        .await
    }

    async fn handle_terminal_release(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = extract_params::<TerminalIdParams>(message)?;
        let terminal_id = &params.terminal_id;
        let metadata = self.terminals.lock().await.remove(terminal_id);
        let (cwd, command, args) = if let Some(handle) = metadata {
            (handle.cwd, Some(handle.command), json!(handle.args))
        } else {
            (None, None, json!([]))
        };
        self.emit_terminal_event(
            terminal_id,
            "released",
            cwd,
            command,
            args,
            None,
            None,
            None,
        );
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }))
        .await
    }

    async fn write_jsonrpc_error(
        &mut self,
        id: i64,
        code: i64,
        message: &str,
    ) -> AdapterResult<()> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }))
        .await
    }
}

// Helper functions

fn map_launch_resolution_error(error: LaunchResolutionError) -> AdapterError {
    match error {
        LaunchResolutionError::RuntimeNotFound(message) => AdapterError::RuntimeNotFound(message),
        LaunchResolutionError::AdapterNotFound(message) => AdapterError::AdapterNotFound(message),
        LaunchResolutionError::AdapterSpawnFailed(message) => {
            AdapterError::AdapterSpawnFailed(message)
        }
    }
}

fn classify_initialize_error(error: AdapterError, stderr_excerpt: Option<String>) -> AdapterError {
    let stderr_text = stderr_excerpt.unwrap_or_default();
    let combined = if stderr_text.is_empty() {
        error.to_string()
    } else {
        format!("{}; stderr: {}", error, stderr_text)
    };
    let lower = combined.to_lowercase();
    if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("anthropic_api_key")
        || lower.contains("api key")
        || lower.contains("credential")
    {
        AdapterError::ClaudeAuthRequired(combined)
    } else {
        AdapterError::AcpInitializeFailed(combined)
    }
}

fn spawn_stderr_reader<R>(stderr: R, buffer: Arc<Mutex<VecDeque<String>>>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let mut buffer = buffer.lock().await;
                    if buffer.len() >= 12 {
                        buffer.pop_front();
                    }
                    buffer.push_back(trimmed.to_string());
                }
                Err(_) => break,
            }
        }
    });
}

pub(crate) fn message_id(message: &Value) -> AdapterResult<i64> {
    message
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| AdapterError::Protocol("message missing id".to_string()))
}

/// Extract and deserialize typed params from a JSON-RPC message.
fn extract_params<T: serde::de::DeserializeOwned>(message: &Value) -> AdapterResult<T> {
    let params = message
        .get("params")
        .ok_or_else(|| AdapterError::Protocol("message missing params".to_string()))?;
    serde_json::from_value(params.clone()).map_err(|e| {
        AdapterError::Protocol(format!("invalid params: {e}"))
    })
}

pub(crate) async fn read_available<R>(
    reader: Option<Arc<Mutex<BufReader<R>>>>,
) -> AdapterResult<String>
where
    R: AsyncRead + Unpin,
{
    let Some(reader) = reader else {
        return Ok(String::new());
    };
    let mut reader = reader.lock().await;
    let mut buf = [0_u8; 4096];
    let read = match timeout(Duration::from_millis(5), reader.read(&mut buf)).await {
        Ok(Ok(size)) => size,
        Ok(Err(err)) => return Err(AdapterError::Io(err)),
        Err(_) => 0,
    };
    Ok(String::from_utf8_lossy(&buf[..read]).to_string())
}

pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths() {
        let normalized = normalize_path(Path::new("/tmp/workspace/../workspace/file.txt"));
        assert_eq!(normalized, Path::new("/tmp/workspace/file.txt"));
    }
}
