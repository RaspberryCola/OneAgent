use rusqlite::Row;

use crate::domain::{SkillOwner, SkillRecord, SkillScope};
use crate::storage::mappers::{from_json, parse_enum};

pub fn read_skill(row: &Row<'_>) -> rusqlite::Result<SkillRecord> {
    Ok(SkillRecord {
        id: row.get(0)?,
        scope: parse_enum::<SkillScope>(&row.get::<_, String>(1)?)?,
        name: row.get(2)?,
        description: row.get(3)?,
        location: row.get(4)?,
        source_dir: row.get(5)?,
        owner: parse_enum::<SkillOwner>(&row.get::<_, String>(6)?)?,
        enabled: row.get::<_, i64>(7)? != 0,
        diagnostics_json: from_json(&row.get::<_, String>(8)?)
            .unwrap_or_else(|_| serde_json::json!({})),
    })
}
