use rusqlite::Row;

use crate::domain::MessageProjection;
use crate::storage::mappers::{from_json, parse_dt, parse_enum};

pub fn read_message(row: &Row<'_>) -> rusqlite::Result<MessageProjection> {
    Ok(MessageProjection {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        role: parse_enum(&row.get::<_, String>(3)?)?,
        kind: parse_enum(&row.get::<_, String>(4)?)?,
        content_json: from_json(&row.get::<_, String>(5)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        created_at: parse_dt(row.get::<_, String>(6)?)?,
    })
}
