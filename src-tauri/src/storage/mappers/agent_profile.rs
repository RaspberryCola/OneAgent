use rusqlite::Row;

use crate::domain::{AgentDisplaySource, AgentLaunchMode, AgentProfile};
use crate::storage::mappers::{from_json, parse_enum};

pub fn read_agent_profile(row: &Row<'_>) -> rusqlite::Result<AgentProfile> {
    Ok(AgentProfile {
        id: row.get(0)?,
        kind: parse_enum(&row.get::<_, String>(1)?)?,
        name: row.get(2)?,
        command: row.get(3)?,
        args: from_json(&row.get::<_, String>(4)?)?,
        env: from_json(&row.get::<_, String>(5)?)?,
        launch_mode: row
            .get::<_, Option<String>>(6)?
            .map(|value| parse_enum(&value))
            .transpose()?
            .unwrap_or(AgentLaunchMode::Native),
        runtime_preference: row
            .get::<_, Option<String>>(7)?
            .map(|value| parse_enum(&value))
            .transpose()?,
        package_name: row.get(8)?,
        package_version: row.get(9)?,
        display_source: row
            .get::<_, Option<String>>(10)?
            .map(|value| parse_enum(&value))
            .transpose()?
            .unwrap_or(AgentDisplaySource::Native),
        capabilities_cache: serde_json::from_str(&row.get::<_, String>(11)?)
            .unwrap_or_else(|_| serde_json::json!({})),
        enabled: row.get::<_, i64>(12)? != 0,
    })
}
