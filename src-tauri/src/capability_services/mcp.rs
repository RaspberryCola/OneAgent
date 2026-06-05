use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use parking_lot::RwLock;
use serde_json::json;

use crate::{
    domain::{
        McpConnectionStatus, McpPrompt, McpPromptArgument, McpResource, McpServerConfig,
        McpServerInfo, McpServerStatus, McpToolInfo, McpTransportType,
    },
    storage::Database,
};

// OAuth support
use rmcp::transport::auth::OAuthState;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// MCP client name reported during protocol handshake.
const MCP_CLIENT_NAME: &str = "oneagent";

/// MCP client version reported during protocol handshake.
const MCP_CLIENT_VERSION: &str = "0.1.0";

/// Maximum time allowed for a complete test_connection (handshake + tool discovery).
const TEST_CONNECTION_TIMEOUT_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// SSRF Protection
// ---------------------------------------------------------------------------

/// Validate a URL to prevent Server-Side Request Forgery (SSRF) attacks.
/// Returns an error if the URL points to a private/internal network.
pub fn validate_url_for_ssrf(url: &str) -> Result<(), McpError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| McpError::Config(format!("Invalid URL: {e}")))?;
    
    // Only allow http and https schemes
    match parsed.scheme() {
        "http" | "https" => {},
        _ => return Err(McpError::Config(format!("Unsupported URL scheme: {}", parsed.scheme()))),
    }
    
    // Check host
    let host = parsed.host_str().ok_or_else(|| McpError::Config("URL has no host".to_string()))?;
    
    // Block private/internal IP ranges (but allow loopback, since local services
    // like the browser MCP proxy always bind to 127.0.0.1 / ::1).
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let is_loopback = match ip {
            std::net::IpAddr::V4(ipv4) => ipv4.is_loopback(),
            std::net::IpAddr::V6(ipv6) => ipv6.is_loopback(),
        };
        if !is_loopback && is_private_ip(ip) {
            return Err(McpError::Config(
                "URL points to a private/internal network address".to_string()
            ));
        }
    }
    
    // Log localhost variants for visibility
    let localhost_hosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];
    if localhost_hosts.contains(&host) {
        tracing::debug!("URL points to localhost (allowed): {}", url);
    }
    
    Ok(())
}

/// Check if an IP address is in a private/internal range.
fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ipv4) => {
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_broadcast()
                || ipv4.is_documentation()
                || ipv4.octets()[0] == 0 // 0.x.x.x
                || (ipv4.octets()[0] == 100 && (ipv4.octets()[1] & 0xC0) == 64) // 100.64.0.0/10 (Carrier-grade NAT)
                || (ipv4.octets()[0] == 192 && ipv4.octets()[1] == 0 && ipv4.octets()[2] == 0) // 192.0.0.0/24
                || (ipv4.octets()[0] == 198 && (ipv4.octets()[1] == 18 || ipv4.octets()[1] == 19)) // 198.18.0.0/15 (benchmarking)
        }
        std::net::IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
                || ipv6.is_multicast()
                || (ipv6.segments()[0] & 0xFE00) == 0xFC00 // Unique local addresses
                || (ipv6.segments()[0] & 0xFFC0) == 0xFE80 // Link-local addresses
        }
    }
}

// ---------------------------------------------------------------------------
// Structured Error Types
// ---------------------------------------------------------------------------

/// Structured error type for MCP operations.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Transport error: {0}")]
    Transport(String),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Tool listing failed: {0}")]
    ToolListing(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

// ---------------------------------------------------------------------------
// MCP Registry
// ---------------------------------------------------------------------------

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
    pub fn resolve_all(
        &self,
        workspace_id: &str,
    ) -> crate::storage::StorageResult<Vec<McpServerConfig>> {
        let mut servers: Vec<McpServerConfig> = self
            .db
            .list_workspace_mcp(workspace_id)?
            .into_iter()
            .filter(|s| s.enabled)
            .collect();

        // Inject builtin provider results (respecting both user preference and runtime state)
        for provider in self.builtin_providers.read().iter() {
            if let Some(builtin) = provider() {
                // Skip if user has disabled this builtin MCP
                if !self.get_builtin_enabled(&builtin.id) {
                    continue;
                }
                // Skip if the provider reports it's not available (e.g. browser not running)
                if !builtin.enabled {
                    continue;
                }
                if !servers.iter().any(|s| s.id == builtin.id) {
                    servers.push(builtin);
                }
            }
        }

        Ok(servers)
    }

    /// List MCP servers including builtin providers (for settings UI).
    /// All servers are returned (both enabled and disabled).
    pub fn list_with_builtins(
        &self,
        workspace_id: &str,
    ) -> crate::storage::StorageResult<Vec<McpServerConfig>> {
        let mut servers: Vec<McpServerConfig> = self.db.list_workspace_mcp(workspace_id)?;

        for provider in self.builtin_providers.read().iter() {
            if let Some(mut builtin) = provider() {
                builtin.enabled = self.get_builtin_enabled(&builtin.id);
                if !servers.iter().any(|s| s.id == builtin.id) {
                    servers.push(builtin);
                }
            }
        }

        Ok(servers)
    }

    /// Check if a builtin MCP server is enabled. Default is true.
    pub fn get_builtin_enabled(&self, id: &str) -> bool {
        let key = format!("builtin_mcp_enabled_{}", id);
        self.db.get_system_setting(&key)
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true)
    }

    /// Toggle the enabled state of a builtin MCP server.
    pub fn set_builtin_enabled(&self, id: &str, enabled: bool) -> crate::storage::StorageResult<()> {
        let key = format!("builtin_mcp_enabled_{}", id);
        self.db.set_system_setting(&key, &enabled.to_string())
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
    /// Uses the rmcp library to perform a full MCP protocol handshake
    /// (initialize → initialized → tools/list) and returns the discovered
    /// tools along with server information.
    pub async fn test_connection(&self, config: &McpServerConfig) -> McpServerStatus {
        // SSRF protection: validate URL for HTTP/SSE transports
        if matches!(config.transport_type, McpTransportType::Http | McpTransportType::Sse) {
            if let Err(e) = validate_url_for_ssrf(&config.url) {
                return McpServerStatus {
                    config_id: config.id.clone(),
                    name: config.name.clone(),
                    status: McpConnectionStatus::Error,
                    tools: vec![],
                    resources: vec![],
                    prompts: vec![],
                    error_message: Some(e.to_string()),
                    server_info: None,
                    last_updated: Utc::now(),
                };
            }
        }
        
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(TEST_CONNECTION_TIMEOUT_SECS),
            discover_server_info(config),
        )
        .await;

        match result {
            Ok(Ok(discovery)) => McpServerStatus {
                config_id: config.id.clone(),
                name: config.name.clone(),
                status: McpConnectionStatus::Connected,
                tools: discovery.tools,
                resources: discovery.resources,
                prompts: discovery.prompts,
                error_message: None,
                server_info: discovery.server_info,
                last_updated: Utc::now(),
            },
            Ok(Err(e)) => McpServerStatus {
                config_id: config.id.clone(),
                name: config.name.clone(),
                status: McpConnectionStatus::Error,
                tools: vec![],
                resources: vec![],
                prompts: vec![],
                error_message: Some(e.to_string()),
                server_info: None,
                last_updated: Utc::now(),
            },
            Err(_) => McpServerStatus {
                config_id: config.id.clone(),
                name: config.name.clone(),
                status: McpConnectionStatus::Error,
                tools: vec![],
                resources: vec![],
                prompts: vec![],
                error_message: Some(format!(
                    "MCP connection timed out after {}s",
                    TEST_CONNECTION_TIMEOUT_SECS
                )),
                server_info: None,
                last_updated: Utc::now(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// MCP Config JSON Parsing
// ---------------------------------------------------------------------------

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
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_scopes: None,
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
            oauth_client_id: None,
            oauth_client_secret: None,
            oauth_scopes: None,
        });
    }
    Ok(configs)
}

// ---------------------------------------------------------------------------
// MCP Discovery via rmcp
// ---------------------------------------------------------------------------

/// Build a `ClientInfo` with OneAgent's client identity and sampling capability.
fn build_client_info() -> rmcp::model::ClientInfo {
    let mut capabilities = rmcp::model::ClientCapabilities::default();
    capabilities.sampling = Some(rmcp::model::SamplingCapability::default());
    rmcp::model::ClientInfo::new(
        capabilities,
        rmcp::model::Implementation::new(MCP_CLIENT_NAME, MCP_CLIENT_VERSION),
    )
}

/// Result of a full MCP server discovery (tools + resources + prompts + server info).
struct DiscoveryResult {
    tools: Vec<McpToolInfo>,
    resources: Vec<McpResource>,
    prompts: Vec<McpPrompt>,
    server_info: Option<McpServerInfo>,
}

/// Discover tools, resources, and server info from an MCP server using the rmcp library.
///
/// Routes to the appropriate transport (stdio or streamable HTTP) based on
/// the server configuration.
async fn discover_server_info(
    config: &McpServerConfig,
) -> Result<DiscoveryResult, McpError> {
    match config.transport_type {
        McpTransportType::Stdio => discover_via_stdio(config).await,
        McpTransportType::Sse | McpTransportType::Http => discover_via_http(config).await,
        McpTransportType::Acp => discover_via_acp(config).await,
    }
}

/// Discover tools via stdio transport using rmcp's TokioChildProcess.
async fn discover_via_stdio(
    config: &McpServerConfig,
) -> Result<DiscoveryResult, McpError> {
    use rmcp::transport::TokioChildProcess;
    use rmcp::ServiceExt;

    if config.command.is_empty() {
        return Err(McpError::Config("Command is empty".to_string()));
    }

    // Build the command with environment variables
    let mut cmd = tokio::process::Command::new(&config.command);
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

    // Create rmcp child process transport
    let child_process = TokioChildProcess::new(cmd)
        .map_err(|e| McpError::Transport(format!("Failed to spawn '{}': {e}", config.command)))?;

    // Run MCP handshake (initialize → initialized → ready)
    let service = build_client_info()
        .serve(child_process)
        .await
        .map_err(|e| McpError::Protocol(format!("MCP handshake failed: {e}")))?;

    // Extract server information from the handshake response
    let server_info = extract_server_info(&service);

    // List all tools (with automatic pagination via rmcp)
    let rmcp_tools = service
        .peer()
        .list_all_tools()
        .await
        .map_err(|e| McpError::ToolListing(format!("{e}")))?;

    // List resources (best-effort; some servers may not support this)
    let resources = list_resources_safe(&service).await;

    // List prompts (best-effort; some servers may not support this)
    let prompts = list_prompts_safe(&service).await;

    // Convert rmcp Tool types to our McpToolInfo domain type
    let tools = rmcp_tools.into_iter().map(convert_tool).collect();

    // RunningService drops here, cleaning up the child process transport
    Ok(DiscoveryResult { tools, resources, prompts, server_info })
}

/// Discover tools via Streamable HTTP transport using rmcp.
///
/// Supports both HTTP and HTTPS URLs. HTTPS is handled transparently
/// through the reqwest TLS backend (rustls).
/// Supports OAuth 2.1 authentication for servers that require it.
async fn discover_via_http(
    config: &McpServerConfig,
) -> Result<DiscoveryResult, McpError> {
    use rmcp::ServiceExt;

    if config.url.is_empty() {
        return Err(McpError::Config("URL is empty".to_string()));
    }

    // Check if OAuth is configured
    if config.oauth_client_id.is_some() {
        // Use OAuth authentication
        return discover_via_http_oauth(config).await;
    }

    // Build reqwest HTTP client
    let http_client = reqwest::Client::new();

    // Build transport config with custom headers
    let mut transport_config =
        StreamableHttpClientTransportConfig::with_uri(config.url.as_str());

    if let serde_json::Value::Object(hdrs) = &config.headers {
        let mut custom_headers = HashMap::new();
        for (k, v) in hdrs {
            if let Some(val) = v.as_str() {
                if let (Ok(name), Ok(value)) = (
                    k.parse::<http::header::HeaderName>(),
                    val.parse::<http::header::HeaderValue>(),
                ) {
                    custom_headers.insert(name, value);
                }
            }
        }
        if !custom_headers.is_empty() {
            transport_config = transport_config.custom_headers(custom_headers);
        }
    }

    let transport = StreamableHttpClientTransport::with_client(http_client, transport_config);

    // Run MCP handshake
    let service = build_client_info()
        .serve(transport)
        .await
        .map_err(|e| {
            McpError::Protocol(format!("MCP handshake failed for {}: {e}", config.url))
        })?;

    // Extract server information
    let server_info = extract_server_info(&service);

    // List all tools (with automatic pagination)
    let rmcp_tools = service
        .peer()
        .list_all_tools()
        .await
        .map_err(|e| McpError::ToolListing(format!("{e}")))?;

    // List resources (best-effort)
    let resources = list_resources_safe(&service).await;

    // List prompts (best-effort)
    let prompts = list_prompts_safe(&service).await;

    let tools = rmcp_tools.into_iter().map(convert_tool).collect();

    Ok(DiscoveryResult { tools, resources, prompts, server_info })
}

/// Discover tools via Streamable HTTP transport with OAuth authentication.
async fn discover_via_http_oauth(
    config: &McpServerConfig,
) -> Result<DiscoveryResult, McpError> {
    let _client_id = config.oauth_client_id.as_ref()
        .ok_or_else(|| McpError::Config("OAuth client ID is required".to_string()))?;
    
    let scopes = config.oauth_scopes.clone().unwrap_or_default();
    let scopes_refs: Vec<&str> = scopes.iter().map(|s| s.as_str()).collect();
    
    // Initialize OAuth state machine
    let mut oauth_state = OAuthState::new(&config.url, None)
        .await
        .map_err(|e| McpError::Protocol(format!("OAuth initialization failed: {e}")))?;
    
    // Start authorization
    let redirect_uri = "http://localhost:8080/callback"; // TODO: Make this configurable
    oauth_state
        .start_authorization(&scopes_refs, redirect_uri, Some("OneAgent"))
        .await
        .map_err(|e| McpError::Protocol(format!("OAuth authorization failed: {e}")))?;
    
    // Get authorization URL
    let auth_url = oauth_state.get_authorization_url().await
        .map_err(|e| McpError::Protocol(format!("Failed to get OAuth URL: {e}")))?;
    
    tracing::info!("OAuth authorization URL: {}", auth_url);
    
    // TODO: In a real implementation, we would:
    // 1. Open the auth_url in a browser
    // 2. Start a local HTTP server to handle the callback
    // 3. Wait for the user to complete authorization
    // 4. Handle the callback with the authorization code
    
    // For now, we return an error indicating OAuth is not yet fully implemented
    Err(McpError::Protocol(format!(
        "OAuth authentication required. Please open: {}",
        auth_url
    )))
}

/// Discover tools via MCP-over-ACP transport.
///
/// For ACP transport, the MCP server runs in the agent's address space.
/// We need to use the ACP protocol to discover tools.
async fn discover_via_acp(
    config: &McpServerConfig,
) -> Result<DiscoveryResult, McpError> {
    // For ACP transport, we cannot directly discover tools using the MCP protocol
    // because the server runs in the agent's address space. Instead, we need to:
    // 1. Use the ACP session to send mcp/connect message
    // 2. Get the tool list from the ACP response
    // 3. Return the discovered tools
    //
    // However, for now we return an empty result because:
    // - The ACP session management is handled elsewhere
    // - Tools are discovered when the ACP session is established
    // - This function is only called for test_connection which is not applicable for ACP
    
    tracing::info!(
        "MCP-over-ACP discovery for '{}' - tools will be discovered via ACP session",
        config.name
    );
    
    // Return empty discovery result for ACP transport
    // The actual tool discovery happens when the ACP session is established
    Ok(DiscoveryResult {
        tools: vec![],
        resources: vec![],
        prompts: vec![],
        server_info: Some(McpServerInfo {
            name: config.name.clone(),
            version: "acp".to_string(),
            protocol_version: Some("acp".to_string()),
        }),
    })
}

/// Extract `McpServerInfo` from a running rmcp service's peer info.
fn extract_server_info<S: rmcp::Service<rmcp::service::RoleClient>>(
    service: &rmcp::service::RunningService<rmcp::service::RoleClient, S>,
) -> Option<McpServerInfo> {
    service.peer_info().map(|info| McpServerInfo {
        name: info.server_info.name.clone(),
        version: info.server_info.version.clone(),
        protocol_version: Some(format!("{:?}", info.protocol_version)),
    })
}

/// Convert an rmcp `Tool` to our `McpToolInfo` domain type.
fn convert_tool(tool: rmcp::model::Tool) -> McpToolInfo {
    let input_schema = serde_json::Value::Object((*tool.input_schema).clone());
    McpToolInfo {
        name: tool.name.into_owned(),
        description: tool.description.map(|d| d.into_owned()),
        input_schema: Some(input_schema),
    }
}

/// List resources from an MCP server, returning an empty vec on failure.
/// This is best-effort: some servers may not support resources.
async fn list_resources_safe<S: rmcp::Service<rmcp::service::RoleClient>>(
    service: &rmcp::service::RunningService<rmcp::service::RoleClient, S>,
) -> Vec<McpResource> {
    match service.peer().list_all_resources().await {
        Ok(resources) => resources.into_iter().map(convert_resource).collect(),
        Err(_) => vec![],
    }
}

/// List prompts from an MCP server, returning an empty vec on failure.
/// This is best-effort: some servers may not support prompts.
async fn list_prompts_safe<S: rmcp::Service<rmcp::service::RoleClient>>(
    service: &rmcp::service::RunningService<rmcp::service::RoleClient, S>,
) -> Vec<McpPrompt> {
    match service.peer().list_all_prompts().await {
        Ok(prompts) => prompts.into_iter().map(convert_prompt).collect(),
        Err(_) => vec![],
    }
}

/// Convert an rmcp `Resource` to our `McpResource` domain type.
fn convert_resource(resource: rmcp::model::Resource) -> McpResource {
    McpResource {
        uri: resource.uri.clone(),
        name: resource.name.clone(),
        description: resource.description.clone(),
        mime_type: resource.mime_type.clone(),
    }
}

/// Convert an rmcp `Prompt` to our `McpPrompt` domain type.
fn convert_prompt(prompt: rmcp::model::Prompt) -> McpPrompt {
    McpPrompt {
        name: prompt.name.clone(),
        description: prompt.description.clone(),
        arguments: prompt
            .arguments
            .as_ref()
            .map(|args| {
                args.iter()
                    .map(|arg| McpPromptArgument {
                        name: arg.name.clone(),
                        description: arg.description.clone(),
                        required: arg.required.unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Persistent Connection Manager
// ---------------------------------------------------------------------------

/// Maximum time to wait for a persistent connection handshake.
const PERSISTENT_CONN_TIMEOUT_SECS: u64 = 15;

/// Initial reconnect delay in seconds.
const RECONNECT_BASE_SECS: u64 = 2;

/// Maximum reconnect delay in seconds.
const RECONNECT_MAX_SECS: u64 = 60;

/// A managed long-lived connection to an MCP server.
struct ManagedConnection {
    cancel: tokio::sync::watch::Sender<bool>,
}

/// Handles server notifications for a persistent MCP connection.
///
/// When the server sends a `notifications/tools/list_changed`, this handler
/// sends a notification through a channel so the background task can refresh
/// the tool list.
struct ConnectionHandler {
    change_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl ConnectionHandler {
    fn new(change_tx: tokio::sync::mpsc::UnboundedSender<()>) -> Self {
        Self { change_tx }
    }
}

impl rmcp::ClientHandler for ConnectionHandler {
    fn get_info(&self) -> rmcp::model::ClientInfo {
        build_client_info()
    }

    fn on_tool_list_changed(
        &self,
        _context: rmcp::service::NotificationContext<rmcp::service::RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send {
        let _ = self.change_tx.send(());
        std::future::ready(())
    }

    fn on_resource_list_changed(
        &self,
        _context: rmcp::service::NotificationContext<rmcp::service::RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send {
        let _ = self.change_tx.send(());
        std::future::ready(())
    }

    fn on_prompt_list_changed(
        &self,
        _context: rmcp::service::NotificationContext<rmcp::service::RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send {
        let _ = self.change_tx.send(());
        std::future::ready(())
    }
}

/// Manages persistent connections to enabled MCP servers.
///
/// For each enabled MCP server, maintains a background task that:
/// 1. Establishes and holds a long-lived MCP connection
/// 2. Listens for `notifications/tools/list_changed` from the server
/// 3. Automatically refreshes the tool list when changes are detected
/// 4. Reconnects with exponential backoff on connection failures
#[derive(Clone)]
pub struct McpConnectionManager {
    connections: Arc<RwLock<HashMap<String, ManagedConnection>>>,
    registry: McpRegistry,
    workspace_id: String,
}

impl McpConnectionManager {
    pub fn new(registry: McpRegistry, workspace_id: String) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            registry,
            workspace_id,
        }
    }

    /// Start persistent connections for all currently enabled MCP servers.
    pub async fn start_all(&self) {
        let servers = match self.registry.resolve_all(&self.workspace_id) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("Failed to resolve MCP servers: {e}");
                return;
            }
        };

        for server in servers {
            self.start_connection(server);
        }
    }

    /// Start a persistent connection to a single MCP server.
    pub fn start_connection(&self, config: McpServerConfig) {
        let config_id = config.id.clone();

        // Don't start if already connected
        if self.connections.read().contains_key(&config_id) {
            return;
        }

        // Skip servers with placeholder URLs (e.g. builtin browser MCP when not running)
        if is_placeholder_url(&config) {
            tracing::debug!(
                "Skipping persistent connection for '{}' (placeholder URL)",
                config.name
            );
            return;
        }

        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        self.connections
            .write()
            .insert(config_id.clone(), ManagedConnection { cancel: cancel_tx });

        let connections = self.connections.clone();
        let registry = self.registry.clone();
        let workspace_id = config.workspace_id.clone();

        tokio::spawn(async move {
            run_persistent_connection(config, registry, workspace_id, cancel_rx).await;
            connections.write().remove(&config_id);
        });
    }

    /// Stop a specific persistent connection.
    pub fn stop_connection(&self, config_id: &str) {
        if let Some(conn) = self.connections.write().remove(config_id) {
            let _ = conn.cancel.send(true);
        }
    }

    /// Stop all persistent connections.
    pub fn stop_all(&self) {
        for (_, conn) in self.connections.write().drain() {
            let _ = conn.cancel.send(true);
        }
    }

    /// Reload a specific connection with new configuration.
    /// Stops the existing connection (if any) and starts a new one.
    pub fn reload_connection(&self, config: McpServerConfig) {
        let config_id = config.id.clone();
        tracing::info!("Reloading MCP connection for '{}' ({})", config.name, config_id);
        
        // Stop existing connection
        self.stop_connection(&config_id);
        
        // Start new connection
        self.start_connection(config);
    }

    /// Reload all connections for the workspace.
    /// Stops all existing connections and starts new ones based on current configuration.
    pub fn reload_all(&self, workspace_id: &str) {
        tracing::info!("Reloading all MCP connections for workspace '{}'", workspace_id);
        self.stop_all();

        let manager = Self {
            connections: self.connections.clone(),
            registry: self.registry.clone(),
            workspace_id: workspace_id.to_string(),
        };

        tokio::spawn(async move {
            manager.start_all().await;
        });
    }

    /// Get the number of active connections.
    pub fn active_connection_count(&self) -> usize {
        self.connections.read().len()
    }

    /// Check if a specific server is connected.
    pub fn is_connected(&self, config_id: &str) -> bool {
        self.connections.read().contains_key(config_id)
    }
}

/// Background task for a single persistent MCP connection with auto-reconnect.
async fn run_persistent_connection(
    config: McpServerConfig,
    registry: McpRegistry,
    workspace_id: String,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let config_id = config.id.clone();
    let mut attempt: u32 = 0;

    loop {
        // Check cancellation
        if *cancel_rx.borrow() {
            tracing::debug!("MCP connection cancelled for '{}'", config.name);
            return;
        }

        tracing::info!("Connecting to MCP server '{}' ({})", config.name, config.url_or_command());

        match establish_persistent(&config, &mut cancel_rx).await {
            Ok(discovery) => {
                // Connection was established, discovery completed, now emit connected status
                let status = McpServerStatus {
                    config_id: config_id.clone(),
                    name: config.name.clone(),
                    status: McpConnectionStatus::Connected,
                    tools: discovery.tools,
                    resources: discovery.resources,
                    prompts: discovery.prompts,
                    error_message: None,
                    server_info: discovery.server_info,
                    last_updated: Utc::now(),
                };
                registry.update_status(&workspace_id, status);

                // Connection was established and then closed normally (or cancelled)
                attempt = 0;
                tracing::info!("MCP connection closed for '{}'", config.name);

                // Always wait a minimum delay after a connection drops before
                // reconnecting.  Without this, a process that starts and
                // immediately exits would create a tight reconnection loop
                // that hammers the CPU.
                let cooldown = std::time::Duration::from_secs(RECONNECT_BASE_SECS);
                tokio::select! {
                    _ = tokio::time::sleep(cooldown) => {}
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return;
                        }
                    }
                }
            }
            Err(e) => {
                attempt += 1;
                let delay = std::time::Duration::from_secs(
                    (RECONNECT_BASE_SECS.pow(attempt.min(5))).min(RECONNECT_MAX_SECS),
                );

                // Update status to error
                let status = McpServerStatus {
                    config_id: config_id.clone(),
                    name: config.name.clone(),
                    status: McpConnectionStatus::Error,
                    tools: vec![],
                    resources: vec![],
                    prompts: vec![],
                    error_message: Some(format!("{e} (reconnecting in {:?})", delay)),
                    server_info: None,
                    last_updated: Utc::now(),
                };
                registry.update_status(&workspace_id, status);

                tracing::warn!(
                    "MCP connection failed for '{}' (attempt {}): {e}. Reconnecting in {:?}",
                    config.name, attempt, delay
                );

                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// Establish a persistent connection, perform tool discovery, and maintain it.
///
/// Returns when:
/// - The connection is cancelled or closed normally (Ok with discovery result)
/// - The connection fails (Err)
async fn establish_persistent(
    config: &McpServerConfig,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<DiscoveryResult, McpError> {
    use rmcp::ServiceExt;

    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let handler = ConnectionHandler::new(change_tx);

    // Build transport based on transport type
    match config.transport_type {
        McpTransportType::Stdio => {
            use rmcp::transport::TokioChildProcess;

            if config.command.is_empty() {
                return Err(McpError::Config("Command is empty".to_string()));
            }

            let mut cmd = tokio::process::Command::new(&config.command);
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

            let child_process = TokioChildProcess::new(cmd).map_err(|e| {
                McpError::Transport(format!("Failed to spawn '{}': {e}", config.command))
            })?;

            let service = tokio::time::timeout(
                std::time::Duration::from_secs(PERSISTENT_CONN_TIMEOUT_SECS),
                handler.serve(child_process),
            )
            .await
            .map_err(|_| McpError::Timeout("Connection handshake timed out".to_string()))?
            .map_err(|e| McpError::Protocol(format!("Handshake failed: {e}")))?;

            // Perform tool/resource/prompt discovery on the live connection
            let server_info = extract_server_info(&service);
            let rmcp_tools = service
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| McpError::ToolListing(format!("{e}")))?;
            let resources = list_resources_safe(&service).await;
            let prompts = list_prompts_safe(&service).await;
            let tools = rmcp_tools.into_iter().map(convert_tool).collect();
            let discovery = DiscoveryResult { tools, resources, prompts, server_info };

            // Wait for notifications or cancellation
            loop {
                tokio::select! {
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return Ok(discovery);
                        }
                    }
                    Some(()) = change_rx.recv() => {
                        tracing::info!("Tool/resource/prompt list changed for MCP server '{}'", config.name);
                    }
                }
            }
        }
        McpTransportType::Sse | McpTransportType::Http => {
            use rmcp::transport::streamable_http_client::{
                StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
            };

            if config.url.is_empty() {
                return Err(McpError::Config("URL is empty".to_string()));
            }

            let http_client = reqwest::Client::new();
            let mut transport_config =
                StreamableHttpClientTransportConfig::with_uri(config.url.as_str());

            if let serde_json::Value::Object(hdrs) = &config.headers {
                let mut custom_headers = HashMap::new();
                for (k, v) in hdrs {
                    if let Some(val) = v.as_str() {
                        if let (Ok(name), Ok(value)) = (
                            k.parse::<http::header::HeaderName>(),
                            val.parse::<http::header::HeaderValue>(),
                        ) {
                            custom_headers.insert(name, value);
                        }
                    }
                }
                if !custom_headers.is_empty() {
                    transport_config = transport_config.custom_headers(custom_headers);
                }
            }

            let transport =
                StreamableHttpClientTransport::with_client(http_client, transport_config);

            let service = tokio::time::timeout(
                std::time::Duration::from_secs(PERSISTENT_CONN_TIMEOUT_SECS),
                handler.serve(transport),
            )
            .await
            .map_err(|_| McpError::Timeout("Connection handshake timed out".to_string()))?
            .map_err(|e| McpError::Protocol(format!("Handshake failed: {e}")))?;

            // Perform tool/resource/prompt discovery on the live connection
            let server_info = extract_server_info(&service);
            let rmcp_tools = service
                .peer()
                .list_all_tools()
                .await
                .map_err(|e| McpError::ToolListing(format!("{e}")))?;
            let resources = list_resources_safe(&service).await;
            let prompts = list_prompts_safe(&service).await;
            let tools = rmcp_tools.into_iter().map(convert_tool).collect();
            let discovery = DiscoveryResult { tools, resources, prompts, server_info };

            // Wait for notifications or cancellation
            loop {
                tokio::select! {
                    _ = cancel_rx.changed() => {
                        if *cancel_rx.borrow() {
                            return Ok(discovery);
                        }
                    }
                    Some(()) = change_rx.recv() => {
                        tracing::info!("Tool/resource/prompt list changed for MCP server '{}'", config.name);
                    }
                }
            }
        }
        McpTransportType::Acp => {
            // MCP-over-ACP transport
            // For ACP transport, the MCP server runs in the agent's address space.
            // We cannot maintain a persistent connection to it using the MCP protocol.
            // Instead, the ACP session handles MCP tool discovery and invocation.
            tracing::info!(
                "MCP-over-ACP persistent connection for '{}' - managed by ACP session",
                config.name
            );

            let discovery = DiscoveryResult {
                tools: vec![],
                resources: vec![],
                prompts: vec![],
                server_info: None,
            };

            // For ACP transport, we just wait for cancellation
            tokio::select! {
                _ = cancel_rx.changed() => {}
            }

            Ok(discovery)
        }
    }
}

// ---------------------------------------------------------------------------
// Helper extension for McpServerConfig
// ---------------------------------------------------------------------------

impl McpServerConfig {
    /// Returns the URL or command for logging purposes.
    fn url_or_command(&self) -> &str {
        match self.transport_type {
            McpTransportType::Acp => "acp",
            _ => {
                if self.url.is_empty() {
                    &self.command
                } else {
                    &self.url
                }
            }
        }
    }
}

/// Check if an MCP server config has a placeholder URL (e.g. port 0).
/// Used to skip persistent connections for builtin MCPs that are not yet active
/// (e.g. browser MCP when the browser is not running).
fn is_placeholder_url(config: &McpServerConfig) -> bool {
    match config.transport_type {
        McpTransportType::Sse | McpTransportType::Http => {
            // Check for port 0 placeholder URL (e.g. http://127.0.0.1:0/sse)
            if let Ok(parsed) = reqwest::Url::parse(&config.url) {
                parsed.port() == Some(0) || config.url.is_empty()
            } else {
                config.url.is_empty()
            }
        }
        McpTransportType::Stdio => config.command.is_empty(),
        McpTransportType::Acp => false,
    }
}

// ---------------------------------------------------------------------------
// MCP-over-ACP Connection Manager
// ---------------------------------------------------------------------------

/// Manages MCP-over-ACP connections.
///
/// For ACP transport, MCP servers run in the agent's address space.
/// This manager handles the routing of MCP messages through the ACP channel.
#[derive(Clone)]
pub struct McpAcpManager {
    /// Map of ACP connection ID to MCP server config
    connections: Arc<RwLock<HashMap<String, McpServerConfig>>>,
}

impl McpAcpManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register an MCP-over-ACP connection.
    ///
    /// Called when an agent sends an `mcp/connect` message.
    pub fn connect(&self, connection_id: String, config: McpServerConfig) {
        tracing::info!(
            "MCP-over-ACP connection established: {} -> {}",
            connection_id,
            config.name
        );
        self.connections.write().insert(connection_id, config);
    }

    /// Unregister an MCP-over-ACP connection.
    ///
    /// Called when an agent sends an `mcp/disconnect` message.
    pub fn disconnect(&self, connection_id: &str) {
        if let Some(config) = self.connections.write().remove(connection_id) {
            tracing::info!(
                "MCP-over-ACP connection closed: {} -> {}",
                connection_id,
                config.name
            );
        }
    }

    /// Get the MCP server config for an ACP connection.
    pub fn get_config(&self, connection_id: &str) -> Option<McpServerConfig> {
        self.connections.read().get(connection_id).cloned()
    }

    /// Handle an MCP message from an ACP connection.
    ///
    /// This method routes MCP messages to the appropriate MCP server.
    /// For now, it just logs the message.
    pub fn handle_message(&self, connection_id: &str, method: &str, _params: &serde_json::Value) {
        if let Some(config) = self.connections.read().get(connection_id) {
            tracing::info!(
                "MCP-over-ACP message: {} -> {} ({})",
                connection_id,
                config.name,
                method
            );
            // TODO: Route the message to the MCP server and return the response
            // This would require maintaining a connection to the MCP server
            // and forwarding the message through the appropriate transport
        } else {
            tracing::warn!(
                "MCP-over-ACP message for unknown connection: {} ({})",
                connection_id,
                method
            );
        }
    }

    /// Get all active connections.
    pub fn get_all_connections(&self) -> Vec<(String, McpServerConfig)> {
        self.connections
            .read()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}
