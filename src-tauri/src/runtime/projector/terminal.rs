use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::domain::{MessageKind, MessageProjection, MessageRole, TerminalRecord, TerminalStatus};
use crate::runtime::{Runtime, RuntimeResult};

impl Runtime {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn project_terminal_event(
        &self,
        conversation_id: &str,
        turn_id: &str,
        terminal_id: String,
        event: String,
        cwd: Option<String>,
        command: Option<String>,
        args: serde_json::Value,
        stream: Option<String>,
        content: Option<String>,
        exit_code: Option<i64>,
    ) -> RuntimeResult<()> {
        self.finalize_thinking_stream(conversation_id, turn_id)?;
        let cache_key = format!("{conversation_id}:{terminal_id}");
        let cached_record = self.state_cache.get_terminal_record(&cache_key);
        let mut record = if let Some(cached) = cached_record {
            cached
        } else {
            let existing = self
                .db
                .get_terminal_by_remote_id(conversation_id, &terminal_id)?;
            let loaded = existing.unwrap_or(TerminalRecord {
                id: Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                turn_id: turn_id.to_string(),
                terminal_id: terminal_id.clone(),
                cwd: cwd.clone().unwrap_or_default(),
                command: command.clone().unwrap_or_default(),
                args_json: args.clone(),
                status: TerminalStatus::Running,
                stdout_buffer: String::new(),
                stderr_buffer: String::new(),
                started_at: Utc::now(),
                ended_at: None,
            });
            self.state_cache.set_terminal_record(&cache_key, loaded.clone());
            loaded
        };
        if let Some(cwd) = cwd {
            record.cwd = cwd;
        }
        if let Some(command) = command {
            record.command = command;
        }
        if args != json!([]) {
            record.args_json = args.clone();
        }
        if let Some(stream_name) = stream.clone() {
            if let Some(chunk) = content.clone() {
                if stream_name == "stderr" {
                    record.stderr_buffer.push_str(&chunk);
                } else {
                    record.stdout_buffer.push_str(&chunk);
                }
            }
        }
        record.status = match event.as_str() {
            "exited" => TerminalStatus::Exited,
            "killed" => TerminalStatus::Killed,
            "released" => TerminalStatus::Released,
            "failed" => TerminalStatus::Failed,
            _ => TerminalStatus::Running,
        };
        if matches!(
            record.status,
            TerminalStatus::Exited
                | TerminalStatus::Killed
                | TerminalStatus::Released
                | TerminalStatus::Failed
        ) {
            record.ended_at = Some(Utc::now());
        }
        self.db.upsert_terminal(&record)?;
        self.state_cache.set_terminal_record(&cache_key, record.clone());
        if let Some(chunk) = content {
            let message = MessageProjection {
                id: format!(
                    "{conversation_id}:{turn_id}:terminal:{terminal_id}:{}",
                    record.stdout_buffer.len() + record.stderr_buffer.len()
                ),
                conversation_id: conversation_id.to_string(),
                turn_id: turn_id.to_string(),
                role: MessageRole::Tool,
                kind: MessageKind::Terminal,
                content_json: json!({
                    "terminal_id": terminal_id,
                    "event": event,
                    "stream": stream,
                    "content": chunk,
                    "exit_code": exit_code
                }),
                created_at: Utc::now(),
            };
            self.db.upsert_message(&message)?;
            self.emit(
                "conversation:message_appended",
                &json!({ "conversation_id": conversation_id, "message": message }),
            );
            self.emit(
                "conversation:terminal_output",
                &json!({
                    "conversation_id": conversation_id,
                    "terminal_id": record.terminal_id,
                    "event": event,
                    "stream": stream,
                    "content": message.content_json.get("content").cloned().unwrap_or_else(|| json!("")),
                    "terminal": record
                }),
            );
        } else {
            self.emit(
                "conversation:terminal_output",
                &json!({
                    "conversation_id": conversation_id,
                    "terminal_id": record.terminal_id,
                    "event": event,
                    "stream": serde_json::Value::Null,
                    "content": serde_json::Value::Null,
                    "terminal": record
                }),
            );
        }
        Ok(())
    }
}
