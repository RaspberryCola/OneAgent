use rusqlite::Row;

use crate::domain::Workspace;
use crate::storage::mappers::parse_dt;

pub fn read_workspace(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        cwd: row.get(1)?,
        display_name: row.get(2)?,
        trusted: row.get::<_, i64>(3)? != 0,
        created_at: parse_dt(row.get::<_, String>(4)?)?,
        updated_at: parse_dt(row.get::<_, String>(5)?)?,
    })
}
