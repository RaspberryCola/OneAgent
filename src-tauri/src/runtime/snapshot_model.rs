use serde::{Deserialize, Serialize};

use crate::domain::{AcpSessionModeState, AcpSessionModels, ConversationState, SessionConfigOption};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeSnapshotState {
    #[serde(default)]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default)]
    pub models: Option<AcpSessionModels>,
    #[serde(default)]
    pub modes: Option<AcpSessionModeState>,
}

impl RuntimeSnapshotState {
    pub fn from_conversation_state(state: &ConversationState) -> Self {
        Self {
            config_options: state.config_options.clone(),
            models: state.models.clone(),
            modes: state.modes.clone(),
        }
    }

    pub fn from_snapshot_value(value: serde_json::Value) -> Option<Self> {
        let has_runtime_snapshot_shape = value
            .as_object()
            .map(|obj| {
                obj.contains_key("config_options")
                    || obj.contains_key("models")
                    || obj.contains_key("modes")
            })
            .unwrap_or(false);
        if has_runtime_snapshot_shape {
            if let Ok(snapshot) = serde_json::from_value::<RuntimeSnapshotState>(value.clone()) {
                return Some(snapshot);
            }
        }
        // Backward compatibility: historical snapshots stored full ConversationState.
        serde_json::from_value::<ConversationState>(value)
            .ok()
            .map(|state| Self::from_conversation_state(&state))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::RuntimeSnapshotState;
    use crate::domain::{
        AgentKind, AgentSessionBinding, AgentSessionSource, Conversation, ConversationOrigin,
        ConversationRuntimeState, ConversationState, ConversationStatus, ConnectionPhase,
        SessionPhase, SessionConfigOption, TurnPhase,
    };

    fn sample_state() -> ConversationState {
        ConversationState {
            conversation: Conversation {
                id: "conv_1".to_string(),
                workspace_id: "ws_1".to_string(),
                agent_profile_id: "profile_1".to_string(),
                origin: ConversationOrigin::OneagentManaged,
                status: ConversationStatus::Connected,
                title: "test".to_string(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
                last_event_seq: 1,
            },
            runtime: ConversationRuntimeState {
                connection_phase: ConnectionPhase::Ready,
                session_phase: SessionPhase::Hot,
                turn_phase: TurnPhase::Idle,
                last_error: None,
                last_transition_at: Utc::now(),
            },
            binding: Some(AgentSessionBinding {
                id: "binding_1".to_string(),
                conversation_id: "conv_1".to_string(),
                adapter_kind: AgentKind::Acp,
                remote_session_id: "remote".to_string(),
                cwd: "/tmp".to_string(),
                load_supported: true,
                source: AgentSessionSource::New,
                last_synced_at: Utc::now(),
            }),
            task_run: None,
            config_options: vec![SessionConfigOption {
                id: "model".to_string(),
                name: "Model".to_string(),
                description: None,
                category: Some("model".to_string()),
                option_type: "string".to_string(),
                current_value: json!("gpt-x"),
                options: json!([]),
                raw: json!({}),
            }],
            models: None,
            modes: None,
            pending_permissions: vec![],
        }
    }

    #[test]
    fn parses_runtime_snapshot_payload() {
        let payload = json!({
            "config_options": [{"id":"m","name":"M","description":null,"category":"model","option_type":"string","current_value":"a","options":[],"raw":{}}],
            "models": null,
            "modes": null
        });
        let snapshot = RuntimeSnapshotState::from_snapshot_value(payload).unwrap();
        assert_eq!(snapshot.config_options.len(), 1);
    }

    #[test]
    fn parses_legacy_conversation_state_payload() {
        let legacy = serde_json::to_value(sample_state()).unwrap();
        let snapshot = RuntimeSnapshotState::from_snapshot_value(legacy).unwrap();
        assert_eq!(snapshot.config_options.len(), 1);
        assert_eq!(snapshot.config_options[0].id, "model");
    }

    #[test]
    fn returns_none_for_invalid_snapshot_payload() {
        let invalid = json!({"unexpected":"shape"});
        assert!(RuntimeSnapshotState::from_snapshot_value(invalid).is_none());
    }
}
