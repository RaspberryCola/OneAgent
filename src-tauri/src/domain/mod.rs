use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub type JsonMap = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Acp,
    Compat,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentLaunchMode {
    Native,
    NpmAdapter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimePreference {
    BundledBun,
    SystemBun,
    SystemNode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentDisplaySource {
    Native,
    Bridge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentAvailability {
    Ready,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationOrigin {
    OneagentManaged,
    AgentDiscovered,
    Imported,
    WorkerTask,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Idle,
    Starting,
    Ready,
    Running,
    Cancelling,
    Cancelled,
    Failed,
    Completed,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionSource {
    Discovered,
    New,
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Agent,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Text,
    Thinking,
    Status,
    Plan,
    Terminal,
    Error,
    Diff,
    Resource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Declared,
    Running,
    WaitingPermission,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingPermissionStatus {
    Pending,
    Resolved,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    User,
    AgentSpecific,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillOwner {
    AgentCommon,
    Opencode,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
    Killed,
    Released,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub cwd: String,
    pub display_name: String,
    pub trusted: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub kind: AgentKind,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: JsonMap,
    #[serde(default = "default_agent_launch_mode")]
    pub launch_mode: AgentLaunchMode,
    #[serde(default)]
    pub runtime_preference: Option<AgentRuntimePreference>,
    #[serde(default)]
    pub package_name: Option<String>,
    #[serde(default)]
    pub package_version: Option<String>,
    #[serde(default = "default_agent_display_source")]
    pub display_source: AgentDisplaySource,
    pub capabilities_cache: serde_json::Value,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub workspace_id: String,
    pub agent_profile_id: String,
    pub origin: ConversationOrigin,
    pub status: ConversationStatus,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_event_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionBinding {
    pub id: String,
    pub conversation_id: String,
    pub adapter_kind: AgentKind,
    pub remote_session_id: String,
    pub cwd: String,
    pub load_supported: bool,
    pub source: AgentSessionSource,
    pub last_synced_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRun {
    pub id: String,
    pub conversation_id: String,
    pub workspace_id: String,
    pub agent_profile_id: String,
    pub goal: String,
    pub status: TaskRunStatus,
    pub result_summary: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageProjection {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub role: MessageRole,
    pub kind: MessageKind,
    pub content_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallProjection {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: String,
    pub status: ToolCallStatus,
    pub raw_input_json: serde_json::Value,
    pub raw_output_json: serde_json::Value,
    pub content_json: serde_json::Value,
    pub diffs_json: serde_json::Value,
    pub terminal_ids_json: serde_json::Value,
    pub locations_json: serde_json::Value,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub id: String,
    pub conversation_id: String,
    pub tool_call_id: String,
    pub scope: String,
    pub fingerprint: String,
    pub decision: PermissionDecisionKind,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermissionRequest {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub fingerprint: String,
    pub options_json: serde_json::Value,
    pub status: PendingPermissionStatus,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub command: String,
    pub args_json: serde_json::Value,
    pub env_json: serde_json::Value,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRecord {
    pub id: String,
    pub scope: SkillScope,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source_dir: String,
    pub owner: SkillOwner,
    pub enabled: bool,
    pub diagnostics_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRecord {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub command: String,
    pub args_json: serde_json::Value,
    pub status: TerminalStatus,
    pub stdout_buffer: String,
    pub stderr_buffer: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEvent {
    pub seq: i64,
    pub conversation_id: String,
    pub event_type: String,
    pub payload_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSnapshot {
    pub conversation_id: String,
    pub snapshot_version: i64,
    pub state_json: serde_json::Value,
    pub event_seq: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConversationFilter {
    pub include_tasks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConversationsInput {
    pub workspace_id: String,
    pub query: String,
    #[serde(default)]
    pub include_tasks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceBootstrapInput {
    pub workspace_id: String,
    pub agent_profile_id: Option<String>,
    pub discovered_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceBootstrap {
    pub workspace: Workspace,
    pub agent_profiles: Vec<AgentProfile>,
    pub conversations: Vec<Conversation>,
    pub discovered_sessions: Vec<ExternalSession>,
    pub mcp: Vec<McpServerConfig>,
    pub skills: Vec<SkillRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalSession {
    pub remote_session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPromptCapabilities {
    pub text: bool,
    pub resource_link: bool,
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionCapabilities {
    pub load: bool,
    pub list: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub option_type: String,
    pub current_value: serde_json::Value,
    pub options: serde_json::Value,
    pub raw: serde_json::Value,
}

/// Available model returned by session/new (unstable API)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpAvailableModel {
    pub id: Option<String>,
    /// OpenCode uses modelId instead of id
    #[serde(alias = "modelId")]
    pub model_id: Option<String>,
    pub name: Option<String>,
}

/// Models info returned by session/new (unstable API)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpSessionModels {
    #[serde(alias = "currentModelId")]
    pub current_model_id: Option<String>,
    #[serde(alias = "availableModels")]
    pub available_models: Option<Vec<AcpAvailableModel>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub protocol_version: String,
    pub agent_info: serde_json::Value,
    pub prompt_capabilities: AgentPromptCapabilities,
    pub session_capabilities: AgentSessionCapabilities,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationState {
    pub conversation: Conversation,
    pub binding: Option<AgentSessionBinding>,
    pub task_run: Option<TaskRun>,
    #[serde(default)]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default)]
    pub models: Option<AcpSessionModels>,
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermissionRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Audio,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentDeliveryPreference {
    Auto,
    ResourceLink,
    Embedded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentInput {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime_type: Option<String>,
    pub kind: AttachmentKind,
    pub delivery_preference: AttachmentDeliveryPreference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertAgentProfileInput {
    pub id: Option<String>,
    pub kind: AgentKind,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: JsonMap,
    #[serde(default = "default_agent_launch_mode")]
    pub launch_mode: AgentLaunchMode,
    #[serde(default)]
    pub runtime_preference: Option<AgentRuntimePreference>,
    #[serde(default)]
    pub package_name: Option<String>,
    #[serde(default)]
    pub package_version: Option<String>,
    #[serde(default = "default_agent_display_source")]
    pub display_source: AgentDisplaySource,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationInput {
    pub workspace_id: String,
    pub agent_profile_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewSessionConfigInput {
    pub workspace_id: String,
    pub agent_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewSessionConfigResult {
    pub config_options: Vec<SessionConfigOption>,
    pub models: Option<AcpSessionModels>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskRunInput {
    pub workspace_id: String,
    pub agent_profile_id: String,
    pub goal: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigInput {
    pub conversation_id: String,
    pub config_id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistAttachmentBlobInput {
    pub name: String,
    pub mime_type: Option<String>,
    pub base64_data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistAttachmentBlobOutput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    // Validation errors
    EmptyMessage,
    EmptyCommand,
    InvalidWorkspacePath,
    InvalidInput,
    // State errors
    ActiveTurnRunning,
    ConversationNotReady,
    MissingBinding,
    // NotFound errors
    WorkspaceNotFound,
    AgentProfileNotFound,
    ConversationNotFound,
    PendingPermissionNotFound,
    // Permission errors
    PermissionNotPending,
    PermissionFingerprintMismatch,
    // Adapter/Runtime errors
    AdapterError,
    RuntimeNotFound,
    AdapterNotFound,
    AdapterSpawnFailed,
    ClaudeAuthRequired,
    AcpInitializeFailed,
    RuntimeError,
    StorageError,
    // Unknown
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl BackendError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: ErrorCode,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(details),
        }
    }
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {}",
            serde_json::to_string(&self.code).unwrap_or_default(),
            self.message
        )
    }
}

impl From<crate::gateway::GatewayError> for BackendError {
    fn from(error: crate::gateway::GatewayError) -> Self {
        match error {
            crate::gateway::GatewayError::Storage(e) => {
                if matches!(e, crate::storage::StorageError::NotFound(_)) {
                    let msg = e.to_string();
                    if msg.contains("workspace") {
                        BackendError::new(ErrorCode::WorkspaceNotFound, msg)
                    } else if msg.contains("agent profile") {
                        BackendError::new(ErrorCode::AgentProfileNotFound, msg)
                    } else if msg.contains("conversation") {
                        BackendError::new(ErrorCode::ConversationNotFound, msg)
                    } else {
                        BackendError::new(ErrorCode::StorageError, msg)
                    }
                } else {
                    BackendError::new(ErrorCode::StorageError, e.to_string())
                }
            }
            crate::gateway::GatewayError::Runtime(e) => match e {
                crate::runtime::RuntimeError::InvalidState(msg) => {
                    if msg.contains("active turn") {
                        BackendError::new(ErrorCode::ActiveTurnRunning, msg)
                    } else if msg.contains("missing binding") {
                        BackendError::new(ErrorCode::MissingBinding, msg)
                    } else if msg.contains("pending permission") && msg.contains("not found") {
                        BackendError::new(ErrorCode::PendingPermissionNotFound, msg)
                    } else if msg.contains("permission") && msg.contains("no longer pending") {
                        BackendError::new(ErrorCode::PermissionNotPending, msg)
                    } else if msg.contains("fingerprint") {
                        BackendError::new(ErrorCode::PermissionFingerprintMismatch, msg)
                    } else {
                        BackendError::new(ErrorCode::ConversationNotReady, msg)
                    }
                }
                crate::runtime::RuntimeError::Adapter(ref adapter_error) => match adapter_error {
                    crate::agent_adapters::AdapterError::RuntimeNotFound(msg) => {
                        BackendError::new(ErrorCode::RuntimeNotFound, msg.clone())
                    }
                    crate::agent_adapters::AdapterError::AdapterNotFound(msg) => {
                        BackendError::new(ErrorCode::AdapterNotFound, msg.clone())
                    }
                    crate::agent_adapters::AdapterError::AdapterSpawnFailed(msg) => {
                        BackendError::new(ErrorCode::AdapterSpawnFailed, msg.clone())
                    }
                    crate::agent_adapters::AdapterError::ClaudeAuthRequired(msg) => {
                        BackendError::new(ErrorCode::ClaudeAuthRequired, msg.clone())
                    }
                    crate::agent_adapters::AdapterError::AcpInitializeFailed(msg) => {
                        BackendError::new(ErrorCode::AcpInitializeFailed, msg.clone())
                    }
                    _ => BackendError::new(ErrorCode::AdapterError, e.to_string()),
                },
                crate::runtime::RuntimeError::Storage(_) => {
                    BackendError::new(ErrorCode::StorageError, e.to_string())
                }
            },
            crate::gateway::GatewayError::Validation(msg) => {
                if msg.contains("cannot be empty") && msg.contains("message") {
                    BackendError::new(ErrorCode::EmptyMessage, msg)
                } else if msg.contains("cannot be empty") && msg.contains("command") {
                    BackendError::new(ErrorCode::EmptyCommand, msg)
                } else if msg.contains("invalid workspace path") {
                    BackendError::new(ErrorCode::InvalidWorkspacePath, msg)
                } else {
                    BackendError::new(ErrorCode::InvalidInput, msg)
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDiscoveryStatus {
    pub name: String,
    pub command: String,
    pub installed: bool,
    pub source: AgentDisplaySource,
    pub availability: AgentAvailability,
    pub detail: Option<String>,
    pub profile_id: Option<String>,
}

fn default_agent_launch_mode() -> AgentLaunchMode {
    AgentLaunchMode::Native
}

fn default_agent_display_source() -> AgentDisplaySource {
    AgentDisplaySource::Native
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineResponse {
    pub events: Vec<RuntimeEvent>,
    pub messages: Vec<MessageProjection>,
    pub tool_calls: Vec<ToolCallProjection>,
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermissionRequest>,
    #[serde(default)]
    pub terminals: Vec<TerminalRecord>,
}
