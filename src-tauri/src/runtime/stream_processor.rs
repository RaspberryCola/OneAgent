use super::enum_text;
use chrono::Utc;
use serde_json::json;

use crate::agent_adapters::RuntimeStreamEvent;
use crate::domain::{
    ConnectionPhase, MessageKind, MessageProjection, MessageRole, SessionConfigOption,
    SessionPhase, TurnPhase,
};
use crate::runtime::{Runtime, RuntimeResult};
use crate::storage::StorageResult;

impl Runtime {
    pub(crate) fn stream_message_key(
        conversation_id: &str,
        turn_id: &str,
        role: &MessageRole,
        kind: &MessageKind,
    ) -> String {
        format!(
            "{conversation_id}:{turn_id}:{}:{}",
            enum_text(role),
            enum_text(kind)
        )
    }

    pub(crate) fn role_from_stream(role: &str) -> MessageRole {
        if role == "agent" {
            MessageRole::Agent
        } else if role == "user" {
            MessageRole::User
        } else {
            MessageRole::System
        }
    }

    pub(crate) fn finalize_thinking_stream(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> RuntimeResult<()> {
        let stream_key = Self::stream_message_key(
            conversation_id,
            turn_id,
            &MessageRole::System,
            &MessageKind::Thinking,
        );
        let active = self.streaming_messages.lock().remove(&stream_key);
        let Some(active) = active else {
            return Ok(());
        };

        let duration_ms = (Utc::now() - active.started_at).num_milliseconds().max(0);
        let message = MessageProjection {
            id: active.id,
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: MessageRole::System,
            kind: MessageKind::Thinking,
            content_json: json!({
                "text": active.content,
                "status": "done",
                "stream": false,
                "duration_ms": duration_ms,
            }),
            created_at: active.started_at,
        };
        self.db.upsert_message(&message)?;
        self.emit(
            "conversation:message_updated",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    pub(crate) fn finalize_text_stream(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> RuntimeResult<()> {
        for role in [MessageRole::Agent, MessageRole::User] {
            let stream_key =
                Self::stream_message_key(conversation_id, turn_id, &role, &MessageKind::Text);
            let active = self.streaming_messages.lock().remove(&stream_key);
            if let Some(active) = active {
                let message = MessageProjection {
                    id: active.id,
                    conversation_id: conversation_id.to_string(),
                    turn_id: turn_id.to_string(),
                    role: active.role.clone(),
                    kind: MessageKind::Text,
                    content_json: json!({ "text": active.content, "stream": false }),
                    created_at: active.started_at,
                };
                self.db.upsert_message(&message)?;
                self.emit(
                    "conversation:message_updated",
                    &json!({ "conversation_id": conversation_id, "message": message }),
                );
            }
        }
        Ok(())
    }

    fn process_state_changed(
        &self,
        conversation_id: &str,
        turn_id: &str,
        status: String,
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        if status == "running" {
            self.update_runtime_state(conversation_id, |runtime| {
                runtime.connection_phase = ConnectionPhase::Ready;
                runtime.session_phase = if self.is_session_in_memory(conversation_id) {
                    SessionPhase::Hot
                } else {
                    SessionPhase::Cold
                };
                runtime.turn_phase = TurnPhase::Running;
                runtime.last_error = None;
            })?;
        }
        self.record_lifecycle_event(
            conversation_id,
            "ConversationStateChanged",
            json!({ "status": status }),
        )?;
        self.emit(
            "conversation:state_changed",
            &json!({ "conversation_id": conversation_id, "state": self.conversation_state(conversation_id)? }),
        );
        Ok(())
    }

    fn process_turn_finished(&self, conversation_id: &str, turn_id: &str) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let prefix = format!("{conversation_id}:{turn_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
        self.record_lifecycle_event(
            conversation_id,
            "TurnCompleted",
            json!({ "turn_id": turn_id }),
        )?;
        self.emit(
            "conversation:turn_finished",
            &json!({ "conversation_id": conversation_id, "turn_id": turn_id, "status": "completed" }),
        );
        Ok(())
    }

    fn process_config_options_updated(
        &self,
        conversation_id: &str,
        config_options: Vec<SessionConfigOption>,
    ) -> RuntimeResult<()> {
        self.update_snapshot_config_options(conversation_id, config_options.clone())?;
        self.emit(
            "conversation:config_updated",
            &json!({ "conversation_id": conversation_id, "config_options": config_options }),
        );
        Ok(())
    }

    pub(crate) fn apply_stream_event(
        &self,
        conversation_id: &str,
        turn_id: &str,
        event: RuntimeStreamEvent,
    ) -> RuntimeResult<()> {
        match event {
            RuntimeStreamEvent::StateChanged { status } => {
                self.process_state_changed(conversation_id, turn_id, status)?;
            }
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                self.project_thinking_chunk(conversation_id, turn_id, content)?;
            }
            RuntimeStreamEvent::ThinkingComplete { .. } => {
                self.finalize_thinking_stream(conversation_id, turn_id)?;
            }
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                self.project_message_chunk(conversation_id, turn_id, role, content)?;
            }
            RuntimeStreamEvent::MessageComplete { role, content, .. } => {
                self.project_message_complete(conversation_id, turn_id, role, content)?;
            }
            RuntimeStreamEvent::Plan { entries, .. } => {
                self.project_plan(conversation_id, turn_id, entries)?;
            }
            RuntimeStreamEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                raw_output,
                content,
                diffs,
                terminal_ids,
                locations,
                ..
            } => {
                self.project_tool_call(
                    conversation_id,
                    turn_id,
                    tool_call_id,
                    title,
                    kind,
                    status,
                    raw_input,
                    raw_output,
                    content,
                    diffs,
                    terminal_ids,
                    locations,
                )?;
            }
            RuntimeStreamEvent::PermissionRequest {
                tool_call_id,
                tool_kind,
                title,
                raw_input,
                paths,
                options,
                ..
            } => {
                self.project_permission_request(
                    conversation_id,
                    turn_id,
                    tool_call_id,
                    tool_kind,
                    title,
                    raw_input,
                    paths,
                    options,
                )?;
            }
            RuntimeStreamEvent::TerminalEvent {
                terminal_id,
                event,
                cwd,
                command,
                args,
                stream,
                content,
                exit_code,
                ..
            } => {
                self.project_terminal_event(
                    conversation_id,
                    turn_id,
                    terminal_id,
                    event,
                    cwd,
                    command,
                    args,
                    stream,
                    content,
                    exit_code,
                )?;
            }
            RuntimeStreamEvent::Error { message } => {
                self.project_error(conversation_id, turn_id, message)?;
            }
            RuntimeStreamEvent::TurnFinished { .. } => {
                self.process_turn_finished(conversation_id, turn_id)?;
            }
            RuntimeStreamEvent::ConfigOptionsUpdated { config_options } => {
                self.process_config_options_updated(conversation_id, config_options)?;
            }
        }
        Ok(())
    }

    pub(crate) fn record_lifecycle_event(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: serde_json::Value,
    ) -> StorageResult<()> {
        self.db
            .append_event(conversation_id, event_type, &payload)?;
        Ok(())
    }
}
