use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::{MessageProjection, RuntimeEvent, ToolCallProjection};
use crate::storage::error::StorageResult;
use crate::storage::mappers::enum_text;
use crate::storage::mappers::message::read_message;
use crate::storage::mappers::runtime_event::read_runtime_event;
use crate::storage::mappers::tool_call::read_tool_call;

pub struct EventRepository<'a> {
    conn: &'a Connection,
}

impl<'a> EventRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn append(
        &self,
        conversation_id: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> StorageResult<RuntimeEvent> {
        let now = Utc::now();
        let conn = self.conn;
        conn.execute(
            "INSERT INTO runtime_events (conversation_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, event_type, payload.to_string(), now.to_rfc3339()],
        )?;
        let seq = conn.last_insert_rowid();
        conn.execute(
            "UPDATE conversations SET last_event_seq = ?2, updated_at = ?3 WHERE id = ?1",
            params![conversation_id, seq, now.to_rfc3339()],
        )?;
        Ok(RuntimeEvent {
            seq,
            conversation_id: conversation_id.to_string(),
            event_type: event_type.to_string(),
            payload_json: payload.clone(),
            created_at: now,
        })
    }

    pub fn list(&self, conversation_id: &str) -> StorageResult<Vec<RuntimeEvent>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT seq, conversation_id, event_type, payload_json, created_at FROM runtime_events WHERE conversation_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_runtime_event)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }
}

pub struct MessageRepository<'a> {
    conn: &'a Connection,
}

impl<'a> MessageRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn upsert(&self, message: &MessageProjection) -> StorageResult<()> {
        self.conn.execute(
            r#"
            INSERT INTO message_projections (id, conversation_id, turn_id, role, kind, content_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET content_json = excluded.content_json
            "#,
            params![
                message.id,
                message.conversation_id,
                message.turn_id,
                enum_text(&message.role),
                enum_text(&message.kind),
                message.content_json.to_string(),
                message.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, conversation_id: &str) -> StorageResult<Vec<MessageProjection>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, role, kind, content_json, created_at FROM message_projections WHERE conversation_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_message)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn latest_agent_text(&self, conversation_id: &str) -> StorageResult<Option<String>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                r#"
                SELECT content_json
                FROM message_projections
                WHERE conversation_id = ?1
                  AND role = 'agent'
                  AND kind = 'text'
                  AND COALESCE(json_extract(content_json, '$.stream'), 0) = 0
                ORDER BY datetime(created_at) DESC, rowid DESC
                LIMIT 1
                "#,
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        let text = raw
            .and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
            .and_then(|json| {
                json.get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
            });
        Ok(text)
    }

    pub fn latest_diff_payload(
        &self,
        conversation_id: &str,
    ) -> StorageResult<Option<serde_json::Value>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                r#"
                SELECT content_json
                FROM message_projections
                WHERE conversation_id = ?1
                  AND kind = 'diff'
                ORDER BY datetime(created_at) DESC, rowid DESC
                LIMIT 1
                "#,
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok()))
    }
}

pub struct ToolCallRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ToolCallRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn upsert(&self, call: &ToolCallProjection) -> StorageResult<()> {
        self.conn.execute(
            r#"
            INSERT INTO tool_call_projections (id, conversation_id, turn_id, tool_call_id, title, kind, status, raw_input_json, raw_output_json, content_json, diffs_json, terminal_ids_json, locations_json, started_at, ended_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              raw_output_json = excluded.raw_output_json,
              content_json = excluded.content_json,
              diffs_json = excluded.diffs_json,
              terminal_ids_json = excluded.terminal_ids_json,
              locations_json = excluded.locations_json,
              ended_at = excluded.ended_at
            "#,
            params![
                call.id,
                call.conversation_id,
                call.turn_id,
                call.tool_call_id,
                call.title,
                call.kind,
                enum_text(&call.status),
                call.raw_input_json.to_string(),
                call.raw_output_json.to_string(),
                call.content_json.to_string(),
                call.diffs_json.to_string(),
                call.terminal_ids_json.to_string(),
                call.locations_json.to_string(),
                call.started_at.map(|v| v.to_rfc3339()),
                call.ended_at.map(|v| v.to_rfc3339())
            ],
        )?;
        Ok(())
    }

    pub fn list(&self, conversation_id: &str) -> StorageResult<Vec<ToolCallProjection>> {
        let conn = self.conn;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, tool_call_id, title, kind, status, raw_input_json, raw_output_json, content_json, diffs_json, terminal_ids_json, locations_json, started_at, ended_at FROM tool_call_projections WHERE conversation_id = ?1 ORDER BY COALESCE(started_at, '') ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id], read_tool_call)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(crate::storage::error::StorageError::from)
    }

    pub fn count(&self, conversation_id: &str) -> StorageResult<usize> {
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM tool_call_projections WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        Ok(total.max(0) as usize)
    }
}
