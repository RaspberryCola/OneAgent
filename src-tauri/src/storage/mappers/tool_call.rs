use rusqlite::Row;

use crate::domain::ToolCallProjection;
use crate::storage::mappers::{from_json, parse_dt, parse_enum};

pub fn read_tool_call(row: &Row<'_>) -> rusqlite::Result<ToolCallProjection> {
    Ok(ToolCallProjection {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        tool_call_id: row.get(3)?,
        title: row.get(4)?,
        kind: row.get(5)?,
        status: parse_enum(&row.get::<_, String>(6)?)?,
        raw_input_json: from_json(&row.get::<_, String>(7)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        raw_output_json: from_json(&row.get::<_, String>(8)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        content_json: from_json(&row.get::<_, String>(9)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        diffs_json: from_json(&row.get::<_, String>(10)?)
            .unwrap_or_else(|_| serde_json::json!([])),
        terminal_ids_json: from_json(&row.get::<_, String>(11)?)
            .unwrap_or_else(|_| serde_json::json!([])),
        locations_json: from_json(&row.get::<_, String>(12)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        started_at: row
            .get::<_, Option<String>>(13)?
            .map(parse_dt)
            .transpose()?,
        ended_at: row
            .get::<_, Option<String>>(14)?
            .map(parse_dt)
            .transpose()?,
    })
}
