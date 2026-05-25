//! State cache management for conversation runtime.
//!
//! This module encapsulates the three state caches used by Runtime:
//! - `runtime_states`: Conversation runtime state (connection/session/turn phases)
//! - `streaming_messages`: Active streaming message buffers
//! - `terminal_records_cache`: Terminal output cache
//!
//! # Mutex Lock Ordering (CRITICAL)
//!
//! When acquiring multiple mutexes simultaneously, always follow this order:
//! 1. `runtime_states`
//! 2. `streaming_messages`
//! 3. `terminal_records_cache`
//!
//! Violating this order can cause deadlocks.

use std::{collections::HashMap, sync::Arc};

use chrono::Utc;
use parking_lot::Mutex;

use crate::domain::{
    ConnectionPhase, ConversationRuntimeState, ConversationStatus, SessionPhase,
    TerminalRecord, TurnPhase,
};

use super::types::ActiveStreamMessage;

/// Encapsulates the three state caches for conversation runtime.
///
/// Provides template methods for common state update patterns,
/// eliminating repeated code across the runtime module.
#[derive(Clone, Default)]
pub struct StateCache {
    runtime_states: Arc<Mutex<HashMap<String, ConversationRuntimeState>>>,
    streaming_messages: Arc<Mutex<HashMap<String, ActiveStreamMessage>>>,
    terminal_records_cache: Arc<Mutex<HashMap<String, TerminalRecord>>>,
}

impl StateCache {
    pub fn new() -> Self {
        Self {
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            streaming_messages: Arc::new(Mutex::new(HashMap::new())),
            terminal_records_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // === Runtime State Access ===

    /// Get runtime state for a conversation, returning a default if not found.
    pub fn get_runtime_state(
        &self,
        conversation_id: &str,
        is_session_hot: bool,
    ) -> ConversationRuntimeState {
        self.runtime_states
            .lock()
            .get(conversation_id)
            .cloned()
            .unwrap_or_else(|| self.default_runtime_state(is_session_hot))
    }

    /// Check if runtime state exists in cache.
    pub fn has_runtime_state(&self, conversation_id: &str) -> bool {
        self.runtime_states.lock().contains_key(conversation_id)
    }

    /// Set runtime state for a conversation.
    pub fn set_runtime_state(&self, conversation_id: &str, state: ConversationRuntimeState) {
        self.runtime_states.lock().insert(conversation_id.to_string(), state);
    }

    /// Remove runtime state for a conversation.
    pub fn remove_runtime_state(&self, conversation_id: &str) {
        self.runtime_states.lock().remove(conversation_id);
    }

    /// Update runtime state with a closure.
    pub fn update_runtime_state<F>(&self, conversation_id: &str, update: F)
    where
        F: FnOnce(&mut ConversationRuntimeState),
    {
        let mut state = self
            .runtime_states
            .lock()
            .get(conversation_id)
            .cloned()
            .unwrap_or_else(|| self.default_runtime_state(false));
        update(&mut state);
        state.last_transition_at = Utc::now();
        self.runtime_states.lock().insert(conversation_id.to_string(), state);
    }

    /// Derive display status from runtime state.
    pub fn derive_display_status(runtime: &ConversationRuntimeState) -> ConversationStatus {
        match runtime.turn_phase {
            TurnPhase::Cancelling => ConversationStatus::Cancelling,
            TurnPhase::Failed => ConversationStatus::Failed,
            TurnPhase::Running => ConversationStatus::Running,
            TurnPhase::Idle => match runtime.session_phase {
                SessionPhase::Loading => ConversationStatus::Recovering,
                SessionPhase::Hot => ConversationStatus::Connected,
                SessionPhase::Cold => match runtime.connection_phase {
                    ConnectionPhase::Initializing => ConversationStatus::Initializing,
                    ConnectionPhase::Disconnected | ConnectionPhase::Ready => {
                        ConversationStatus::Sleep
                    }
                },
            },
        }
    }

    // === Template Methods for Common State Updates ===

    /// Set state to Hot + Idle (session is active and ready).
    ///
    /// Used after successful turn completion or session recovery.
    pub fn set_hot_idle(&self, conversation_id: &str) -> ConversationRuntimeState {
        let state = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        self.set_runtime_state(conversation_id, state.clone());
        state
    }

    /// Set state to Cold + Idle (session is inactive).
    ///
    /// Used when session is not in memory.
    pub fn set_cold_idle(&self, conversation_id: &str) -> ConversationRuntimeState {
        let state = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Disconnected,
            session_phase: SessionPhase::Cold,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        self.set_runtime_state(conversation_id, state.clone());
        state
    }

    /// Set state to Running (turn is executing).
    ///
    /// Used when starting a turn.
    pub fn set_running(
        &self,
        conversation_id: &str,
        is_hot: bool,
    ) -> ConversationRuntimeState {
        let state = ConversationRuntimeState {
            connection_phase: if is_hot {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            },
            session_phase: if is_hot { SessionPhase::Hot } else { SessionPhase::Loading },
            turn_phase: TurnPhase::Running,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        self.set_runtime_state(conversation_id, state.clone());
        state
    }

    /// Set state to Failed with an error message.
    ///
    /// Used when turn execution fails.
    pub fn set_failed(
        &self,
        conversation_id: &str,
        error: &str,
        is_hot: bool,
    ) -> ConversationRuntimeState {
        let state = ConversationRuntimeState {
            connection_phase: if is_hot {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            },
            session_phase: if is_hot { SessionPhase::Hot } else { SessionPhase::Cold },
            turn_phase: TurnPhase::Failed,
            last_error: Some(error.to_string()),
            last_transition_at: Utc::now(),
        };
        self.set_runtime_state(conversation_id, state.clone());
        state
    }

    /// Set state to Recovering (session is being loaded).
    ///
    /// Used during session recovery.
    pub fn set_recovering(&self, conversation_id: &str) -> ConversationRuntimeState {
        let state = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Disconnected,
            session_phase: SessionPhase::Loading,
            turn_phase: TurnPhase::Running,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        self.set_runtime_state(conversation_id, state.clone());
        state
    }

    /// Clear last error for a conversation.
    pub fn clear_error(&self, conversation_id: &str) {
        self.update_runtime_state(conversation_id, |state| {
            state.last_error = None;
        });
    }

    // === Streaming Messages ===

    /// Get streaming message buffer.
    pub fn get_streaming_message(&self, key: &str) -> Option<ActiveStreamMessage> {
        self.streaming_messages.lock().get(key).cloned()
    }

    /// Set streaming message buffer.
    pub fn set_streaming_message(&self, key: &str, message: ActiveStreamMessage) {
        self.streaming_messages.lock().insert(key.to_string(), message);
    }

    /// Get or create streaming message buffer.
    ///
    /// Returns the existing message or creates a new one using the provided factory.
    /// Also returns whether the message was newly created.
    pub fn get_or_create_streaming_message<F>(
        &self,
        key: &str,
        factory: F,
    ) -> (ActiveStreamMessage, bool)
    where
        F: FnOnce() -> ActiveStreamMessage,
    {
        let mut cache = self.streaming_messages.lock();
        let is_new = !cache.contains_key(key);
        let message = cache.entry(key.to_string()).or_insert_with(factory).clone();
        (message, is_new)
    }

    /// Check if streaming message exists.
    pub fn has_streaming_message(&self, key: &str) -> bool {
        self.streaming_messages.lock().contains_key(key)
    }

    /// Append content to streaming message, returning the updated message.
    pub fn append_streaming_content(&self, key: &str, content: &str) -> Option<ActiveStreamMessage> {
        let mut cache = self.streaming_messages.lock();
        if let Some(msg) = cache.get_mut(key) {
            msg.content.push_str(content);
            Some(msg.clone())
        } else {
            None
        }
    }

    /// Remove streaming message buffer, returning the removed value.
    pub fn remove_streaming_message(&self, key: &str) -> Option<ActiveStreamMessage> {
        self.streaming_messages.lock().remove(key)
    }

    /// Clear all streaming messages for a conversation.
    pub fn clear_streaming_messages_for_conversation(&self, conversation_id: &str) {
        let prefix = format!("{conversation_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
    }

    /// Clear all streaming messages for a turn.
    pub fn clear_streaming_messages_for_turn(&self, conversation_id: &str, turn_id: &str) {
        let prefix = format!("{conversation_id}:{turn_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
    }

    // === Terminal Records ===

    /// Get terminal record.
    pub fn get_terminal_record(&self, key: &str) -> Option<TerminalRecord> {
        self.terminal_records_cache.lock().get(key).cloned()
    }

    /// Set terminal record.
    pub fn set_terminal_record(&self, key: &str, record: TerminalRecord) {
        self.terminal_records_cache.lock().insert(key.to_string(), record);
    }

    /// Update terminal record stdout buffer.
    pub fn append_terminal_stdout(&self, key: &str, content: &str) {
        let mut cache = self.terminal_records_cache.lock();
        if let Some(record) = cache.get_mut(key) {
            record.stdout_buffer.push_str(content);
        }
    }

    /// Update terminal record stderr buffer.
    pub fn append_terminal_stderr(&self, key: &str, content: &str) {
        let mut cache = self.terminal_records_cache.lock();
        if let Some(record) = cache.get_mut(key) {
            record.stderr_buffer.push_str(content);
        }
    }

    /// Clear all terminal records for a conversation.
    pub fn clear_terminal_records_for_conversation(&self, conversation_id: &str) {
        let prefix = format!("{conversation_id}:");
        self.terminal_records_cache
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
    }

    // === Helpers ===

    fn default_runtime_state(&self, is_session_hot: bool) -> ConversationRuntimeState {
        ConversationRuntimeState {
            connection_phase: if is_session_hot {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            },
            session_phase: if is_session_hot { SessionPhase::Hot } else { SessionPhase::Cold },
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_cache_initializes_empty() {
        let cache = StateCache::new();
        assert!(!cache.has_runtime_state("conv_1"));
        assert!(cache.get_streaming_message("conv_1:msg").is_none());
        assert!(cache.get_terminal_record("conv_1:term").is_none());
    }

    #[test]
    fn set_hot_idle_creates_correct_state() {
        let cache = StateCache::new();
        let state = cache.set_hot_idle("conv_1");

        assert_eq!(state.connection_phase, ConnectionPhase::Ready);
        assert_eq!(state.session_phase, SessionPhase::Hot);
        assert_eq!(state.turn_phase, TurnPhase::Idle);
        assert!(state.last_error.is_none());

        assert!(cache.has_runtime_state("conv_1"));
    }

    #[test]
    fn set_running_creates_correct_state() {
        let cache = StateCache::new();

        let hot_state = cache.set_running("conv_hot", true);
        assert_eq!(hot_state.connection_phase, ConnectionPhase::Ready);
        assert_eq!(hot_state.session_phase, SessionPhase::Hot);
        assert_eq!(hot_state.turn_phase, TurnPhase::Running);

        let cold_state = cache.set_running("conv_cold", false);
        assert_eq!(cold_state.connection_phase, ConnectionPhase::Disconnected);
        assert_eq!(cold_state.session_phase, SessionPhase::Loading);
        assert_eq!(cold_state.turn_phase, TurnPhase::Running);
    }

    #[test]
    fn set_failed_records_error() {
        let cache = StateCache::new();
        let state = cache.set_failed("conv_1", "test error", true);

        assert_eq!(state.turn_phase, TurnPhase::Failed);
        assert_eq!(state.last_error, Some("test error".to_string()));
    }

    #[test]
    fn derive_display_status_maps_correctly() {
        let running = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Running,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        assert_eq!(
            StateCache::derive_display_status(&running),
            ConversationStatus::Running
        );

        let hot_idle = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Ready,
            session_phase: SessionPhase::Hot,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        assert_eq!(
            StateCache::derive_display_status(&hot_idle),
            ConversationStatus::Connected
        );

        let loading = ConversationRuntimeState {
            connection_phase: ConnectionPhase::Disconnected,
            session_phase: SessionPhase::Loading,
            turn_phase: TurnPhase::Idle,
            last_error: None,
            last_transition_at: Utc::now(),
        };
        assert_eq!(
            StateCache::derive_display_status(&loading),
            ConversationStatus::Recovering
        );
    }

    #[test]
    fn streaming_messages_are_keyed_by_conversation() {
        let cache = StateCache::new();
        let msg = ActiveStreamMessage {
            id: "msg_1".to_string(),
            role: crate::domain::MessageRole::Agent,
            kind: crate::domain::MessageKind::Text,
            content: "test".to_string(),
            started_at: Utc::now(),
        };

        cache.set_streaming_message("conv_1:msg_1", msg.clone());
        assert!(cache.get_streaming_message("conv_1:msg_1").is_some());

        cache.clear_streaming_messages_for_conversation("conv_1");
        assert!(cache.get_streaming_message("conv_1:msg_1").is_none());
    }

    #[test]
    fn terminal_stdout_is_appended() {
        use serde_json::json;
        let cache = StateCache::new();
        let record = TerminalRecord {
            id: "term_1".to_string(),
            conversation_id: "conv_1".to_string(),
            turn_id: "turn_1".to_string(),
            terminal_id: "term_1".to_string(),
            cwd: "/tmp".to_string(),
            command: "echo".to_string(),
            args_json: json!([]),
            status: crate::domain::TerminalStatus::Running,
            stdout_buffer: String::new(),
            stderr_buffer: String::new(),
            started_at: Utc::now(),
            ended_at: None,
        };

        cache.set_terminal_record("conv_1:term_1", record);
        cache.append_terminal_stdout("conv_1:term_1", "hello");
        cache.append_terminal_stdout("conv_1:term_1", " world");

        let updated = cache.get_terminal_record("conv_1:term_1").unwrap();
        assert_eq!(updated.stdout_buffer, "hello world");
    }
}