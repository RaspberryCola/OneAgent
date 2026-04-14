use rusqlite::Row;

use crate::domain::{AgentSessionBinding, AgentSessionSource};
use crate::storage::mappers::{parse_dt, parse_enum};

pub fn read_binding(row: &Row<'_>) -> rusqlite::Result<AgentSessionBinding> {
    Ok(AgentSessionBinding {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        adapter_kind: parse_enum(&row.get::<_, String>(2)?)?,
        remote_session_id: row.get(3)?,
        cwd: row.get(4)?,
        load_supported: row.get::<_, i64>(5)? != 0,
        source: parse_enum::<AgentSessionSource>(&row.get::<_, String>(6)?)?,
        last_synced_at: parse_dt(row.get::<_, String>(7)?)?,
    })
}
