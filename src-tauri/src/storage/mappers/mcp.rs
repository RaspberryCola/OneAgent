use rusqlite::Row;

use crate::domain::McpServerConfig;
use crate::storage::mappers::from_json;

pub fn read_mcp(row: &Row<'_>) -> rusqlite::Result<McpServerConfig> {
    Ok(McpServerConfig {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        command: row.get(3)?,
        args_json: from_json(&row.get::<_, String>(4)?).unwrap_or_else(|_| serde_json::json!([])),
        env_json: from_json(&row.get::<_, String>(5)?).unwrap_or_else(|_| serde_json::json!({})),
        enabled: row.get::<_, i64>(6)? != 0,
    })
}
