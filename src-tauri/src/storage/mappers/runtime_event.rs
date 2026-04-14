use rusqlite::Row;

use crate::domain::RuntimeEvent;
use crate::storage::mappers::{from_json, parse_dt};

pub fn read_runtime_event(row: &Row<'_>) -> rusqlite::Result<RuntimeEvent> {
    Ok(RuntimeEvent {
        seq: row.get(0)?,
        conversation_id: row.get(1)?,
        event_type: row.get(2)?,
        payload_json: from_json(&row.get::<_, String>(3)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        created_at: parse_dt(row.get::<_, String>(4)?)?,
    })
}
