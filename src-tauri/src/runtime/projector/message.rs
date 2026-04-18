use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::domain::{MessageKind, MessageProjection, MessageRole, TaskRunStatus};
use crate::runtime::{Runtime, RuntimeResult};

impl Runtime {
    pub(crate) fn project_thinking_chunk(
        &self,
        conversation_id: &str,
        turn_id: &str,
        content: String,
    ) -> RuntimeResult<()> {
        let stream_key = Self::stream_message_key(
            conversation_id,
            turn_id,
            &MessageRole::System,
            &MessageKind::Thinking,
        );
        let mut stream_messages = self.streaming_messages.lock();
        if !stream_messages.contains_key(&stream_key) {
            drop(stream_messages);
            self.finalize_text_stream(conversation_id, turn_id)?;
            stream_messages = self.streaming_messages.lock();
        }
        let active = stream_messages
            .entry(stream_key)
            .or_insert_with(|| crate::runtime::ActiveStreamMessage {
                id: Uuid::new_v4().to_string(),
                role: MessageRole::System,
                kind: MessageKind::Thinking,
                content: String::new(),
                started_at: Utc::now(),
            });
        active.content.push_str(&content);
        let message = MessageProjection {
            id: active.id.clone(),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: active.role.clone(),
            kind: active.kind.clone(),
            content_json: json!({
                "text": active.content,
                "status": "thinking",
                "stream": true,
                "duration_ms": serde_json::Value::Null,
            }),
            created_at: active.started_at,
        };
        let is_new_stream = !self
            .db
            .list_messages(conversation_id)?
            .iter()
            .any(|existing| existing.id == message.id);
        drop(stream_messages);
        self.db.upsert_message(&message)?;
        self.emit(
            if is_new_stream {
                "conversation:message_appended"
            } else {
                "conversation:message_updated"
            },
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    pub(crate) fn project_message_chunk(
        &self,
        conversation_id: &str,
        turn_id: &str,
        role: String,
        content: String,
    ) -> RuntimeResult<()> {
        if role == "user" && !turn_id.starts_with("history-") {
            return Ok(());
        }
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let message_role = Self::role_from_stream(&role);
        let stream_key = Self::stream_message_key(
            conversation_id,
            turn_id,
            &message_role,
            &MessageKind::Text,
        );
        let mut stream_messages = self.streaming_messages.lock();
        let active = stream_messages
            .entry(stream_key)
            .or_insert_with(|| crate::runtime::ActiveStreamMessage {
                id: Uuid::new_v4().to_string(),
                role: message_role.clone(),
                kind: MessageKind::Text,
                content: String::new(),
                started_at: Utc::now(),
            });
        active.content.push_str(&content);
        let message = MessageProjection {
            id: active.id.clone(),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: active.role.clone(),
            kind: active.kind.clone(),
            content_json: json!({ "text": active.content, "stream": true }),
            created_at: active.started_at,
        };
        let is_new_stream = !self
            .db
            .list_messages(conversation_id)?
            .iter()
            .any(|existing| existing.id == message.id);
        drop(stream_messages);
        self.db.upsert_message(&message)?;
        self.record_lifecycle_event(
            conversation_id,
            "AgentMessageChunkReceived",
            serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
        )?;
        let event_name = if is_new_stream {
            "conversation:message_appended"
        } else {
            "conversation:message_updated"
        };
        self.emit(
            event_name,
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    pub(crate) fn project_message_complete(
        &self,
        conversation_id: &str,
        turn_id: &str,
        role: String,
        content: String,
    ) -> RuntimeResult<()> {
        if role == "user" && !turn_id.starts_with("history-") {
            return Ok(());
        }
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let message_role = Self::role_from_stream(&role);
        let stream_key = Self::stream_message_key(
            conversation_id,
            turn_id,
            &message_role,
            &MessageKind::Text,
        );
        let active = self.streaming_messages.lock().remove(&stream_key);
        let message = MessageProjection {
            id: active
                .as_ref()
                .map(|stream| stream.id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: message_role,
            kind: MessageKind::Text,
            content_json: json!({ "text": content, "stream": false }),
            created_at: active
                .as_ref()
                .map(|stream| stream.started_at)
                .unwrap_or_else(Utc::now),
        };
        self.db.upsert_message(&message)?;
        self.record_lifecycle_event(
            conversation_id,
            "AgentMessageCompleted",
            serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
        )?;
        self.emit(
            if active.is_some() {
                "conversation:message_updated"
            } else {
                "conversation:message_appended"
            },
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    pub(crate) fn project_plan(
        &self,
        conversation_id: &str,
        turn_id: &str,
        entries: serde_json::Value,
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let message = MessageProjection {
            id: format!("{conversation_id}:{turn_id}:plan"),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: MessageRole::System,
            kind: MessageKind::Plan,
            content_json: json!({ "entries": entries }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&message)?;
        self.record_lifecycle_event(
            conversation_id,
            "AgentPlanUpdated",
            serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
        )?;
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }

    pub(crate) fn project_error(
        &self,
        conversation_id: &str,
        turn_id: &str,
        message: String,
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let prefix = format!("{conversation_id}:{turn_id}:");
        self.streaming_messages
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
        let message = MessageProjection {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            role: MessageRole::System,
            kind: MessageKind::Error,
            content_json: json!({ "message": message }),
            created_at: Utc::now(),
        };
        self.db.upsert_message(&message)?;
        self.record_lifecycle_event(
            conversation_id,
            "TurnFailed",
            serde_json::to_value(&message).unwrap_or_else(|_| json!({})),
        )?;
        if self.db.get_task_run(conversation_id)?.is_some() {
            self.db
                .update_task_run(conversation_id, TaskRunStatus::Failed, None)?;
            self.emit(
                "task_run:state_changed",
                &json!({ "conversation_id": conversation_id, "task_run": self.db.get_task_run(conversation_id)? }),
            );
        }
        self.emit(
            "conversation:message_appended",
            &json!({ "conversation_id": conversation_id, "message": message }),
        );
        Ok(())
    }
}
