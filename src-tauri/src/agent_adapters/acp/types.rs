//! ACP protocol constants and internal type definitions.
//!
//! This module contains constants and typed protocol message structs used
//! throughout the ACP adapter implementation. Types are organized into:
//! - Constants (protocol version, size limits)
//! - Outgoing request params (Serialize)
//! - Incoming request params (Deserialize)
//! - Session update types (Deserialize)
//! - Permission types (Deserialize/Serialize)

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{agent_adapters::{AdapterError, AdapterResult}, domain::{McpServerConfig, McpTransportType, PermissionOptionKind, PlanEntryPriority, PlanEntryStatus, StopReason, ToolCallStatus, ToolKind}};

/// Convert a `McpServerConfig` to the JSON format expected by the ACP protocol.
///
/// ACP agents expect all fields to be present, with transport-specific values:
/// - `type`: "stdio", "sse", or "http" (preserved as-is)
/// - `command`: executable for stdio, empty string for sse/http
/// - `args`: array of strings for stdio, empty array for sse/http
/// - `env`: [{name, value}] pairs
/// - `url`: URL for sse/http, empty string for stdio
/// - `headers`: [{name, value}] pairs for sse/http, empty array for stdio
pub(crate) fn mcp_config_to_acp(config: &McpServerConfig) -> Value {
    let transport_type_str = match config.transport_type {
        McpTransportType::Stdio => "stdio",
        McpTransportType::Sse => "sse",
        McpTransportType::Http => "http",
    };

    match config.transport_type {
        McpTransportType::Sse | McpTransportType::Http => {
            json!({
                "type": transport_type_str,
                "name": config.name,
                "url": config.url,
                "command": "",
                "args": [],
                "env": [],
                "headers": headers_to_acp_pairs(&config.headers),
            })
        }
        McpTransportType::Stdio => {
            json!({
                "type": "stdio",
                "name": config.name,
                "command": config.command,
                "args": config.args,
                "env": env_to_acp_pairs(&config.env),
                "headers": [],
            })
        }
    }
}

/// Convert env JSON (flat object `{"KEY": "val"}`) to ACP format (`[{name: "KEY", value: "val"}]`).
fn env_to_acp_pairs(env: &Value) -> Value {
    match env {
        Value::Object(map) => {
            let pairs: Vec<Value> = map
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| json!({"name": k, "value": s})))
                .collect();
            Value::Array(pairs)
        }
        Value::Array(_) => env.clone(),
        _ => json!([]),
    }
}

/// Convert headers JSON (flat object `{"Authorization": "Bearer ..."}`) to ACP format
/// (`[{name: "Authorization", value: "Bearer ..."}]`).
fn headers_to_acp_pairs(headers: &Value) -> Value {
    match headers {
        Value::Object(map) => {
            let pairs: Vec<Value> = map
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| json!({"name": k, "value": s})))
                .collect();
            Value::Array(pairs)
        }
        Value::Array(_) => headers.clone(),
        _ => json!([]),
    }
}

/// Serialize a typed params struct into a JSON `Value`, wrapping errors
/// as `AdapterError::Protocol` with a descriptive label.
pub(crate) fn to_value_or_err<T: Serialize>(params: T, label: &str) -> AdapterResult<Value> {
    serde_json::to_value(params)
        .map_err(|e| AdapterError::Protocol(format!("serialize {label} params: {e}")))
}

/// Build a JSON-RPC 2.0 request envelope.
pub(crate) fn jsonrpc_request(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

/// Build a JSON-RPC 2.0 notification envelope (no id).
#[allow(dead_code)]
pub(crate) fn jsonrpc_notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

// ---------------------------------------------------------------------------
// Outgoing request parameter types
// ---------------------------------------------------------------------------

/// Client implementation info sent during initialize.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AcpClientInfo {
    pub(crate) name: &'static str,
    pub(crate) title: &'static str,
    pub(crate) version: &'static str,
}

/// File system capabilities advertised by the client.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AcpClientFsCapabilities {
    #[serde(rename = "readTextFile")]
    pub(crate) read_text_file: bool,
    #[serde(rename = "writeTextFile")]
    pub(crate) write_text_file: bool,
}

/// Capabilities advertised by the client during initialize.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AcpClientCapabilities {
    pub(crate) fs: AcpClientFsCapabilities,
    pub(crate) terminal: bool,
}

/// Parameters for the `initialize` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    pub(crate) protocol_version: u64,
    #[serde(rename = "clientCapabilities")]
    pub(crate) client_capabilities: AcpClientCapabilities,
    #[serde(rename = "clientInfo")]
    pub(crate) client_info: AcpClientInfo,
}

/// Parameters for the `session/new` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct NewSessionParams {
    pub(crate) cwd: String,
    #[serde(rename = "mcpServers")]
    pub(crate) mcp_servers: Vec<Value>,
}

/// Parameters for the `session/load` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct LoadSessionParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    pub(crate) cwd: String,
    #[serde(rename = "mcpServers")]
    pub(crate) mcp_servers: Vec<Value>,
}

/// Parameters for the `session/prompt` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PromptParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    pub(crate) prompt: Vec<Value>,
}

/// Parameters for the `session/cancel` JSON-RPC notification.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct CancelParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
}

/// Parameters for the `session/set_config_option` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SetConfigOptionParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(rename = "configId")]
    pub(crate) config_id: String,
    pub(crate) value: Value,
}

/// Parameters for the `session/set_model` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SetModelParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(rename = "modelId")]
    pub(crate) model_id: String,
}

/// Parameters for the `session/set_mode` JSON-RPC request.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SetModeParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    #[serde(rename = "modeId")]
    pub(crate) mode_id: String,
}

/// Parameters for the `session/delete` JSON-RPC request (SDK 0.22.0 experimental).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DeleteSessionParams {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
}

// ---------------------------------------------------------------------------
// Incoming client request parameter types
// ---------------------------------------------------------------------------

/// Parameters for `fs/read_text_file` client method.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FsReadTextFileParams {
    pub(crate) path: String,
}

/// Parameters for `fs/write_text_file` client method.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FsWriteTextFileParams {
    pub(crate) path: String,
    pub(crate) content: String,
}

/// Parameters for `terminal/create` client method.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TerminalCreateParams {
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
}

/// Parameters for terminal methods that only need a terminal ID.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TerminalIdParams {
    #[serde(rename = "terminalId")]
    pub(crate) terminal_id: String,
}

/// Parameters for `terminal/output` client method.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TerminalOutputParams {
    #[serde(rename = "terminalId")]
    pub(crate) terminal_id: String,
    #[serde(default)]
    pub(crate) content: Option<String>,
    #[serde(default)]
    pub(crate) stream: Option<String>,
}

// ---------------------------------------------------------------------------
// Response result types
// ---------------------------------------------------------------------------

/// Result of `session/new` and `session/load` responses.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionResult {
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub(crate) config_options: Option<Vec<Value>>,
    #[allow(dead_code)]
    #[serde(default)]
    pub(crate) models: Option<Value>,
    #[allow(dead_code)]
    #[serde(default)]
    pub(crate) modes: Option<Value>,
    #[allow(dead_code)]
    #[serde(flatten)]
    pub(crate) extra: std::collections::HashMap<String, Value>,
}

/// Result of `session/prompt` response.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptResult {
    #[serde(default)]
    pub(crate) stop_reason: Option<StopReason>,
    #[allow(dead_code)]
    #[serde(flatten)]
    pub(crate) extra: std::collections::HashMap<String, Value>,
}

/// The ACP protocol version supported by this adapter.
pub const ACP_PROTOCOL_VERSION: u64 = 1;

/// Maximum size for embedded text content (128KB).
pub const MAX_EMBEDDED_TEXT_BYTES: u64 = 128 * 1024;

/// Maximum size for embedded image content (10MB).
pub const MAX_EMBEDDED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Maximum size for embedded audio content (10MB).
pub const MAX_EMBEDDED_AUDIO_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpTextContent {
    #[serde(default)]
    pub(crate) text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpToolContentRef {
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) uri: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpDiffContent {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) path: String,
    #[serde(rename = "newText")]
    pub(crate) new_text: Option<String>,
    #[serde(rename = "oldText")]
    pub(crate) old_text: Option<String>,
}

/// Typed content item in a tool call. Uses untagged deserialization to match
/// the various wire formats sent by different agents.
/// Order matters: more specific variants (with multiple fields) must come first.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum AcpToolContent {
    DiffBlock(AcpDiffContent),
    ContentRef { content: AcpToolContentRef },
    Terminal { #[serde(rename = "terminalId")] terminal_id: String },
    Diff { diff: Value },
    Output { output: String },
    Text { text: String },
}

/// Incremental fields for a `tool_call_update`. All fields are optional —
/// only the fields present on the wire are populated. Follows the ACP SDK
/// pattern where `ToolCallUpdate` carries only changed fields.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallUpdateFields {
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) kind: Option<ToolKind>,
    #[serde(default)]
    pub(crate) status: Option<ToolCallStatus>,
    #[serde(rename = "rawInput", default)]
    pub(crate) raw_input: Option<Value>,
    #[serde(default)]
    pub(crate) input: Option<Value>,
    #[serde(default)]
    pub(crate) content: Option<Vec<AcpToolContent>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "sessionUpdate")]
pub(crate) enum AcpSessionUpdate {
    #[serde(rename = "user_message_chunk")]
    UserMessageChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
    },
    #[serde(rename = "agent_message_chunk")]
    AgentMessageChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
    },
    #[serde(rename = "agent_thought_chunk")]
    AgentThoughtChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "thought")]
    Thought {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "thinking")]
    Thinking {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "plan")]
    Plan {
        #[serde(default)]
        entries: Vec<PlanEntry>,
    },
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(rename = "toolCallId", default)]
        tool_call_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: Option<ToolKind>,
        #[serde(default)]
        status: Option<ToolCallStatus>,
        #[serde(rename = "rawInput", default)]
        raw_input: Option<Value>,
        #[serde(default)]
        input: Option<Value>,
        #[serde(default)]
        content: Option<Vec<AcpToolContent>>,
    },
    #[serde(rename = "tool_call_update")]
    ToolCallUpdate {
        #[serde(rename = "toolCallId", default)]
        tool_call_id: Option<String>,
        #[serde(flatten)]
        fields: ToolCallUpdateFields,
    },
    #[serde(rename = "config_option_update")]
    ConfigOptionUpdate {
        #[serde(rename = "configOptions", default)]
        config_options: Vec<Value>,
    },
    #[serde(rename = "available_commands_update")]
    AvailableCommandsUpdate {
        #[serde(rename = "availableCommands", default)]
        available_commands: Vec<Value>,
    },
    #[serde(rename = "usage_update")]
    UsageUpdate,
}

impl AcpSessionUpdate {
    pub(crate) fn message_text(&self) -> Option<&str> {
        match self {
            Self::UserMessageChunk { content } | Self::AgentMessageChunk { content } => {
                content.as_ref()?.text.as_deref()
            }
            _ => None,
        }
    }

    pub(crate) fn thought_text(&self) -> Option<&str> {
        match self {
            Self::AgentThoughtChunk {
                content,
                description,
                subject,
            }
            | Self::Thought {
                content,
                description,
                subject,
            }
            | Self::Thinking {
                content,
                description,
                subject,
            } => content
                .as_ref()
                .and_then(|v| v.text.as_deref())
                .or(description.as_deref())
                .or(subject.as_deref()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpPermissionOption {
    #[serde(rename = "optionId")]
    pub(crate) option_id: String,
    pub(crate) kind: PermissionOptionKind,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionToolCall {
    #[serde(rename = "toolCallId")]
    pub(crate) tool_call_id: String,
    #[serde(default)]
    pub(crate) kind: Option<ToolKind>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(alias = "rawInput", default)]
    pub(crate) input: Option<Value>,
    #[serde(default)]
    pub(crate) content: Option<Vec<AcpToolContent>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionParams {
    #[serde(rename = "toolCall")]
    pub(crate) tool_call: AcpPermissionToolCall,
    #[serde(default)]
    pub(crate) options: Vec<AcpPermissionOption>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionRequest {
    pub(crate) id: Value,
    pub(crate) params: AcpPermissionParams,
}

// ---------------------------------------------------------------------------
// Internal typed representations for parsing
// ---------------------------------------------------------------------------

/// A single entry in an agent's execution plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PlanEntry {
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) status: PlanEntryStatus,
    #[serde(default)]
    pub(crate) priority: PlanEntryPriority,
    #[serde(flatten)]
    pub(crate) extra: std::collections::HashMap<String, Value>,
}

/// Typed result of extracting content from tool call content items.
/// Used internally by the parser; converted to `Value` at the `RuntimeStreamEvent` boundary.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExtractedToolContent {
    pub(crate) text: String,
    pub(crate) terminal_ids: Vec<String>,
    pub(crate) diffs: Vec<Value>,
    pub(crate) content_items: Vec<AcpToolContent>,
    pub(crate) paths: Vec<String>,
}
