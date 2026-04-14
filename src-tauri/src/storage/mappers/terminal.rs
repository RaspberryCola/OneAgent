use rusqlite::Row;

use crate::domain::TerminalRecord;
use crate::storage::mappers::{from_json, parse_dt, parse_enum};

pub fn read_terminal(row: &Row<'_>) -> rusqlite::Result<TerminalRecord> {
    Ok(TerminalRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        terminal_id: row.get(3)?,
        cwd: row.get(4)?,
        command: row.get(5)?,
        args_json: from_json(&row.get::<_, String>(6)?)
            .unwrap_or_else(|_| serde_json::json!([])),
        status: parse_enum(&row.get::<_, String>(7)?)?,
        stdout_buffer: row.get(8)?,
        stderr_buffer: row.get(9)?,
        started_at: parse_dt(row.get::<_, String>(10)?)?,
        ended_at: row
            .get::<_, Option<String>>(11)?
            .map(parse_dt)
            .transpose()?,
    })
}
