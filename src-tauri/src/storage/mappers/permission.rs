use rusqlite::Row;

use crate::domain::{PendingPermissionRequest, PendingPermissionStatus, PermissionDecision};
use crate::storage::mappers::{from_json, parse_dt, parse_enum};

pub fn read_permission(row: &Row<'_>) -> rusqlite::Result<PermissionDecision> {
    Ok(PermissionDecision {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        tool_call_id: row.get(2)?,
        scope: row.get(3)?,
        fingerprint: row.get(4)?,
        decision: parse_enum(&row.get::<_, String>(5)?)?,
        created_at: parse_dt(row.get::<_, String>(6)?)?,
    })
}

pub fn read_pending_permission(row: &Row<'_>) -> rusqlite::Result<PendingPermissionRequest> {
    Ok(PendingPermissionRequest {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        tool_call_id: row.get(3)?,
        fingerprint: row.get(4)?,
        options_json: from_json(&row.get::<_, String>(5)?)
            .unwrap_or_else(|_| serde_json::json!([])),
        status: parse_enum::<PendingPermissionStatus>(&row.get::<_, String>(6)?)?,
        created_at: parse_dt(row.get::<_, String>(7)?)?,
        resolved_at: row.get::<_, Option<String>>(8)?.map(parse_dt).transpose()?,
    })
}
