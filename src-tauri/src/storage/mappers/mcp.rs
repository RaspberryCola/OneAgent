use rusqlite::Row;

use crate::domain::{McpServerConfig, McpTransportType};
use crate::storage::mappers::from_json;

pub fn read_mcp(row: &Row<'_>) -> rusqlite::Result<McpServerConfig> {
    // Read transport_type: prefer new column, fallback to old 'command' column
    let transport_str: String = row
        .get::<_, String>("transport_type")
        .or_else(|_: rusqlite::Error| row.get("command"))
        .unwrap_or_else(|_| "stdio".to_string());
    let transport_type = match transport_str.as_str() {
        "http" => McpTransportType::Http,
        "sse" => McpTransportType::Sse,
        _ => McpTransportType::Stdio,
    };

    // Read command: for new rows this is the actual executable,
    // for old rows the 'command' column holds the transport type string.
    // Detect the old-data case and use empty string instead.
    let raw_command: String = row.get("command").unwrap_or_default();
    let command = if raw_command == "stdio"
        || raw_command == "http"
        || raw_command == "sse"
    {
        // Old data: 'command' column holds transport type, not actual command.
        // The actual command info is lost for old rows — use empty string.
        String::new()
    } else {
        raw_command
    };

    // Read args: prefer new args_array column, fallback to old args_json
    let args: Vec<String> = row
        .get::<_, String>("args_array")
        .ok()
        .and_then(|s| from_json(&s).ok())
        .or_else(|| {
            // Fallback: try old args_json, but only if it's an array (not a URL string)
            row.get::<_, String>("args_json")
                .ok()
                .and_then(|s| {
                    let v: serde_json::Value = from_json(&s).ok()?;
                    if v.is_array() {
                        serde_json::from_value(v).ok()
                    } else {
                        None // Old data: args_json is a URL string, not args
                    }
                })
        })
        .unwrap_or_default();

    // Read url: prefer new column, fallback to old args_json for http/sse
    let url_from_new = row.get::<_, String>("url").unwrap_or_default();
    let url = if !url_from_new.is_empty() {
        url_from_new
    } else if transport_type == McpTransportType::Http || transport_type == McpTransportType::Sse {
        // Old data: args_json holds the URL for http/sse
        row.get::<_, String>("args_json")
            .ok()
            .and_then(|s| {
                let v: serde_json::Value = from_json(&s).ok()?;
                if v.is_string() {
                    v.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default()
    } else {
        String::new()
    };

    // Read env: prefer new env_json, fallback to old env_json
    // Both should be JSON objects like {"KEY": "value"}
    let env: serde_json::Value = row
        .get::<_, String>("env_json")
        .ok()
        .and_then(|s| {
            let v: serde_json::Value = from_json(&s).ok()?;
            // Normalize: if it's an empty array (old browser MCP), convert to empty object
            if v.is_array() {
                Some(serde_json::json!({}))
            } else {
                Some(v)
            }
        })
        .unwrap_or_else(|| serde_json::json!({}));

    // Read headers from new column
    let headers: serde_json::Value = row
        .get::<_, String>("headers_json")
        .ok()
        .and_then(|s| from_json(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let enabled: bool = row.get::<_, i64>("enabled").unwrap_or(0) != 0;
    let builtin: bool = row.get::<_, i64>("builtin").unwrap_or(0) != 0;

    Ok(McpServerConfig {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        name: row.get("name")?,
        transport_type,
        command,
        args,
        url,
        env,
        headers,
        enabled,
        builtin,
    })
}
