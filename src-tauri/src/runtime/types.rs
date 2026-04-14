use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::agent_adapters::{acp::AcpLiveSession, AgentSessionHandle};

/// Event emitter type for sending events to the frontend
pub type EventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Errors that can occur in the runtime
#[derive(thiserror::Error, Debug)]
pub enum RuntimeError {
    #[error("storage error: {0}")]
    Storage(#[from] crate::storage::StorageError),
    #[error("adapter error: {0}")]
    Adapter(#[from] crate::agent_adapters::AdapterError),
    #[error("invalid state: {0}")]
    InvalidState(String),
}

/// Result type for runtime operations
pub type RuntimeResult<T> = Result<T, RuntimeError>;

/// A managed session representing either an active ACP session or a passive handle
#[derive(Clone)]
pub enum ManagedSession {
    /// Active ACP live session with streaming support
    Acp(AcpLiveSession),
    /// Passive session handle for non-ACP adapters
    Passive(AgentSessionHandle),
}

/// Represents an active streaming message being built chunk by chunk
#[derive(Clone)]
pub struct ActiveStreamMessage {
    pub id: String,
    pub role: crate::domain::MessageRole,
    pub kind: crate::domain::MessageKind,
    pub content: String,
    pub started_at: DateTime<Utc>,
}

impl ActiveStreamMessage {
    pub fn new(
        id: String,
        role: crate::domain::MessageRole,
        kind: crate::domain::MessageKind,
        content: String,
        started_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            role,
            kind,
            content,
            started_at,
        }
    }
}
