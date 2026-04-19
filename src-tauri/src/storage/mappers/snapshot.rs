use rusqlite::Row;

use crate::domain::ConversationSnapshot;
use crate::storage::mappers::{from_json, parse_dt};

pub fn read_snapshot(row: &Row<'_>) -> rusqlite::Result<ConversationSnapshot> {
    Ok(ConversationSnapshot {
        conversation_id: row.get(0)?,
        snapshot_version: row.get(1)?,
        state_json: from_json(&row.get::<_, String>(2)?).unwrap_or_else(|_| serde_json::json!({})),
        event_seq: row.get(3)?,
        created_at: parse_dt(row.get::<_, String>(4)?)?,
    })
}
