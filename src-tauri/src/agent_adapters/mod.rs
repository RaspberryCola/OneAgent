pub mod acp;
pub mod compat;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::domain::{
    AcpSessionModeState, AcpSessionModels, AgentCapabilities, AgentProfile,
    AgentPromptCapabilities, AttachmentInput, ExternalSession, McpServerConfig,
    SessionConfigOption,
};

#[derive(thiserror::Error, Debug)]
pub enum AdapterError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("runtime_not_found: {0}")]
    RuntimeNotFound(String),
    #[error("adapter_not_found: {0}")]
    AdapterNotFound(String),
    #[error("adapter_spawn_failed: {0}")]
    AdapterSpawnFailed(String),
    #[error("claude_auth_required: {0}")]
    ClaudeAuthRequired(String),
    #[error("acp_initialize_failed: {0}")]
    AcpInitializeFailed(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

pub type AdapterResult<T> = Result<T, AdapterError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionHandle {
    pub adapter_kind: String,
    pub remote_session_id: String,
    pub cwd: String,
    pub load_supported: bool,
    #[serde(default = "default_prompt_capabilities")]
    pub prompt_capabilities: AgentPromptCapabilities,
    #[serde(default)]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default)]
    pub models: Option<AcpSessionModels>,
    #[serde(default)]
    pub modes: Option<AcpSessionModeState>,
}

fn default_prompt_capabilities() -> AgentPromptCapabilities {
    AgentPromptCapabilities {
        text: true,
        resource_link: true,
        embedded_context: false,
        image: false,
        audio: false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedSession {
    pub handle: AgentSessionHandle,
    pub replay_events: Vec<RuntimeStreamEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStreamEvent {
    StateChanged {
        status: String,
    },
    ThinkingChunk {
        turn_id: String,
        content: String,
    },
    ThinkingComplete {
        turn_id: String,
    },
    MessageChunk {
        turn_id: String,
        role: String,
        content: String,
    },
    MessageComplete {
        turn_id: String,
        role: String,
        content: String,
    },
    Plan {
        turn_id: String,
        entries: serde_json::Value,
    },
    ToolCall {
        turn_id: String,
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        raw_input: serde_json::Value,
        raw_output: serde_json::Value,
        content: serde_json::Value,
        diffs: serde_json::Value,
        terminal_ids: serde_json::Value,
        locations: serde_json::Value,
    },
    PermissionRequest {
        turn_id: String,
        tool_call_id: String,
        tool_kind: String,
        title: String,
        raw_input: serde_json::Value,
        paths: Vec<String>,
        options: serde_json::Value,
    },
    TerminalEvent {
        turn_id: String,
        terminal_id: String,
        event: String,
        cwd: Option<String>,
        command: Option<String>,
        args: serde_json::Value,
        stream: Option<String>,
        content: Option<String>,
        exit_code: Option<i64>,
    },
    ConfigOptionsUpdated {
        config_options: Vec<SessionConfigOption>,
    },
    Error {
        message: String,
    },
    TurnFinished {
        turn_id: String,
    },
}

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    async fn initialize(&self, profile: &AgentProfile) -> AdapterResult<AgentCapabilities>;
    async fn list_sessions(
        &self,
        profile: &AgentProfile,
        cwd: Option<&str>,
    ) -> AdapterResult<Vec<ExternalSession>>;
    async fn new_session(
        &self,
        profile: &AgentProfile,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<AgentSessionHandle>;
    async fn load_session(
        &self,
        profile: &AgentProfile,
        remote_session_id: &str,
        cwd: &str,
        mcp_servers: &[McpServerConfig],
    ) -> AdapterResult<LoadedSession>;
    async fn prompt(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        input: &str,
        attachments: &[AttachmentInput],
    ) -> AdapterResult<Vec<RuntimeStreamEvent>>;
    async fn cancel(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
    ) -> AdapterResult<()>;
    async fn set_config_option(
        &self,
        profile: &AgentProfile,
        handle: &AgentSessionHandle,
        config_id: &str,
        value: &serde_json::Value,
    ) -> AdapterResult<Vec<SessionConfigOption>>;
    async fn close(&self, profile: &AgentProfile, handle: &AgentSessionHandle)
        -> AdapterResult<()>;
}
