use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    io::AsyncRead,
    sync::{mpsc, oneshot, Mutex},
    time::{timeout, Duration},
};
use uuid::Uuid;

use crate::{
    agent_adapters::{AdapterError, AdapterResult, AgentAdapter, AgentSessionHandle, LoadedSession, RuntimeStreamEvent},
    domain::{
        AgentCapabilities, AgentProfile, AgentPromptCapabilities, AgentSessionCapabilities,
        AcpAvailableModel, AcpSessionModels, AttachmentDeliveryPreference, AttachmentInput, AttachmentKind, ExternalSession,
        McpServerConfig, PermissionDecisionKind, SessionConfigOption,
    },
};

const ACP_PROTOCOL_VERSION: &str = "2025-11-25";
const MAX_EMBEDDED_TEXT_BYTES: u64 = 128 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_EMBEDDED_AUDIO_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Default)]
pub struct AcpAdapter;

#[derive(Clone)]
pub struct AcpLiveSession {
    command_tx: mpsc::UnboundedSender<LiveSessionCommand>,
    pub handle: AgentSessionHandle,
}

#[derive(Debug)]
enum LiveSessionCommand {
    RunTurn {
        prompt: Vec<Value>,
        event_tx: mpsc::UnboundedSender<RuntimeStreamEvent>,
        completion_tx: oneshot::Sender<AdapterResult<()>>,
    },
    ResolvePermission {
        tool_call_id: String,
        decision: PermissionDecisionKind,
        resp: oneshot::Sender<AdapterResult<()>>,
    },
    Cancel {
        resp: oneshot::Sender<AdapterResult<()>>,
    },
    SetConfig {
        config_id: String,
        value: Value,
        resp: oneshot::Sender<AdapterResult<Vec<SessionConfigOption>>>,
    },
    Close,
}

#[derive(Debug, Clone)]
struct PendingPermission {
    request_id: i64,
    options: Vec<PermissionOption>,
}

#[derive(Debug, Clone)]
struct PermissionOption {
    option_id: String,
    kind: String,
}

#[async_trait]
impl AgentAdapter for AcpAdapter {
    async fn initialize(&self, profile: &AgentProfile) -> AdapterResult<AgentCapabilities> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        let response = process.initialize().await?;
        process.close().await?;
        let result = response.get("result").cloned().unwrap_or_else(|| json!({}));
        Ok(AgentCapabilities {
            protocol_version: result
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(ACP_PROTOCOL_VERSION)
                .to_string(),
            agent_info: result.get("agentInfo").cloned().unwrap_or_else(|| json!({})),
            prompt_capabilities: parse_prompt_capabilities(&result),
            session_capabilities: parse_session_capabilities(&result),
            raw: response,
        })
    }

    async fn list_sessions(
        &self,
        profile: &AgentProfile,
        cwd: Option<&str>,
    ) -> AdapterResult<Vec<ExternalSession>> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        let capabilities = process.initialize().await?;
        if !parse_session_capabilities(
            &capabilities.get("result").cloned().unwrap_or_else(|| json!({})),
        )
        .list
        {
            process.close().await?;
            return Ok(Vec::new());
        }
        let mut params = serde_json::Map::new();
        if let Some(cwd) = cwd {
            params.insert("cwd".to_string(), json!(cwd));
        }
        let response = process.request("session/list", Value::Object(params)).await?;
        process.close().await?;
        Ok(response
            .get("result")
            .and_then(|r| r.get("sessions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|session| ExternalSession {
                remote_session_id: session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: session
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                title: session.get("title").and_then(Value::as_str).map(ToOwned::to_owned),
                updated_at: session
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
            .collect())
    }

    async fn new_session(
        &self,
        profile: &AgentProfile,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<AgentSessionHandle> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities =
            parse_session_capabilities(&initialize_response.get("result").cloned().unwrap_or_else(|| json!({})));
        let response = process
            .request(
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": mcp_servers,
                }),
            )
            .await?;
        process.close().await?;
        let fallback_session_id = Uuid::new_v4().to_string();
        Ok(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: response
                .get("result")
                .and_then(|v| v.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or(&fallback_session_id)
                .to_string(),
            cwd: cwd.to_string(),
            load_supported: capabilities.load,
            prompt_capabilities: parse_prompt_capabilities(
                &initialize_response.get("result").cloned().unwrap_or_else(|| json!({})),
            ),
            config_options: parse_config_options(response.get("result")),
            models: parse_models(response.get("result")),
        })
    }

    async fn load_session(
        &self,
        profile: &AgentProfile,
        remote_session_id: &str,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<LoadedSession> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities =
            parse_session_capabilities(&initialize_response.get("result").cloned().unwrap_or_else(|| json!({})));
        if !capabilities.load {
            process.close().await?;
            return Err(AdapterError::Protocol("agent does not support session/load".to_string()));
        }
        let request_id = process.next_id();
        process
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/load",
                "params": {
                    "sessionId": remote_session_id,
                    "cwd": cwd,
                    "mcpServers": mcp_servers
                }
            }))
            .await?;
        let mut replay_events = Vec::new();
        let response_result = loop {
            let message = process.read_message().await?;
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method == "session/update" {
                    replay_events.extend(parse_session_update(&message, "history"));
                    continue;
                }
            }
            if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                break message.get("result").cloned();
            }
        };
        process.close().await?;
        Ok(LoadedSession {
            handle: AgentSessionHandle {
                adapter_kind: "acp".to_string(),
                remote_session_id: remote_session_id.to_string(),
                cwd: cwd.to_string(),
                load_supported: capabilities.load,
                prompt_capabilities: parse_prompt_capabilities(
                    &initialize_response.get("result").cloned().unwrap_or_else(|| json!({})),
                ),
                config_options: parse_config_options(response_result.as_ref()),
                models: parse_models(response_result.as_ref()),
            },
            replay_events,
        })
    }

    async fn prompt(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<Vec<RuntimeStreamEvent>> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        let initialize_response = process.initialize().await?;
        let capabilities = parse_agent_capabilities(&initialize_response);
        if handle.load_supported {
            process
                .request(
                    "session/load",
                    json!({
                        "sessionId": handle.remote_session_id,
                        "cwd": handle.cwd,
                        "mcpServers": []
                    }),
                )
                .await?;
        }
        let turn_id = Uuid::new_v4().to_string();
        let request_id = process.next_id();
        let prompt = build_prompt_blocks_from_message(input, attachments, &capabilities.prompt_capabilities).await?;
        process
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": handle.remote_session_id,
                    "prompt": prompt
                }
            }))
            .await?;

        let mut events = vec![RuntimeStreamEvent::StateChanged {
            status: "running".to_string(),
        }];
        for _ in 0..256 {
            match timeout(Duration::from_millis(250), process.read_message()).await {
                Ok(Ok(message)) => {
                    if let Some(method) = message.get("method").and_then(Value::as_str) {
                        if method == "session/update" {
                            events.extend(parse_session_update(&message, &turn_id));
                            continue;
                        }
                        if method == "session/request_permission" {
                            if let Some((permission_event, permission_id, _options)) =
                                parse_permission_request(&message, &turn_id)
                            {
                                events.push(permission_event);
                                process
                                    .write_message(json!({
                                        "jsonrpc": "2.0",
                                        "id": permission_id,
                                        "result": {
                                            "outcome": {
                                                "outcome": "cancelled"
                                            }
                                        }
                                    }))
                                    .await?;
                                events.push(RuntimeStreamEvent::Error {
                                    message: "permission request requires interactive client response; automatically cancelled in current backend mode".to_string(),
                                });
                                break;
                            }
                        }
                    }
                    if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                        if let Some(stop_reason) = message
                            .get("result")
                            .and_then(|r| r.get("stopReason"))
                            .and_then(Value::as_str)
                        {
                            events.push(RuntimeStreamEvent::StateChanged {
                                status: stop_reason.to_string(),
                            });
                        }
                        break;
                    }
                }
                Ok(Err(err)) => {
                    events.push(RuntimeStreamEvent::Error {
                        message: err.to_string(),
                    });
                    break;
                }
                Err(_) => break,
            }
        }
        events.push(RuntimeStreamEvent::TurnFinished { turn_id });
        process.close().await?;
        Ok(events)
    }

    async fn cancel(&self, profile: &AgentProfile, handle: &AgentSessionHandle) -> AdapterResult<()> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        process.initialize().await?;
        process
            .request(
                "session/cancel",
                json!({
                    "sessionId": handle.remote_session_id
                }),
            )
            .await?;
        process.close().await?;
        Ok(())
    }

    async fn set_config_option(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        config_id: &str,
        value: &Value,
    ) -> AdapterResult<Vec<SessionConfigOption>> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(&handle.cwd);
        process.initialize().await?;
        let response = process
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": handle.remote_session_id,
                    "configId": config_id,
                    "value": value
                }),
            )
            .await?;
        process.close().await?;
        Ok(parse_config_options(response.get("result")))
    }

    async fn close(&self, _profile: &AgentProfile, _handle: &AgentSessionHandle) -> AdapterResult<()> {
        Ok(())
    }
}

impl AcpLiveSession {
    pub async fn start_new(
        profile: &AgentProfile,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<Self> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities =
            parse_session_capabilities(&initialize_response.get("result").cloned().unwrap_or_else(|| json!({})));
        let response = process
            .request(
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": mcp_servers,
                }),
            )
            .await?;
        let fallback_session_id = Uuid::new_v4().to_string();
        let handle = AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: response
                .get("result")
                .and_then(|v| v.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or(&fallback_session_id)
                .to_string(),
            cwd: cwd.to_string(),
            load_supported: capabilities.load,
            prompt_capabilities: parse_prompt_capabilities(
                &initialize_response.get("result").cloned().unwrap_or_else(|| json!({})),
            ),
            config_options: parse_config_options(response.get("result")),
            models: parse_models(response.get("result")),
        };
        Ok(spawn_live_actor(process, handle))
    }

    pub async fn start_loaded(
        profile: &AgentProfile,
        remote_session_id: &str,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<(Self, Vec<RuntimeStreamEvent>)> {
        let mut process = JsonRpcProcess::spawn(profile).await?;
        process.set_session_cwd(cwd);
        let initialize_response = process.initialize().await?;
        let capabilities =
            parse_session_capabilities(&initialize_response.get("result").cloned().unwrap_or_else(|| json!({})));
        if !capabilities.load {
            process.close().await?;
            return Err(AdapterError::Protocol("agent does not support session/load".to_string()));
        }
        let request_id = process.next_id();
        process
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/load",
                "params": {
                    "sessionId": remote_session_id,
                    "cwd": cwd,
                    "mcpServers": mcp_servers
                }
            }))
            .await?;
        let mut replay_events = Vec::new();
        let response_result = loop {
            let message = process.read_message().await?;
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if method == "session/update" {
                    replay_events.extend(parse_session_update(&message, "history"));
                    continue;
                }
                process.handle_client_request(&message).await?;
                continue;
            }
            if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                break message.get("result").cloned();
            }
        };
        let handle = AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: remote_session_id.to_string(),
            cwd: cwd.to_string(),
            load_supported: capabilities.load,
            prompt_capabilities: parse_prompt_capabilities(
                &initialize_response.get("result").cloned().unwrap_or_else(|| json!({})),
            ),
            config_options: parse_config_options(response_result.as_ref()),
            models: parse_models(response_result.as_ref()),
        };
        Ok((spawn_live_actor(process, handle), replay_events))
    }

    pub async fn run_turn(
        &self,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<(mpsc::UnboundedReceiver<RuntimeStreamEvent>, oneshot::Receiver<AdapterResult<()>>)> {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (completion_tx, completion_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::RunTurn {
                prompt: build_prompt_blocks_from_message(
                    input,
                    attachments,
                    &self.handle.prompt_capabilities,
                )
                .await?,
                event_tx,
                completion_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        Ok((event_rx, completion_rx))
    }

    pub async fn resolve_permission(
        &self,
        tool_call_id: &str,
        decision: PermissionDecisionKind,
    ) -> AdapterResult<()> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::ResolvePermission {
                tool_call_id: tool_call_id.to_string(),
                decision,
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("permission response dropped".to_string()))?
    }

    pub async fn cancel(&self) -> AdapterResult<()> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::Cancel { resp: resp_tx })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("cancel response dropped".to_string()))?
    }

    pub async fn set_config_option(&self, config_id: &str, value: &Value) -> AdapterResult<Vec<SessionConfigOption>> {
        let (resp_tx, resp_rx) = oneshot::channel();
        self.command_tx
            .send(LiveSessionCommand::SetConfig {
                config_id: config_id.to_string(),
                value: value.clone(),
                resp: resp_tx,
            })
            .map_err(|_| AdapterError::Protocol("live ACP session stopped".to_string()))?;
        resp_rx
            .await
            .map_err(|_| AdapterError::Protocol("set config response dropped".to_string()))?
    }

    pub fn close(&self) {
        let _ = self.command_tx.send(LiveSessionCommand::Close);
    }
}

fn spawn_live_actor(process: JsonRpcProcess, handle: AgentSessionHandle) -> AcpLiveSession {
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    let live_handle = handle.clone();
    tokio::spawn(async move {
        let mut process = process;
        while let Some(command) = command_rx.recv().await {
            match command {
                LiveSessionCommand::RunTurn {
                    prompt,
                    event_tx,
                    completion_tx,
                } => {
                    let result = run_turn_loop(&mut process, &live_handle, prompt, &event_tx, &mut command_rx).await;
                    let _ = completion_tx.send(result);
                }
                LiveSessionCommand::ResolvePermission { resp, .. } => {
                    let _ = resp.send(Err(AdapterError::Protocol(
                        "no prompt turn is currently awaiting permission".to_string(),
                    )));
                }
                LiveSessionCommand::Cancel { resp } => {
                    let result = process
                        .write_message(json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": {
                                "sessionId": live_handle.remote_session_id
                            }
                        }))
                        .await;
                    let _ = resp.send(result);
                }
                LiveSessionCommand::SetConfig {
                    config_id,
                    value,
                    resp,
                } => {
                        let result = process
                            .request(
                                "session/set_config_option",
                                json!({
                                    "sessionId": live_handle.remote_session_id,
                                    "configId": config_id,
                                    "value": value
                                }),
                            )
                            .await
                            .map(|response| parse_config_options(response.get("result")));
                        let _ = resp.send(result);
                    }
                LiveSessionCommand::Close => {
                    let _ = process.close().await;
                    break;
                }
            }
        }
    });
    AcpLiveSession { command_tx, handle }
}

async fn run_turn_loop(
    process: &mut JsonRpcProcess,
    handle: &AgentSessionHandle,
    prompt: Vec<Value>,
    event_tx: &mpsc::UnboundedSender<RuntimeStreamEvent>,
    command_rx: &mut mpsc::UnboundedReceiver<LiveSessionCommand>,
) -> AdapterResult<()> {
    let turn_id = Uuid::new_v4().to_string();
    process.bind_turn(&turn_id, event_tx);
    let request_id = process.next_id();
    process
        .write_message(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/prompt",
            "params": {
                "sessionId": handle.remote_session_id,
                "prompt": prompt
            }
        }))
        .await?;
    let _ = event_tx.send(RuntimeStreamEvent::StateChanged {
        status: "running".to_string(),
    });
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();

    loop {
        tokio::select! {
            maybe_command = command_rx.recv() => {
                match maybe_command {
                    Some(LiveSessionCommand::ResolvePermission { tool_call_id, decision, resp }) => {
                        let result = if let Some(pending) = pending_permissions.remove(&tool_call_id) {
                            send_permission_decision(process, pending.request_id, &pending.options, decision).await
                        } else {
                            Err(AdapterError::Protocol("tool call is not waiting for permission".to_string()))
                        };
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::Cancel { resp }) => {
                        for (_, pending) in pending_permissions.drain() {
                            let _ = send_cancelled_permission(process, pending.request_id).await;
                        }
                        let result = process.write_message(json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": {
                                "sessionId": handle.remote_session_id
                            }
                        })).await;
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::SetConfig { config_id, value, resp }) => {
                        let result = process
                            .request(
                                "session/set_config_option",
                                json!({
                                    "sessionId": handle.remote_session_id,
                                    "configId": config_id,
                                    "value": value
                                }),
                            )
                            .await
                            .map(|response| parse_config_options(response.get("result")));
                        let _ = resp.send(result);
                    }
                    Some(LiveSessionCommand::RunTurn { completion_tx, .. }) => {
                        let _ = completion_tx.send(Err(AdapterError::Protocol("a prompt turn is already running".to_string())));
                    }
                    Some(LiveSessionCommand::Close) => {
                        let _ = process.close().await;
                        return Ok(());
                    }
                    None => return Ok(()),
                }
            }
            message = process.read_message() => {
                let message = message?;
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    match method {
                        "session/update" => {
                            for event in parse_session_update(&message, &turn_id) {
                                let _ = event_tx.send(event);
                            }
                        }
                        "session/request_permission" => {
                            if let Some((event, permission_id, options)) = parse_permission_request(&message, &turn_id) {
                                if let RuntimeStreamEvent::PermissionRequest { tool_call_id, .. } = &event {
                                    pending_permissions.insert(
                                        tool_call_id.clone(),
                                        PendingPermission {
                                            request_id: permission_id,
                                            options,
                                        },
                                    );
                                }
                                let _ = event_tx.send(event);
                            }
                        }
                        _ => {
                            process.handle_client_request(&message).await?;
                        }
                    }
                    continue;
                }
                if message.get("id").and_then(Value::as_i64) == Some(request_id) {
                    if let Some(stop_reason) = message
                        .get("result")
                        .and_then(|r| r.get("stopReason"))
                        .and_then(Value::as_str)
                    {
                        let _ = event_tx.send(RuntimeStreamEvent::StateChanged {
                            status: stop_reason.to_string(),
                        });
                    }
                    let _ = event_tx.send(RuntimeStreamEvent::TurnFinished { turn_id });
                    process.clear_turn();
                    return Ok(());
                }
            }
        }
    }
}

struct JsonRpcProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    session_cwd: PathBuf,
    current_turn_id: Option<String>,
    current_event_tx: Option<mpsc::UnboundedSender<RuntimeStreamEvent>>,
    terminals: Arc<Mutex<BTreeMap<String, TerminalHandle>>>,
}

impl JsonRpcProcess {
    async fn spawn(profile: &AgentProfile) -> AdapterResult<Self> {
        let mut command = Command::new(&profile.command);
        command.args(&profile.args);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let envs: BTreeMap<String, String> = profile
            .env
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|value| (k.clone(), value.to_string())))
            .collect();
        command.envs(envs);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Protocol("child stdin unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Protocol("child stdout unavailable".to_string()))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            session_cwd: PathBuf::from("."),
            current_turn_id: None,
            current_event_tx: None,
            terminals: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    fn set_session_cwd(&mut self, cwd: &str) {
        self.session_cwd = PathBuf::from(cwd);
    }

    fn bind_turn(&mut self, turn_id: &str, event_tx: &mpsc::UnboundedSender<RuntimeStreamEvent>) {
        self.current_turn_id = Some(turn_id.to_string());
        self.current_event_tx = Some(event_tx.clone());
    }

    fn clear_turn(&mut self) {
        self.current_turn_id = None;
        self.current_event_tx = None;
    }

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

    async fn initialize(&mut self) -> AdapterResult<Value> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {
                        "readTextFile": true,
                        "writeTextFile": true
                    },
                    "terminal": true
                },
                "clientInfo": {
                    "name": "oneagent",
                    "title": "OneAgent Desktop",
                    "version": "0.1.0"
                }
            }),
        )
        .await
    }

    fn next_id(&mut self) -> i64 {
        let current = self.next_id;
        self.next_id += 1;
        current
    }

    async fn request(&mut self, method: &str, params: Value) -> AdapterResult<Value> {
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
                return Ok(response);
            }
        }
    }

    async fn write_message(&mut self, message: Value) -> AdapterResult<()> {
        let line = serde_json::to_string(&message)?;
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_message(&mut self) -> AdapterResult<Value> {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        if line.trim().is_empty() {
            return Err(AdapterError::Protocol("empty response from agent".to_string()));
        }
        Ok(serde_json::from_str(line.trim())?)
    }

    async fn close(&mut self) -> AdapterResult<()> {
        let _ = self.child.kill().await;
        Ok(())
    }

    async fn handle_client_request(&mut self, message: &Value) -> AdapterResult<()> {
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

    async fn handle_fs_read(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let path = message
            .get("params")
            .and_then(|v| v.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("fs/read_text_file missing path".to_string()))?;
        let resolved = self.resolve_workspace_path(path)?;
        let raw = tokio::fs::read_to_string(&resolved).await?;
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
        let params = message
            .get("params")
            .ok_or_else(|| AdapterError::Protocol("fs/write_text_file missing params".to_string()))?;
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("fs/write_text_file missing path".to_string()))?;
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("fs/write_text_file missing content".to_string()))?;
        let resolved = self.resolve_workspace_path(path)?;
        if let Some(parent) = resolved.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&resolved, content).await?;
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }))
        .await
    }

    async fn handle_terminal_create(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let params = message
            .get("params")
            .ok_or_else(|| AdapterError::Protocol("terminal/create missing params".to_string()))?;
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("terminal/create missing command".to_string()))?;
        let args: Vec<String> = params
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(ToOwned::to_owned))
            .collect();
        let cwd = params.get("cwd").and_then(Value::as_str);
        if let Some(cwd) = cwd {
            self.resolve_workspace_path(cwd)?;
        }
        let terminal_id = Uuid::new_v4().to_string();
        let mut child = Command::new(command);
        child.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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

    async fn handle_terminal_read(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let terminal_id = message
            .get("params")
            .and_then(|v| v.get("terminalId"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("terminal/read missing terminalId".to_string()))?;
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
        let terminal_id = message
            .get("params")
            .and_then(|v| v.get("terminalId"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("terminal/wait_for_exit missing terminalId".to_string()))?;
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
                "exitCode": status.code()
            }
        }))
        .await
    }

    async fn handle_terminal_kill(&mut self, message: &Value) -> AdapterResult<()> {
        let id = message_id(message)?;
        let terminal_id = message
            .get("params")
            .and_then(|v| v.get("terminalId"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("terminal/kill missing terminalId".to_string()))?;
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
        let terminal_id = message
            .get("params")
            .and_then(|v| v.get("terminalId"))
            .and_then(Value::as_str)
            .ok_or_else(|| AdapterError::Protocol("terminal/release missing terminalId".to_string()))?;
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
        let normalized = normalize_path(&candidate);
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
}

#[derive(Clone)]
struct TerminalHandle {
    child: Arc<Mutex<Child>>,
    cwd: Option<String>,
    command: String,
    args: Vec<String>,
    stdout: Option<Arc<Mutex<BufReader<tokio::process::ChildStdout>>>>,
    stderr: Option<Arc<Mutex<BufReader<tokio::process::ChildStderr>>>>,
}

fn message_id(message: &Value) -> AdapterResult<i64> {
    message
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| AdapterError::Protocol("message missing id".to_string()))
}

async fn read_available<R>(reader: Option<Arc<Mutex<BufReader<R>>>>) -> AdapterResult<String>
where
    R: AsyncRead + Unpin,
{
    let Some(reader) = reader else {
        return Ok(String::new());
    };
    let mut reader = reader.lock().await;
    let mut buf = [0_u8; 4096];
    let read = match timeout(Duration::from_millis(20), reader.read(&mut buf)).await {
        Ok(Ok(size)) => size,
        Ok(Err(err)) => return Err(AdapterError::Io(err)),
        Err(_) => 0,
    };
    Ok(String::from_utf8_lossy(&buf[..read]).to_string())
}

fn normalize_path(path: &Path) -> PathBuf {
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

async fn build_prompt_blocks_from_message(
    input: &str,
    attachments: &[AttachmentInput],
    capabilities: &AgentPromptCapabilities,
) -> AdapterResult<Vec<Value>> {
    let mut prompt = vec![json!({
        "type": "text",
        "text": input
    })];
    for attachment in attachments {
        prompt.push(build_attachment_block(attachment, capabilities).await?);
    }
    Ok(prompt)
}

async fn build_attachment_block(
    attachment: &AttachmentInput,
    capabilities: &AgentPromptCapabilities,
) -> AdapterResult<Value> {
    let path = PathBuf::from(&attachment.path);
    let metadata = tokio::fs::metadata(&path).await?;
    let inferred_mime = attachment
        .mime_type
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            mime_guess::from_path(&path)
                .first_raw()
                .unwrap_or("application/octet-stream")
                .to_string()
        });
    let uri = format!("file://{}", path.display());

    if capabilities.resource_link && matches!(attachment.delivery_preference, AttachmentDeliveryPreference::ResourceLink) {
        return Ok(resource_link_block(&attachment.name, &uri, &inferred_mime));
    }

    match attachment.kind {
        AttachmentKind::Image if capabilities.image => {
            if metadata.len() <= MAX_EMBEDDED_IMAGE_BYTES
                && !matches!(attachment.delivery_preference, AttachmentDeliveryPreference::ResourceLink)
            {
                let bytes = tokio::fs::read(&path).await?;
                return Ok(json!({
                    "type": "image",
                    "mimeType": inferred_mime,
                    "data": BASE64_STANDARD.encode(bytes),
                    "uri": uri
                }));
            }
        }
        AttachmentKind::Audio if capabilities.audio => {
            if metadata.len() <= MAX_EMBEDDED_AUDIO_BYTES
                && !matches!(attachment.delivery_preference, AttachmentDeliveryPreference::ResourceLink)
            {
                let bytes = tokio::fs::read(&path).await?;
                return Ok(json!({
                    "type": "audio",
                    "mimeType": inferred_mime,
                    "data": BASE64_STANDARD.encode(bytes),
                    "uri": uri
                }));
            }
        }
        AttachmentKind::File if capabilities.embedded_context => {
            if metadata.len() <= MAX_EMBEDDED_TEXT_BYTES
                && !matches!(attachment.delivery_preference, AttachmentDeliveryPreference::ResourceLink)
                && is_text_like_mime(&inferred_mime)
            {
                let text = tokio::fs::read_to_string(&path).await?;
                return Ok(json!({
                    "type": "resource",
                    "resource": {
                        "uri": uri,
                        "mimeType": inferred_mime,
                        "text": text
                    }
                }));
            }
        }
        _ => {}
    }

    if capabilities.resource_link {
        return Ok(resource_link_block(&attachment.name, &uri, &inferred_mime));
    }

    Err(AdapterError::Protocol(format!(
        "agent does not support a compatible delivery mode for attachment {}",
        attachment.name
    )))
}

fn resource_link_block(name: &str, uri: &str, mime_type: &str) -> Value {
    json!({
        "type": "resource_link",
        "resourceLink": {
            "name": name,
            "uri": uri,
            "mimeType": mime_type
        }
    })
}

fn is_text_like_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/x-javascript"
                | "application/typescript"
                | "application/x-sh"
                | "application/yaml"
                | "application/x-yaml"
        )
}

fn parse_agent_capabilities(response: &Value) -> AgentCapabilities {
    let result = response.get("result").cloned().unwrap_or_else(|| json!({}));
    AgentCapabilities {
        protocol_version: result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(ACP_PROTOCOL_VERSION)
            .to_string(),
        agent_info: result.get("agentInfo").cloned().unwrap_or_else(|| json!({})),
        prompt_capabilities: parse_prompt_capabilities(&result),
        session_capabilities: parse_session_capabilities(&result),
        raw: response.clone(),
    }
}

fn parse_prompt_capabilities(result: &Value) -> AgentPromptCapabilities {
    let prompt_capabilities = result
        .get("agentCapabilities")
        .and_then(|value| value.get("promptCapabilities"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    AgentPromptCapabilities {
        text: prompt_capabilities
            .get("text")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        resource_link: prompt_capabilities
            .get("resourceLink")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        embedded_context: prompt_capabilities
            .get("embeddedContext")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        image: prompt_capabilities
            .get("image")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        audio: prompt_capabilities
            .get("audio")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_session_capabilities(result: &Value) -> AgentSessionCapabilities {
    let session_capabilities = result
        .get("agentCapabilities")
        .and_then(|value| value.get("sessionCapabilities"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    AgentSessionCapabilities {
        load: session_capabilities
            .get("load")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        list: session_capabilities
            .get("list")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn parse_config_options(result: Option<&Value>) -> Vec<SessionConfigOption> {
    result
        .and_then(|value| value.get("configOptions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| SessionConfigOption {
                    id: item.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("label").and_then(Value::as_str))
                        .or_else(|| item.get("title").and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_string(),
                    description: item.get("description").and_then(Value::as_str).map(ToOwned::to_owned),
                    category: item.get("category").and_then(Value::as_str).map(ToOwned::to_owned),
                    option_type: item
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("string")
                        .to_string(),
                    current_value: item
                        .get("currentValue")
                        .cloned()
                        .or_else(|| item.get("selectedValue").cloned())
                        .or_else(|| item.get("value").cloned())
                        .unwrap_or(Value::Null),
                    options: item
                        .get("options")
                        .cloned()
                        .or_else(|| item.get("enum").cloned())
                        .unwrap_or_else(|| json!([])),
                    raw: item.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse models from session/new or session/load response (unstable API)
fn parse_models(result: Option<&Value>) -> Option<AcpSessionModels> {
    result.and_then(|value| {
        // Check top-level models first
        let models = value.get("models");
        // Also check _meta.models (used by some agents like iFlow)
        let meta_models = value
            .get("_meta")
            .and_then(|m| m.get("models"));

        let models_source = models.or(meta_models)?;
        if models_source.is_null() {
            return None;
        }

        Some(AcpSessionModels {
            current_model_id: models_source
                .get("currentModelId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            available_models: models_source
                .get("availableModels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|item| AcpAvailableModel {
                            id: item.get("id").and_then(Value::as_str).map(ToOwned::to_owned),
                            model_id: item.get("modelId").and_then(Value::as_str).map(ToOwned::to_owned),
                            name: item.get("name").and_then(Value::as_str).map(ToOwned::to_owned),
                        })
                        .collect()
                }),
        })
    })
}

fn parse_session_update(message: &Value, turn_id: &str) -> Vec<RuntimeStreamEvent> {
    let mut events = Vec::new();
    let Some(update) = message.get("params").and_then(|p| p.get("update")) else {
        return events;
    };
    let update_kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match update_kind {
        "user_message_chunk" | "agent_message_chunk" => {
            if let Some(text) = update
                .get("content")
                .and_then(|v| v.get("text"))
                .and_then(Value::as_str)
            {
                let role = if update_kind == "agent_message_chunk" {
                    "agent"
                } else {
                    "user"
                };
                let (thinking, stripped) = extract_and_strip_think_tags(text);
                if !thinking.is_empty() {
                    events.push(RuntimeStreamEvent::ThinkingChunk {
                        turn_id: turn_id.to_string(),
                        content: thinking,
                    });
                }
                if !stripped.is_empty() {
                    events.push(RuntimeStreamEvent::MessageChunk {
                        turn_id: turn_id.to_string(),
                        role: role.to_string(),
                        content: stripped,
                    });
                }
            }
        }
        "agent_thought_chunk" | "thought" | "thinking" => {
            let content = update
                .get("content")
                .and_then(|v| v.get("text"))
                .and_then(Value::as_str)
                .or_else(|| update.get("description").and_then(Value::as_str))
                .or_else(|| update.get("subject").and_then(Value::as_str))
                .unwrap_or_default()
                .trim()
                .to_string();
            if !content.is_empty() {
                events.push(RuntimeStreamEvent::ThinkingChunk {
                    turn_id: turn_id.to_string(),
                    content,
                });
            }
        }
        "plan" => {
            events.push(RuntimeStreamEvent::Plan {
                turn_id: turn_id.to_string(),
                entries: update.get("entries").cloned().unwrap_or_else(|| json!([])),
            });
        }
        "tool_call" | "tool_call_update" => {
            let content = extract_content(update.get("content"));
            let terminal_refs = content
                .get("terminal_ids")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let raw_output = content
                .get("text")
                .cloned()
                .unwrap_or_else(|| json!({ "text": "" }));
            events.push(RuntimeStreamEvent::ToolCall {
                turn_id: turn_id.to_string(),
                tool_call_id: update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                title: update
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                kind: update
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("other")
                    .to_string(),
                status: normalize_tool_status(
                    update
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending"),
                ),
                raw_input: update.get("input").cloned().unwrap_or_else(|| json!({})),
                raw_output,
                content: content
                    .get("content")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                diffs: content
                    .get("diffs")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                terminal_ids: terminal_refs.clone(),
                locations: json!({
                    "terminals": terminal_refs,
                    "paths": extract_paths(update.get("content"))
                }),
            });
        }
        _ => {}
    }
    events
}

fn extract_and_strip_think_tags(content: &str) -> (String, String) {
    if !content.contains("<think") && !content.contains("</think") {
        return (String::new(), content.to_string());
    }

    let mut remaining = content.to_string();
    let mut thinking_parts = Vec::new();

    for (open_tag, close_tag) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        while let Some(start) = remaining.find(open_tag) {
            let after_open = start + open_tag.len();
            if let Some(rel_end) = remaining[after_open..].find(close_tag) {
                let end = after_open + rel_end;
                let part = remaining[after_open..end].trim();
                if !part.is_empty() {
                    thinking_parts.push(part.to_string());
                }
                remaining.replace_range(start..end + close_tag.len(), "");
            } else {
                let part = remaining[after_open..].trim();
                if !part.is_empty() {
                    thinking_parts.push(part.to_string());
                }
                remaining.replace_range(start.., "");
                break;
            }
        }
    }

    if thinking_parts.is_empty() {
        let orphan_end = remaining
            .find("</think>")
            .or_else(|| remaining.find("</thinking>"));
        if let Some(end) = orphan_end {
            let part = remaining[..end].trim();
            if !part.is_empty() {
                thinking_parts.push(part.to_string());
            }
            let close_len = if remaining[end..].starts_with("</thinking>") {
                "</thinking>".len()
            } else {
                "</think>".len()
            };
            remaining.replace_range(..end + close_len, "");
        }
    }

    let stripped = remaining
        .replace("<think>", "")
        .replace("</think>", "")
        .replace("<thinking>", "")
        .replace("</thinking>", "")
        .trim()
        .to_string();

    (thinking_parts.join("\n\n"), stripped)
}

fn parse_permission_request(
    message: &Value,
    turn_id: &str,
) -> Option<(RuntimeStreamEvent, i64, Vec<PermissionOption>)> {
    let permission_id = message.get("id")?.as_i64()?;
    let params = message.get("params")?;
    let tool_call = params.get("toolCall")?;
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(PermissionOption {
                        option_id: item.get("optionId")?.as_str()?.to_string(),
                        kind: item.get("kind")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((
        RuntimeStreamEvent::PermissionRequest {
            turn_id: turn_id.to_string(),
            tool_call_id: tool_call
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            tool_kind: tool_call
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("other")
                .to_string(),
            title: tool_call
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            raw_input: tool_call.get("input").cloned().unwrap_or_else(|| json!({})),
            paths: extract_paths(tool_call.get("content")),
            options: params.get("options").cloned().unwrap_or_else(|| json!([])),
        },
        permission_id,
        options,
    ))
}

fn extract_content(content: Option<&Value>) -> Value {
    let Some(items) = content.and_then(Value::as_array) else {
        return json!({
            "text": { "text": "" },
            "content": [],
            "diffs": [],
            "terminal_ids": []
        });
    };
    let texts: Vec<String> = items
        .iter()
        .filter_map(|item| {
            item.get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect();
    let diffs: Vec<Value> = items
        .iter()
        .filter_map(|item| item.get("diff").cloned())
        .collect();
    let terminal_ids: Vec<String> = items
        .iter()
        .filter_map(|item| item.get("terminalId").and_then(Value::as_str).map(ToOwned::to_owned))
        .collect();
    json!({
        "text": { "text": texts.join("\n") },
        "content": items,
        "diffs": diffs,
        "terminal_ids": terminal_ids
    })
}

fn extract_paths(content: Option<&Value>) -> Vec<String> {
    content
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("content")
                        .and_then(|content| content.get("uri"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_tool_status(status: &str) -> String {
    match status {
        "pending" => "declared",
        "in_progress" => "running",
        other => other,
    }
    .to_string()
}

async fn send_permission_decision(
    process: &mut JsonRpcProcess,
    request_id: i64,
    options: &[PermissionOption],
    decision: PermissionDecisionKind,
) -> AdapterResult<()> {
    let outcome = match decision {
        PermissionDecisionKind::Cancelled => json!({ "outcome": "cancelled" }),
        PermissionDecisionKind::AllowOnce => selected_option(options, "allow_once")?,
        PermissionDecisionKind::AllowAlways => selected_option(options, "allow_always")?,
        PermissionDecisionKind::RejectOnce => selected_option(options, "reject_once")?,
        PermissionDecisionKind::RejectAlways => selected_option(options, "reject_always")?,
    };
    process
        .write_message(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": outcome
            }
        }))
        .await
}

async fn send_cancelled_permission(process: &mut JsonRpcProcess, request_id: i64) -> AdapterResult<()> {
    process
        .write_message(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": {
                    "outcome": "cancelled"
                }
            }
        }))
        .await
}

fn selected_option(options: &[PermissionOption], kind: &str) -> AdapterResult<Value> {
    let option = options
        .iter()
        .find(|option| option.kind == kind)
        .ok_or_else(|| AdapterError::Protocol(format!("permission option {kind} not offered by agent")))?;
    Ok(json!({
        "outcome": "selected",
        "optionId": option.option_id
    }))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{extract_content, normalize_path, normalize_tool_status, parse_permission_request, parse_session_update};
    use crate::agent_adapters::RuntimeStreamEvent;
    use serde_json::json;

    #[test]
    fn parses_plan_and_tool_updates() {
        let plan_message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [{"content":"A","status":"pending"}]
                }
            }
        });
        let tool_message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "title": "Run tests",
                    "kind": "execute",
                    "status": "in_progress",
                    "content": [{"terminalId":"term_1"}]
                }
            }
        });
        assert_eq!(parse_session_update(&plan_message, "turn").len(), 1);
        assert_eq!(parse_session_update(&tool_message, "turn").len(), 1);
        assert_eq!(normalize_tool_status("in_progress"), "running");
    }

    #[test]
    fn parses_permission_request() {
        let message = json!({
            "id": 5,
            "params": {
                "toolCall": {
                    "toolCallId": "call_1",
                    "title": "Write file",
                    "kind": "edit",
                    "content": [{
                        "content": {"uri": "file:///tmp/demo.txt"}
                    }]
                }
            }
        });
        let parsed = parse_permission_request(&message, "turn");
        assert!(parsed.is_some());
    }

    #[test]
    fn extracts_diff_and_terminal_content() {
        let content = extract_content(Some(&json!([
            {"terminalId":"term_1"},
            {"content":{"text":"hello"}},
            {"diff":{"path":"src/lib.rs","patch":"@@ ..."}}
        ])));
        assert_eq!(content["terminal_ids"], json!(["term_1"]));
        assert_eq!(content["diffs"][0]["path"], "src/lib.rs");
        assert_eq!(content["text"]["text"], "hello");
    }

    #[test]
    fn splits_inline_think_tags_from_agent_text() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "<think>reasoning</think>final answer" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 2);
        match &events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => assert_eq!(content, "reasoning"),
            other => panic!("expected thinking chunk, got {other:?}"),
        }
        match &events[1] {
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                assert_eq!(role, "agent");
                assert_eq!(content, "final answer");
            }
            other => panic!("expected agent text chunk, got {other:?}"),
        }
    }

    #[test]
    fn parses_agent_thought_chunk_updates() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "reasoning chunk" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => assert_eq!(content, "reasoning chunk"),
            other => panic!("expected thinking chunk, got {other:?}"),
        }
    }

    #[test]
    fn extracts_open_ended_think_chunks() {
        let (thinking, stripped) = extract_and_strip_think_tags("<think>reasoning in progress");
        assert_eq!(thinking, "reasoning in progress");
        assert_eq!(stripped, "");
    }

    #[test]
    fn extracts_orphan_closing_think_chunks() {
        let (thinking, stripped) = extract_and_strip_think_tags("continued reasoning</think>final answer");
        assert_eq!(thinking, "continued reasoning");
        assert_eq!(stripped, "final answer");
    }

    #[test]
    fn normalizes_relative_paths() {
        let normalized = normalize_path(Path::new("/tmp/workspace/../workspace/file.txt"));
        assert_eq!(normalized, Path::new("/tmp/workspace/file.txt"));
    }
}
