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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_adapters::AgentSessionHandle;
    use crate::domain::{AgentKind, AgentSessionBinding, AgentSessionSource};

    fn create_test_binding() -> AgentSessionBinding {
        AgentSessionBinding {
            id: "binding_1".to_string(),
            conversation_id: "conv_1".to_string(),
            adapter_kind: AgentKind::Acp,
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            source: AgentSessionSource::New,
            last_synced_at: chrono::Utc::now(),
        }
    }

    fn create_test_capabilities() -> (
        AgentPromptCapabilities,
        Vec<SessionConfigOption>,
        Option<crate::domain::AcpSessionModels>,
        Option<crate::domain::AcpSessionModeState>,
    ) {
        (
            default_prompt_capabilities(),
            vec![],
            None,
            None,
        )
    }

    #[test]
    fn new_session_manager_is_empty() {
        let manager = SessionManager::new();
        assert!(manager.is_empty());
        assert_eq!(manager.len(), 0);
    }

    #[test]
    fn inserts_and_retrieves_session() {
        let manager = SessionManager::new();
        let session = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });

        manager.insert("conv_1".to_string(), session.clone());

        assert!(manager.is_session_in_memory("conv_1"));
        assert_eq!(manager.len(), 1);

        let retrieved = manager.get("conv_1");
        assert!(retrieved.is_some());
    }

    #[test]
    fn removes_session() {
        let manager = SessionManager::new();
        let session = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });

        manager.insert("conv_1".to_string(), session);
        let removed = manager.remove("conv_1");

        assert!(removed.is_some());
        assert!(!manager.is_session_in_memory("conv_1"));
        assert_eq!(manager.len(), 0);
    }

    #[test]
    fn returns_none_for_unknown_session() {
        let manager = SessionManager::new();
        assert!(manager.get("unknown").is_none());
        assert!(!manager.is_session_in_memory("unknown"));
    }

    #[test]
    fn hot_session_ids_returns_all_ids() {
        let manager = SessionManager::new();
        let session1 = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });
        let session2 = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_2".to_string(),
            cwd: "/home".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });

        manager.insert("conv_1".to_string(), session1);
        manager.insert("conv_2".to_string(), session2);

        let ids = manager.hot_session_ids();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"conv_1".to_string()));
        assert!(ids.contains(&"conv_2".to_string()));
    }

    #[test]
    fn clears_all_sessions() {
        let manager = SessionManager::new();
        let session = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });

        manager.insert("conv_1".to_string(), session);
        manager.clear();

        assert!(manager.is_empty());
        assert_eq!(manager.len(), 0);
    }

    #[test]
    fn session_runtime_returns_hot_session_directly() {
        let manager = SessionManager::new();
        let session = ManagedSession::Passive(AgentSessionHandle {
            adapter_kind: "acp".to_string(),
            remote_session_id: "session_1".to_string(),
            cwd: "/tmp".to_string(),
            load_supported: true,
            prompt_capabilities: default_prompt_capabilities(),
            config_options: vec![],
            models: None,
            modes: None,
        });

        manager.insert("conv_1".to_string(), session.clone());

        let binding = create_test_binding();
        let result = manager.session_runtime("conv_1", binding, create_test_capabilities);

        assert!(result.is_ok());
    }

    #[test]
    fn session_runtime_builds_fallback_for_cold_session() {
        let manager = SessionManager::new();
        let binding = create_test_binding();

        // Session not in memory, should build fallback
        let result = manager.session_runtime("conv_1", binding, create_test_capabilities);

        assert!(result.is_ok());
        // Verify fallback was built (session still not in memory)
        assert!(!manager.is_session_in_memory("conv_1"));
    }
}
