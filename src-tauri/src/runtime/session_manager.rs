use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::agent_adapters::AgentSessionHandle;
use crate::domain::{
    AgentPromptCapabilities, AgentSessionBinding, SessionConfigOption,
    AcpSessionModels, AcpSessionModeState,
};
use crate::storage::mappers::enum_text;

use super::types::{ManagedSession, RuntimeResult};

/// Manages the lifecycle of in-memory sessions
///
/// Responsible for:
/// - Session pool management (hot sessions)
/// - Fallback handle construction for cold sessions
/// - Session lookup and retrieval
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, ManagedSession>>>,
}

impl SessionManager {
    /// Create a new session manager with an empty session pool
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if a session exists in memory (hot session)
    pub fn is_session_in_memory(&self, conversation_id: &str) -> bool {
        self.sessions.lock().contains_key(conversation_id)
    }

    /// Get a cloned reference to a managed session
    pub fn get(&self, conversation_id: &str) -> Option<ManagedSession> {
        self.sessions.lock().get(conversation_id).cloned()
    }

    /// Insert a new session into the pool
    pub fn insert(&self, conversation_id: String, session: ManagedSession) {
        self.sessions.lock().insert(conversation_id, session);
    }

    /// Remove a session from the pool, returning it if found
    pub fn remove(&self, conversation_id: &str) -> Option<ManagedSession> {
        self.sessions.lock().remove(conversation_id)
    }

    /// Get the session runtime for a conversation
    ///
    /// If the session is hot (in memory), returns it directly.
    /// If the session is cold, constructs a fallback AgentSessionHandle
    /// using the provided closure (lazy evaluation to avoid expensive
    /// DB queries on the hot path).
    pub fn session_runtime(
        &self,
        conversation_id: &str,
        fallback: AgentSessionBinding,
        build_capabilities: impl FnOnce() -> (
            AgentPromptCapabilities,
            Vec<SessionConfigOption>,
            Option<AcpSessionModels>,
            Option<AcpSessionModeState>,
        ),
    ) -> RuntimeResult<ManagedSession> {
        if let Some(session) = self.sessions.lock().get(conversation_id).cloned() {
            return Ok(session);
        }
        // Only build fallback on the cold path — avoids 10+ DB queries for hot sessions
        let (prompt_capabilities, config_options, models, modes) = build_capabilities();
        Ok(ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: enum_text(&fallback.adapter_kind),
            remote_session_id: fallback.remote_session_id,
            cwd: fallback.cwd,
            load_supported: fallback.load_supported,
            prompt_capabilities,
            config_options,
            models,
            modes,
        }))
    }

    /// Get all conversation IDs that have hot sessions
    pub fn hot_session_ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }

    /// Clear all sessions from memory (does not close them)
    pub fn clear(&self) {
        self.sessions.lock().clear();
    }

    /// Returns the number of hot sessions in memory
    pub fn len(&self) -> usize {
        self.sessions.lock().len()
    }

    /// Returns true if no sessions are in memory
    pub fn is_empty(&self) -> bool {
        self.sessions.lock().is_empty()
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Fallback capabilities when snapshot data is unavailable
pub fn default_prompt_capabilities() -> AgentPromptCapabilities {
    AgentPromptCapabilities {
        text: true,
        resource_link: true,
        embedded_context: false,
        image: false,
        audio: false,
    }
}
