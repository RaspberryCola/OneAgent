//! Snapshot state management for conversations.
//!
//! This module provides helper functions for updating snapshot state fields,
//! eliminating duplicate code patterns across the runtime module.

use serde_json::Value;

use crate::storage::Database;

use super::snapshot_model::RuntimeSnapshotState;
use super::RuntimeResult;

/// Updates a single field in the snapshot state using a closure.
///
/// This is a template method that handles the common pattern:
/// 1. Get current snapshot state (or default)
/// 2. Apply update via closure
/// 3. Get last_event_seq
/// 4. Persist to database
///
/// # Example
///
/// ```ignore
/// update_snapshot_field(db, conversation_id, |state| {
///     state.config_options = new_options;
/// })?;
/// ```
pub fn update_snapshot_field<F>(
    db: &Database,
    conversation_id: &str,
    update: F,
) -> RuntimeResult<()>
where
    F: FnOnce(&mut RuntimeSnapshotState),
{
    let mut snapshot_state = get_snapshot_state(db, conversation_id);
    update(&mut snapshot_state);
    let event_seq = db.get_conversation(conversation_id)?.last_event_seq;
    db.replace_snapshot(
        conversation_id,
        1,
        &serde_json::to_value(&snapshot_state).unwrap_or_else(|_| Value::Null),
        event_seq,
    )?;
    Ok(())
}

/// Gets the current snapshot state, returning default if not found.
pub fn get_snapshot_state(db: &Database, conversation_id: &str) -> RuntimeSnapshotState {
    db.get_snapshot(conversation_id)
        .ok()
        .flatten()
        .and_then(|snapshot| RuntimeSnapshotState::from_snapshot_value(snapshot.state_json))
        .unwrap_or_default()
}