//! Turn execution engine for conversations.
//!
//! This module contains methods for executing and canceling turns,
//! including the turn task runner and error handling.

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::domain::*;

use super::{
    snapshot_model::RuntimeSnapshotState,
    state_cache::StateCache,
    ManagedSession, RuntimeError, RuntimeResult,
};

impl super::Runtime {
    /// Sends a user message and starts a turn execution.
    pub async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
        attachments: Vec<AttachmentInput>,
    ) -> RuntimeResult<TimelineResponse> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let current_runtime = self.runtime_state(conversation_id);
        if matches!(
            current_runtime.turn_phase,
            TurnPhase::Running | TurnPhase::Cancelling
        ) {
            return Err(RuntimeError::ActiveTurnRunning);
        }
        let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
        let binding = self.db.get_binding(conversation_id)?.ok_or_else(|| RuntimeError::MissingBinding)?;

        let is_hot = self.is_session_in_memory(conversation_id);
        self.update_runtime_state(conversation_id, |runtime| {
            runtime.last_error = None;
            runtime.turn_phase = TurnPhase::Running;
            if is_hot {
                runtime.connection_phase = ConnectionPhase::Ready;
                runtime.session_phase = SessionPhase::Hot;
            } else {
                runtime.connection_phase = ConnectionPhase::Disconnected;
                runtime.session_phase = SessionPhase::Loading;
            }
        })?;
        let turn_id = Uuid::new_v4().to_string();
        self.record_lifecycle_event(
            conversation_id,
            "TurnStarted",
            json!({ "turn_id": turn_id }),
        )?;
        let user_message = MessageProjection {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.clone(),
            role: MessageRole::User,
            kind: MessageKind::Text,
            content_json: json!({
                "text": text,
                "attachments": attachments
            }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&user_message)?;
        self.record_lifecycle_event(
            conversation_id,
            "UserMessageAccepted",
            serde_json::to_value(&user_message).unwrap_or_else(|_| json!({})),
        )?;
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": user_message }),
        );
        self.emit_conversation_state(conversation_id)?;
        let timeline = self.timeline(conversation_id)?;

        let runtime = self.clone();
        let conversation_id_owned = conversation_id.to_string();
        let turn_id_for_task = turn_id.clone();
        let text_owned = text.to_string();
        tokio::spawn(async move {
            if let Err(error) = runtime
                .run_turn_task(
                    conversation_id_owned.clone(),
                    turn_id_for_task,
                    profile,
                    binding,
                    text_owned,
                    attachments,
                )
                .await
            {
                let _ = runtime
                    .handle_turn_task_error(&conversation_id_owned, &error)
                    .await;
            }
        });

        Ok(timeline)
    }

    /// Runs the turn task (internal implementation).
    async fn run_turn_task(
        &self,
        conversation_id: String,
        turn_id: String,
        profile: AgentProfile,
        binding: AgentSessionBinding,
        text: String,
        attachments: Vec<AttachmentInput>,
    ) -> RuntimeResult<()> {
        let was_cold = !self.is_session_in_memory(&conversation_id);
        if was_cold {
            self.update_runtime_state(&conversation_id, |runtime| {
                runtime.connection_phase = ConnectionPhase::Disconnected;
                runtime.session_phase = SessionPhase::Loading;
                runtime.turn_phase = TurnPhase::Running;
                runtime.last_error = None;
            })?;
            self.emit_conversation_state(&conversation_id)?;
        }

        let session = self
            .ensure_live_session(&conversation_id, &profile, &binding)
            .await?;
        let keep_hot_session = matches!(session, ManagedSession::Acp(_));
        self.update_runtime_state(&conversation_id, |runtime| {
            runtime.connection_phase = ConnectionPhase::Ready;
            runtime.session_phase = SessionPhase::Hot;
            runtime.turn_phase = TurnPhase::Running;
            runtime.last_error = None;
        })?;
        self.emit_conversation_state(&conversation_id)?;

        match session {
            ManagedSession::Acp(ref session) if was_cold => {
                let stored_model = self
                    .conversation_config_options(&conversation_id)
                    .into_iter()
                    .find(|o| o.category.as_deref() == Some("model"))
                    .and_then(|o| o.current_value.as_str().map(ToOwned::to_owned));
                if let Some(model_id) = stored_model {
                    let _ = session.set_model(&model_id).await;
                }
            }
            _ => {}
        }

        match session {
            ManagedSession::Acp(session) => {
                let (mut event_rx, mut completion_rx) =
                    session.run_turn(&text, &attachments).await?;
                loop {
                    tokio::select! {
                        maybe_event = event_rx.recv() => {
                            if let Some(event) = maybe_event {
                                self.apply_stream_event(&conversation_id, &turn_id, event)?;
                            }
                        }
                        result = &mut completion_rx => {
                            result.map_err(|_| RuntimeError::PromptCompletionChannelDropped)??;
                            while let Ok(event) = event_rx.try_recv() {
                                self.apply_stream_event(&conversation_id, &turn_id, event)?;
                            }
                            break;
                        }
                    }
                }
            }
            ManagedSession::Passive(handle) => {
                let stream = self
                    .adapter_for(&profile)
                    .prompt(&profile, &handle, &text, &attachments)
                    .await?;
                for event in stream {
                    self.apply_stream_event(&conversation_id, &turn_id, event)?;
                }
            }
        }

        let is_hot_now = keep_hot_session || self.is_session_in_memory(&conversation_id);
        self.update_runtime_state(&conversation_id, |runtime| {
            runtime.connection_phase = if is_hot_now {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            };
            runtime.session_phase = if is_hot_now {
                SessionPhase::Hot
            } else {
                SessionPhase::Cold
            };
            runtime.turn_phase = TurnPhase::Idle;
        })?;
        let state = self.conversation_state(&conversation_id)?;
        self.db.replace_snapshot(
            &conversation_id,
            1,
            &serde_json::to_value(RuntimeSnapshotState::from_conversation_state(&state))
                .unwrap_or_else(|_| json!({})),
            self.db.get_conversation(&conversation_id)?.last_event_seq,
        )?;
        if let Some(task_run) = self.db.get_task_run(&conversation_id)? {
            let status = self.db.get_conversation(&conversation_id)?.status;
            let summary = self.summarize_task_from_storage(&conversation_id, &status)?;
            self.db.update_task_run(
                &task_run.conversation_id,
                TaskRunStatus::Completed,
                summary.as_deref(),
            )?;
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": task_run.conversation_id, "task_run": self.db.get_task_run(&task_run.conversation_id)? }),
            );
        }
        self.emit_conversation_state(&conversation_id)?;
        Ok(())
    }

    /// Handles errors from turn task execution.
    async fn handle_turn_task_error(
        &self,
        conversation_id: &str,
        error: &RuntimeError,
    ) -> RuntimeResult<()> {
        let is_hot = self.is_session_in_memory(conversation_id);
        self.update_runtime_state(conversation_id, |runtime| {
            runtime.connection_phase = if is_hot {
                ConnectionPhase::Ready
            } else {
                ConnectionPhase::Disconnected
            };
            runtime.session_phase = if is_hot {
                SessionPhase::Hot
            } else {
                SessionPhase::Cold
            };
            runtime.turn_phase = TurnPhase::Failed;
            runtime.last_error = Some(error.to_string());
        })?;
        let message = MessageProjection {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: Uuid::new_v4().to_string(),
            role: MessageRole::System,
            kind: MessageKind::Error,
            content_json: json!({ "message": error.to_string() }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&message)?;
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        self.emit_conversation_state(conversation_id)?;
        Ok(())
    }

    /// Cancels an ongoing turn.
    pub async fn cancel_turn(&self, conversation_id: &str) -> RuntimeResult<()> {
        let conversation = self.db.get_conversation(conversation_id)?;
        let profile = self.db.get_agent_profile(&conversation.agent_profile_id)?;
        let binding = self
            .db
            .get_binding(conversation_id)?
            .ok_or_else(|| RuntimeError::MissingBinding)?;

        match self.session_runtime(conversation_id, binding.clone())? {
            ManagedSession::Acp(session) => session.cancel().await?,
            ManagedSession::Passive(handle) => {
                self.adapter_for(&profile).cancel(&profile, &handle).await?;
            }
        }
        self.state_cache.clear_streaming_messages_for_conversation(conversation_id);
        self.state_cache.clear_terminal_records_for_conversation(conversation_id);

        let is_hot = self.is_session_in_memory(conversation_id);
        let mut runtime = self.runtime_state(conversation_id);
        runtime.connection_phase = if is_hot {
            ConnectionPhase::Ready
        } else {
            ConnectionPhase::Disconnected
        };
        runtime.session_phase = if is_hot {
            SessionPhase::Hot
        } else {
            SessionPhase::Cold
        };
        runtime.turn_phase = TurnPhase::Idle;
        runtime.last_error = None;
        let final_status = StateCache::derive_display_status(&runtime);

        if let Some(task_run) = self.db.cancel_turn_atomic(conversation_id, &final_status)? {
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": conversation_id, "task_run": task_run }),
            );
        }

        self.set_runtime_state(conversation_id, runtime)?;
        self.emit(
            "conversation:turn_finished",
            &json!({ "conversation_id": conversation_id, "turn_id": serde_json::Value::Null, "status": "cancelled" }),
        );
        self.emit_conversation_state(conversation_id)?;
        Ok(())
    }
}