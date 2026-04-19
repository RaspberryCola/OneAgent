use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::domain::{
    MessageKind, MessageProjection, MessageRole, ToolCallProjection, ToolCallStatus,
};
use crate::runtime::{Runtime, RuntimeResult};

fn has_meaningful_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            !trimmed.is_empty()
                && !trimmed.eq_ignore_ascii_case("undefined")
                && !trimmed.eq_ignore_ascii_case("null")
        }
        serde_json::Value::Array(items) => items.iter().any(has_meaningful_json),
        serde_json::Value::Object(map) => map.values().any(has_meaningful_json),
    }
}

fn is_generic_kind(kind: &str) -> bool {
    kind.trim().is_empty() || kind.eq_ignore_ascii_case("other")
}

impl Runtime {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn project_tool_call(
        &self,
        conversation_id: &str,
        turn_id: &str,
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
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        self.finalize_text_stream(conversation_id, turn_id)?;
        let existing = self
            .db
            .get_tool_call_by_tool_call_id(conversation_id, &tool_call_id)?;

        let merged_title = if title.trim().is_empty() {
            existing
                .as_ref()
                .map(|call| call.title.clone())
                .unwrap_or_default()
        } else {
            title
        };

        let merged_kind = if is_generic_kind(&kind) {
            existing
                .as_ref()
                .map(|call| call.kind.clone())
                .filter(|v| !is_generic_kind(v))
                .unwrap_or_else(|| "other".to_string())
        } else {
            kind
        };

        let merged_raw_input = if has_meaningful_json(&raw_input) {
            raw_input
        } else {
            existing
                .as_ref()
                .map(|call| call.raw_input_json.clone())
                .unwrap_or(raw_input)
        };

        let now = Utc::now();
        let call = ToolCallProjection {
            id: format!("{conversation_id}:{tool_call_id}"),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            tool_call_id,
            title: merged_title,
            kind: merged_kind,
            status: match status.as_str() {
                "running" => ToolCallStatus::Running,
                "waiting_permission" => ToolCallStatus::WaitingPermission,
                "completed" => ToolCallStatus::Completed,
                "failed" => ToolCallStatus::Failed,
                "cancelled" => ToolCallStatus::Cancelled,
                _ => ToolCallStatus::Declared,
            },
            raw_input_json: merged_raw_input,
            raw_output_json: raw_output,
            content_json: content,
            diffs_json: diffs.clone(),
            terminal_ids_json: terminal_ids,
            locations_json: locations,
            started_at: existing
                .as_ref()
                .and_then(|call| call.started_at)
                .or(Some(now)),
            ended_at: matches!(status.as_str(), "completed" | "failed" | "cancelled")
                .then_some(now),
        };
        self.db.upsert_tool_call(&call)?;
        if diffs != json!([]) {
            let diff_message = MessageProjection {
                id: Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                turn_id: turn_id.to_string(),
                role: MessageRole::Tool,
                kind: MessageKind::Diff,
                content_json: json!({ "tool_call_id": call.tool_call_id, "diffs": diffs }),
                created_at: Utc::now(),
            };
            self.db.upsert_message(&diff_message)?;
            self.emit(
                "conversation:message_appended",
                &json!({ "conversation_id": conversation_id, "message": diff_message }),
            );
        }
        self.record_lifecycle_event(
            conversation_id,
            "ToolCallUpdated",
            serde_json::to_value(&call).unwrap_or_else(|_| json!({})),
        )?;
        self.emit(
            "conversation:tool_call_changed",
            &json!({ "conversation_id": conversation_id, "tool_call": call }),
        );
        Ok(())
    }
}
