use rusqlite::Row;

use crate::domain::TaskRun;
use crate::storage::mappers::{parse_dt, parse_enum};

pub fn read_task_run(row: &Row<'_>) -> rusqlite::Result<TaskRun> {
    Ok(TaskRun {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        workspace_id: row.get(2)?,
        agent_profile_id: row.get(3)?,
        goal: row.get(4)?,
        status: parse_enum(&row.get::<_, String>(5)?)?,
        result_summary: row.get(6)?,
        created_at: parse_dt(row.get::<_, String>(7)?)?,
        updated_at: parse_dt(row.get::<_, String>(8)?)?,
    })
}
