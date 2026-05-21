use std::borrow::ToOwned;

use chrono::Utc;
use serde_json::{json, Value};

use crate::agent_adapters::{acp::AcpLiveSession, RuntimeStreamEvent};
use crate::domain::{AgentKind, AgentProfile, AgentSessionBinding, SessionConfigOption};
use crate::runtime::{ManagedSession, Runtime, RuntimeResult};

impl Runtime {
    pub(crate) async fn ensure_live_session(
        &self,
        conversation_id: &str,
        profile: &AgentProfile,
        binding: &AgentSessionBinding,
    ) -> RuntimeResult<ManagedSession> {
        match self.session_runtime(conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => Ok(ManagedSession::Acp(session)),
            ManagedSession::Passive(handle) => {
                if profile.kind != AgentKind::Acp {
                    return Ok(ManagedSession::Passive(handle));
                }

                self.record_lifecycle_event(
                    conversation_id,
                    "ConversationRecoveryStarted",
                    json!({ "remote_session_id": handle.remote_session_id }),
                )?;
                let workspace_id = self.db.get_conversation(conversation_id)?.workspace_id;
                let workspace = self.db.get_workspace(&workspace_id)?;
                let mcp_servers = self.mcp_registry.list_for_workspace(&workspace.id)?;

                match AcpLiveSession::start_loaded(
                    profile,
                    &handle.remote_session_id,
                    &handle.cwd,
                    &mcp_servers,
                )
                .await
                {
                    Ok((session, replay_events)) => {
                        self.consume_replay_events_for_recovery(conversation_id, replay_events)?;
                        let managed = ManagedSession::Acp(session.clone());
                        self.session_manager
                            .insert(conversation_id.to_string(), managed.clone());
                        self.record_lifecycle_event(
                            conversation_id,
                            "ConversationRecoveryCompleted",
                            json!({ "remote_session_id": handle.remote_session_id }),
                        )?;
                        return Ok(managed);
                    }
                    Err(load_err) => {
                        tracing::debug!(
                            "[runtime] start_loaded failed for {}, falling back to start_new: {load_err}",
                            conversation_id,
                        );
                    }
                }

                let (session, startup_events) = AcpLiveSession::start_new(profile, &handle.cwd, &mcp_servers).await?;
                for event in startup_events {
                    let _ = self.apply_stream_event(conversation_id, "startup", event);
                }
                let mut updated_binding = binding.clone();
                updated_binding.remote_session_id = session.handle.remote_session_id.clone();
                updated_binding.load_supported = session.handle.load_supported;
                updated_binding.last_synced_at = Utc::now();
                let _ = self.db.upsert_binding(&updated_binding);
                let managed = ManagedSession::Acp(session.clone());
                self.session_manager
                    .insert(conversation_id.to_string(), managed.clone());
                self.record_lifecycle_event(
                    conversation_id,
                    "ConversationRecoveryFallbackNewSession",
                    json!({ "new_session_id": session.handle.remote_session_id }),
                )?;
                Ok(managed)
            }
        }
    }

    fn consume_replay_events_for_recovery(
        &self,
        conversation_id: &str,
        replay_events: Vec<RuntimeStreamEvent>,
    ) -> RuntimeResult<()> {
        let mut replay_count = 0_u64;
        let mut latest_config_options: Option<Vec<SessionConfigOption>> = None;

        for event in replay_events {
            replay_count += 1;
            if let RuntimeStreamEvent::ConfigOptionsUpdated { config_options } = event {
                latest_config_options = Some(config_options);
            }
        }

        if let Some(mut config_options) = latest_config_options {
            let stored_opts = self.conversation_config_options(conversation_id);
            let stored_model = stored_opts
                .iter()
                .find(|o| o.category.as_deref() == Some("model"))
                .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));
            let stored_mode = stored_opts
                .iter()
                .find(|o| o.category.as_deref() == Some("mode"))
                .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));

            for option in &mut config_options {
                if option.category.as_deref() == Some("model") {
                    if let Some(ref model) = stored_model {
                        let is_available = option
                            .options
                            .as_array()
                            .map(|arr| {
                                arr.iter().any(|o| {
                                    o.get("value").and_then(Value::as_str) == Some(model.as_str())
                                })
                            })
                            .unwrap_or(false);
                        if is_available {
                            option.current_value = Value::String(model.clone());
                        }
                    }
                }
                if option.category.as_deref() == Some("mode") {
                    if let Some(ref mode) = stored_mode {
                        let is_available = option
                            .options
                            .as_array()
                            .map(|arr| {
                                arr.iter().any(|o| {
                                    o.get("value").and_then(Value::as_str) == Some(mode.as_str())
                                })
                            })
                            .unwrap_or(false);
                        if is_available {
                            option.current_value = Value::String(mode.clone());
                        }
                    }
                }
            }

            self.update_snapshot_config_options(conversation_id, config_options)?;
        }

        self.record_lifecycle_event(
            conversation_id,
            "ConversationReplayConsumedDuringRecovery",
            json!({ "replayed_events": replay_count }),
        )?;
        Ok(())
    }
}
