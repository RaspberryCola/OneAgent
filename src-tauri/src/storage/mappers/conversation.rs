use rusqlite::Row;

use crate::domain::Conversation;
use crate::storage::mappers::{parse_dt, parse_enum};

pub fn read_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        agent_profile_id: row.get(2)?,
        origin: parse_enum(&row.get::<_, String>(3)?)?,
        status: parse_enum(&row.get::<_, String>(4)?)?,
        title: row.get(5)?,
        created_at: parse_dt(row.get::<_, String>(6)?)?,
        updated_at: parse_dt(row.get::<_, String>(7)?)?,
        last_event_seq: row.get(8)?,
    })
}
