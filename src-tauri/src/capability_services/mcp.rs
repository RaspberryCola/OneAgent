use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::RwLock;
use serde_json::json;

use crate::{
    domain::{
        McpConnectionStatus, McpServerConfig, McpServerStatus, McpToolInfo, McpTransportType,
    },
    storage::Database,
};

/// Event emitter function type for broadcasting MCP status changes.
type McpEventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// A provider that can dynamically supply an MCP server config.
/// Used for built-in servers that are not stored in the database
/// (e.g., browser MCP, future built-in tools).
type BuiltinProvider = Arc<dyn Fn() -> Option<McpServerConfig> + Send + Sync>;

#[derive(Clone)]
pub struct McpRegistry {
    db: Database,
    statuses: Arc<RwLock<HashMap<String, McpServerStatus>>>,
    event_emitter: Option<McpEventEmitter>,
    builtin_providers: Arc<RwLock<Vec<BuiltinProvider>>>,
}

impl McpRegistry {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            statuses: Arc::new(RwLock::new(HashMap::new())),
            event_emitter: None,
            builtin_providers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Attach an event emitter for broadcasting status changes.
    pub fn attach_emitter(&mut self, emitter: McpEventEmitter) {
        self.event_emitter = Some(emitter);
    }

    /// Register a builtin MCP provider. The provider closure is called each time
    /// MCP servers are resolved, and its result (if `Some`) is injected into the
    /// server list unless a server with the same `id` already exists.
    pub fn add_builtin_provider(&self, provider: BuiltinProvider) {
        self.builtin_providers.write().push(provider);
    }

    /// Resolve all MCP servers for a workspace: user-configured from DB +
    /// dynamically provided by builtin providers. Only enabled servers are returned.
    pub fn resolve_all(&self, workspace_id: &str) -> crate::storage::StorageResult<Vec<McpServerConfig>> {
        let mut servers: Vec<McpServerConfig> = self
            .db
            .list_workspace_mcp(workspace_id)?
            .into_iter()
            .filter(|s| s.enabled)
            .collect();

        // Inject builtin provider results
        for provider in self.builtin_providers.read().iter() {
            if let Some(builtin) = provider() {
                if !servers.iter().any(|s| s.id == builtin.id) {
                    servers.push(builtin);
                }
            }
        }

        Ok(servers)
    }

    pub fn list_for_workspace(
        &self,
        workspace_id: &str,
    ) -> crate::storage::StorageResult<Vec<McpServerConfig>> {
        self.db.list_workspace_mcp(workspace_id)
    }

    pub fn upsert(
        &self,
        config: McpServerConfig,
    ) -> crate::storage::StorageResult<McpServerConfig> {
        self.db.upsert_workspace_mcp(&config)?;
        Ok(config)
    }

    /// Update the status of an MCP server and emit a `mcp:status_changed` event.
    pub fn update_status(&self, workspace_id: &str, status: McpServerStatus) {
        self.statuses
            .write()
            .insert(status.config_id.clone(), status.clone());
        if let Some(ref emitter) = self.event_emitter {
            let payload = json!({
                "workspace_id": workspace_id,
                "status": status,
            });
            emitter("mcp:status_changed", payload);
        }
    }

    /// Get the cached status of an MCP server.
    pub fn get_status(&self, config_id: &str) -> Option<McpServerStatus> {
        self.statuses.read().get(config_id).cloned()
    }

    /// Get all cached MCP server statuses.
    pub fn get_all_statuses(&self) -> Vec<McpServerStatus> {
        self.statuses.read().values().cloned().collect()
    }

    /// Test connection to an MCP server and discover its tools.
    ///
    /// Performs a full MCP protocol handshake (initialize → tools/list)
    /// to discover available tools.
    pub async fn test_connection(&self, config: &McpServerConfig) -> McpServerStatus {
        let result = match config.transport_type {
            McpTransportType::Stdio => discover_tools_stdio(config).await,
            McpTransportType::Sse | McpTransportType::Http => {
                discover_tools_http(config).await
            }
        };

        match result {
            Ok(tools) => McpServerStatus {
                config_id: config.id.clone(),
                name: config.name.clone(),
                status: McpConnectionStatus::Connected,
                tools,
                error_message: None,
                last_updated: Utc::now(),
            },
            Err(e) => McpServerStatus {
                config_id: config.id.clone(),
                name: config.name.clone(),
                status: McpConnectionStatus::Error,
                tools: vec![],
                error_message: Some(e),
                last_updated: Utc::now(),
            },
        }
    }
}

/// Parse MCP server configurations from a JSON string.
///
/// Supports two formats:
/// 1. Claude Desktop format: `{ "mcpServers": { "name": { command, args, env } } }`
/// 2. Array format: `[{ name, type, command, args, url, headers, env }]`
pub fn parse_mcp_config_json(
    json_str: &str,
    workspace_id: &str,
) -> Result<Vec<McpServerConfig>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid JSON: {e}"))?;

    // Try Claude Desktop format first: { "mcpServers": { "name": { ... } } }
    if let Some(servers) = value.get("mcpServers").and_then(|v| v.as_object()) {
        return parse_claude_desktop_format(servers, workspace_id);
    }

    // Try array format: [{ ... }]
    if let Some(arr) = value.as_array() {
        return parse_array_format(arr, workspace_id);
    }

    Err("Unrecognized MCP config format. Expected { mcpServers: {...} } or [...]".to_string())
}

fn parse_claude_desktop_format(
    servers: &serde_json::Map<String, serde_json::Value>,
    workspace_id: &str,
) -> Result<Vec<McpServerConfig>, String> {
    let mut configs = Vec::new();
    for (name, server_value) in servers {
        let command = server_value
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = server_value
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env = server_value
            .get("env")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let url = server_value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let (transport_type, final_command, final_args, final_url) = if !url.is_empty() {
            let transport = if server_value
                .get("type")
                .and_then(|v| v.as_str())
                == Some("sse")
            {
                McpTransportType::Sse
            } else {
                McpTransportType::Http
            };
            (transport, String::new(), vec![], url)
        } else {
            (McpTransportType::Stdio, command, args, String::new())
        };

        configs.push(McpServerConfig {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            name: name.clone(),
            transport_type,
            command: final_command,
            args: final_args,
            url: final_url,
            env,
            headers: serde_json::json!({}),
            enabled: true,
            builtin: false,
        });
    }
    Ok(configs)
}

fn parse_array_format(
    arr: &[serde_json::Value],
    workspace_id: &str,
) -> Result<Vec<McpServerConfig>, String> {
    let mut configs = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed")
            .to_string();
        let transport_str = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let transport_type = match transport_str {
            "sse" => McpTransportType::Sse,
            "http" => McpTransportType::Http,
            _ => McpTransportType::Stdio,
        };
        let command = item
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = item
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let url = item
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let env = item
            .get("env")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let headers = item
            .get("headers")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        configs.push(McpServerConfig {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            name,
            transport_type,
            command,
            args,
            url,
            env,
            headers,
            enabled: true,
            builtin: false,
        });
    }
    Ok(configs)
}

/// Discover tools from a stdio MCP server by spawning it and running the MCP handshake.
async fn discover_tools_stdio(config: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
    use tokio::process::Command;

    if config.command.is_empty() {
        return Err("Command is empty".to_string());
    }

    // Build env
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    if let serde_json::Value::Object(env_map) = &config.env {
        for (k, v) in env_map {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {e}", config.command))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        run_mcp_handshake(stdin, stdout),
    )
    .await;

    // Always kill the child process
    let _ = child.kill().await;

    result.map_err(|_| "MCP handshake timed out (15s)".to_string())?
}

/// Run MCP handshake over a generic reader/writer pair (used by both stdio and HTTP).
async fn run_mcp_handshake(
    mut stdin: impl tokio::io::AsyncWrite + Unpin,
    stdout: impl tokio::io::AsyncRead + Unpin,
) -> Result<Vec<McpToolInfo>, String> {
    use tokio::io::BufReader;

    let mut reader = BufReader::new(stdout);
    let mut id_counter: u64 = 1;

    // Step 1: Send initialize request
    let init_request = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "oneagent",
                "version": "0.1.0"
            }
        }
    });
    send_jsonrpc(&mut stdin, &init_request).await?;
    id_counter += 1;

    // Step 2: Read initialize response
    let _init_response = read_jsonrpc_response(&mut reader, 1).await?;

    // Step 3: Send initialized notification
    let initialized = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    send_jsonrpc(&mut stdin, &initialized).await?;

    // Step 4: Send tools/list request
    let tools_request = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "tools/list",
        "params": {}
    });
    send_jsonrpc(&mut stdin, &tools_request).await?;

    // Step 5: Read tools/list response
    let tools_response = read_jsonrpc_response(&mut reader, id_counter).await?;

    // Parse tools from response
    parse_tools_from_response(&tools_response)
}

/// Send a JSON-RPC message over stdin (Content-Length framed).
async fn send_jsonrpc(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    msg: &serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let body = serde_json::to_string(msg).map_err(|e| format!("serialize: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("write header: {e}"))?;
    writer
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write body: {e}"))?;
    writer.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Read a JSON-RPC response, skipping notifications (messages without "id").
async fn read_jsonrpc_response(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    expected_id: u64,
) -> Result<serde_json::Value, String> {
    use tokio::io::AsyncBufReadExt;

    loop {
        // Read Content-Length header
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("read header: {e}"))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some(val) = trimmed.strip_prefix("Content-Length:") {
                content_length = val
                    .trim()
                    .parse::<usize>()
                    .ok();
            }
        }

        let len = content_length.ok_or("Missing Content-Length header")?;
        let mut body = vec![0u8; len];
        tokio::io::AsyncReadExt::read_exact(reader, &mut body)
            .await
            .map_err(|e| format!("read body: {e}"))?;

        let msg: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| format!("parse json: {e}"))?;

        // Skip notifications (no "id" field)
        if msg.get("id").and_then(|v| v.as_u64()) == Some(expected_id) {
            if let Some(error) = msg.get("error") {
                return Err(format!("MCP error: {}", error));
            }
            return Ok(msg);
        }
        // Otherwise it's a notification or a response for a different request — skip
    }
}

/// Parse tools from a tools/list JSON-RPC response.
fn parse_tools_from_response(response: &serde_json::Value) -> Result<Vec<McpToolInfo>, String> {
    let tools_array = response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or("No tools in response")?;

    let tools: Vec<McpToolInfo> = tools_array
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.to_string();
            let description = tool
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let input_schema = tool.get("inputSchema").cloned();
            Some(McpToolInfo {
                name,
                description,
                input_schema,
            })
        })
        .collect();

    Ok(tools)
}

/// Discover tools from an HTTP/SSE MCP server.
async fn discover_tools_http(config: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
    if config.url.is_empty() {
        return Err("URL is empty".to_string());
    }

    // HTTPS is not yet supported (no TLS library in the raw TCP stack)
    if config.url.starts_with("https://") {
        return Err("HTTPS transport is not yet supported; please use http://".to_string());
    }

    // Parse URL
    let stripped = config
        .url
        .strip_prefix("http://")
        .unwrap_or(&config.url);
    let (host_port, path) = if let Some(idx) = stripped.find('/') {
        (&stripped[..idx], &stripped[idx..])
    } else {
        (stripped, "/")
    };
    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        (h, p.parse::<u16>().unwrap_or(80))
    } else {
        (host_port, 80)
    };

    // Determine if this is SSE transport (path ends with /sse) or Streamable HTTP
    let is_sse = config.transport_type == McpTransportType::Sse || path.ends_with("/sse");

    if is_sse {
        discover_tools_sse(host, port, path, &config.headers).await
    } else {
        discover_tools_streamable_http(host, port, path, &config.headers).await
    }
}

/// Discover tools via MCP Streamable HTTP transport.
async fn discover_tools_streamable_http(
    host: &str,
    port: u16,
    path: &str,
    headers: &serde_json::Value,
) -> Result<Vec<McpToolInfo>, String> {
    let mut id_counter: u64 = 1;

    // Step 1: initialize
    let init_body = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "oneagent", "version": "0.1.0"}
        }
    });
    let _init_response = http_post_jsonrpc(host, port, path, headers, &init_body)
        .await
        .map_err(|e| format!("initialize failed: {e}"))?;
    id_counter += 1;

    // Step 2: initialized notification
    let _ = http_post_jsonrpc(
        host, port, path, headers,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    ).await;

    // Step 3: tools/list
    let tools_body = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "tools/list",
        "params": {}
    });
    let tools_response = http_post_jsonrpc(host, port, path, headers, &tools_body)
        .await
        .map_err(|e| format!("tools/list failed: {e}"))?;

    parse_tools_from_response(&tools_response)
}

/// Discover tools via MCP SSE transport.
///
/// SSE transport flow:
/// 1. GET the SSE endpoint → receive event stream
/// 2. First event is "endpoint" with the URL to POST messages to
/// 3. POST initialize JSON-RPC to that endpoint
/// 4. Read response from SSE stream
/// 5. POST tools/list
/// 6. Read response from SSE stream
async fn discover_tools_sse(
    host: &str,
    port: u16,
    path: &str,
    headers: &serde_json::Value,
) -> Result<Vec<McpToolInfo>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let addr = format!("{host}:{port}");
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| "Connection timed out".to_string())?
    .map_err(|e| format!("TCP connect: {e}"))?;

    // Step 1: Send GET request for SSE stream
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n"
    );
    if let serde_json::Value::Object(hdrs) = headers {
        for (k, v) in hdrs {
            if let Some(val) = v.as_str() {
                request.push_str(&format!("{k}: {val}\r\n"));
            }
        }
    }
    request.push_str("\r\n");

    stream.write_all(request.as_bytes()).await.map_err(|e| format!("write GET: {e}"))?;
    stream.flush().await.map_err(|e| format!("flush: {e}"))?;

    let mut reader = BufReader::new(stream);

    // Step 2: Read HTTP response headers
    let mut status_line = String::new();
    reader.read_line(&mut status_line).await.map_err(|e| format!("read status: {e}"))?;

    // Skip remaining headers
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| format!("read header: {e}"))?;
        if line.trim().is_empty() {
            break;
        }
    }

    // Step 3: Read SSE events to find the "endpoint" event
    let post_endpoint = read_sse_event_field(&mut reader, "endpoint")
        .await
        .map_err(|e| format!("Failed to get SSE endpoint: {e}"))?;

    // Build full POST URL
    let post_path = if post_endpoint.starts_with("http") {
        // Absolute URL — extract path
        let stripped = post_endpoint
            .strip_prefix("http://")
            .or_else(|| post_endpoint.strip_prefix("https://"))
            .unwrap_or(&post_endpoint);
        if let Some(idx) = stripped.find('/') {
            stripped[idx..].to_string()
        } else {
            "/".to_string()
        }
    } else {
        post_endpoint
    };

    // Now use HTTP POST for the JSON-RPC messages, reading responses from the SSE stream
    let mut id_counter: u64 = 1;

    // Step 4: Send initialize via POST
    let init_body = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "oneagent", "version": "0.1.0"}
        }
    });
    http_post_fire_and_forget(host, port, &post_path, headers, &init_body).await?;

    // Read initialize response from SSE stream
    let _init_response = read_sse_jsonrpc_response(&mut reader, id_counter).await?;
    id_counter += 1;

    // Step 5: Send initialized notification
    http_post_fire_and_forget(
        host, port, &post_path, headers,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    ).await?;

    // Step 6: Send tools/list
    let tools_body = json!({
        "jsonrpc": "2.0",
        "id": id_counter,
        "method": "tools/list",
        "params": {}
    });
    http_post_fire_and_forget(host, port, &post_path, headers, &tools_body).await?;

    // Read tools/list response from SSE stream
    let tools_response = read_sse_jsonrpc_response(&mut reader, id_counter).await?;

    parse_tools_from_response(&tools_response)
}

/// Read SSE events until we find one with the given event type, return its data.
async fn read_sse_event_field(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    event_type: &str,
) -> Result<String, String> {
    use tokio::io::AsyncBufReadExt;
    loop {
        let mut event_name = String::new();
        let mut event_data = String::new();

        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.map_err(|e| format!("read SSE: {e}"))?;
            let trimmed = line.trim_end();

            if trimmed.is_empty() {
                // End of event
                break;
            }
            if let Some(data) = trimmed.strip_prefix("event:") {
                event_name = data.trim().to_string();
            } else if let Some(data) = trimmed.strip_prefix("data:") {
                event_data = data.trim().to_string();
            }
        }

        if event_name == event_type {
            return Ok(event_data);
        }
    }
}

/// Read SSE events until we find a JSON-RPC response with the expected id.
async fn read_sse_jsonrpc_response(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    expected_id: u64,
) -> Result<serde_json::Value, String> {
    use tokio::io::AsyncBufReadExt;
    loop {
        let mut event_name = String::new();
        let mut event_data = String::new();

        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.map_err(|e| format!("read SSE: {e}"))?;
            let trimmed = line.trim_end();

            if trimmed.is_empty() {
                break;
            }
            if let Some(data) = trimmed.strip_prefix("event:") {
                event_name = data.trim().to_string();
            } else if let Some(data) = trimmed.strip_prefix("data:") {
                event_data = data.trim().to_string();
            }
        }

        // Try to parse as JSON-RPC
        if event_name == "message" || event_name.is_empty() {
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&event_data) {
                if msg.get("id").and_then(|v| v.as_u64()) == Some(expected_id) {
                    if let Some(error) = msg.get("error") {
                        return Err(format!("MCP error: {}", error));
                    }
                    return Ok(msg);
                }
            }
        }
    }
}

/// HTTP POST without reading the response body (fire and forget).
/// Used in SSE transport where responses come via the SSE stream.
async fn http_post_fire_and_forget(
    host: &str,
    port: u16,
    path: &str,
    headers: &serde_json::Value,
    body: &serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let addr = format!("{host}:{port}");
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| "Connection timed out".to_string())?
    .map_err(|e| format!("TCP connect: {e}"))?;

    let body_str = serde_json::to_string(body).map_err(|e| format!("serialize: {e}"))?;
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body_str.len()
    );
    if let serde_json::Value::Object(hdrs) = headers {
        for (k, v) in hdrs {
            if let Some(val) = v.as_str() {
                request.push_str(&format!("{k}: {val}\r\n"));
            }
        }
    }
    request.push_str("\r\n");
    request.push_str(&body_str);

    stream.write_all(request.as_bytes()).await.map_err(|e| format!("write: {e}"))?;
    stream.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Send a JSON-RPC request via HTTP POST and return the response.
/// Handles Content-Length and chunked transfer encoding.
async fn http_post_jsonrpc(
    host: &str,
    port: u16,
    path: &str,
    headers: &serde_json::Value,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let addr = format!("{host}:{port}");
    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| "Connection timed out".to_string())?
    .map_err(|e| format!("TCP connect: {e}"))?;

    let body_str = serde_json::to_string(body).map_err(|e| format!("serialize: {e}"))?;

    // Build HTTP request
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccept: application/json\r\nConnection: close\r\n",
        body_str.len()
    );

    // Add custom headers
    if let serde_json::Value::Object(hdrs) = headers {
        for (k, v) in hdrs {
            if let Some(val) = v.as_str() {
                request.push_str(&format!("{k}: {val}\r\n"));
            }
        }
    }

    request.push_str("\r\n");
    request.push_str(&body_str);

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    stream.flush().await.map_err(|e| format!("flush: {e}"))?;

    // Read full response (with Connection: close, server will close when done)
    let mut response = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            stream.read(&mut buf),
        )
        .await
        .map_err(|_| "Read timed out".to_string())?
        .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&buf[..n]);
    }

    if response.is_empty() {
        return Err("Empty response from server".to_string());
    }

    // Parse HTTP response
    let response_str = String::from_utf8_lossy(&response);
    let header_end = response_str
        .find("\r\n\r\n")
        .ok_or_else(|| {
            // No header/body separator — maybe the server returned raw data
            format!("Invalid HTTP response (no header separator). Raw: {}",
                &response_str[..response_str.len().min(200)])
        })?;

    let header_section = &response_str[..header_end];
    let body_section = &response_str[header_end + 4..];

    // Check for SSE content type (old MCP transport — not supported here)
    if header_section.to_lowercase().contains("content-type: text/event-stream") {
        return Err("Server uses SSE transport (not supported for tool discovery). Use stdio or Streamable HTTP.".to_string());
    }

    // Parse body based on transfer encoding
    let json_body = if header_section.to_lowercase().contains("transfer-encoding: chunked") {
        decode_chunked(body_section)?
    } else {
        body_section.to_string()
    };

    if json_body.trim().is_empty() {
        return Err(format!("Empty JSON body. Headers: {}",
            &header_section[..header_section.len().min(300)]));
    }

    serde_json::from_str(&json_body).map_err(|e| {
        format!(
            "parse JSON: {e}. Body: {}",
            &json_body[..json_body.len().min(200)]
        )
    })
}

/// Decode chunked transfer encoding body.
fn decode_chunked(body: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut remaining = body;

    loop {
        // Find the chunk size line
        let line_end = remaining
            .find("\r\n")
            .ok_or("Invalid chunked encoding: no CRLF after chunk size")?;
        let size_str = remaining[..line_end].trim();
        if size_str.is_empty() {
            break;
        }
        let chunk_size = usize::from_str_radix(size_str, 16)
            .map_err(|_| format!("Invalid chunk size: '{size_str}'"))?;

        if chunk_size == 0 {
            break; // Last chunk
        }

        let chunk_start = line_end + 2;
        let chunk_end = chunk_start + chunk_size;
        if chunk_end > remaining.len() {
            return Err("Chunk extends beyond body".to_string());
        }
        result.push_str(&remaining[chunk_start..chunk_end]);
        remaining = &remaining[chunk_end..];

        // Skip trailing CRLF
        remaining = remaining.strip_prefix("\r\n").unwrap_or(remaining);
    }

    Ok(result)
}

