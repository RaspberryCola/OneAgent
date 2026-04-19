use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Serialize};

pub fn enum_text<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

pub fn parse_enum<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_string())).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub fn parse_dt(value: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|v| v.with_timezone(&Utc))
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
}

pub fn to_json<T: Serialize>(value: &T) -> crate::storage::error::StorageResult<String> {
    Ok(serde_json::to_string(value)?)
}

pub fn from_json<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub mod agent_profile;
pub mod binding;
pub mod conversation;
pub mod mcp;
pub mod message;
pub mod permission;
pub mod runtime_event;
pub mod skill;
pub mod snapshot;
pub mod task_run;
pub mod terminal;
pub mod tool_call;
pub mod workspace;
