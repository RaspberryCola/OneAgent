//! ACP permission handling functions.
//!
//! This module handles permission request parsing and sending permission decisions
//! back to the agent.

use serde_json::{json, Value};

use crate::{
    agent_adapters::{AdapterError, AdapterResult, RuntimeStreamEvent},
    domain::PermissionDecisionKind,
};

use super::live_session::PermissionOption;

/// Parse a permission request notification from the agent.
/// Returns the runtime event, permission request ID, and available options.
pub fn parse_permission_request(
    message: &Value,
    turn_id: &str,
) -> Option<(RuntimeStreamEvent, i64, Vec<PermissionOption>)> {
    let permission_id = message.get("id")?.as_i64()?;
    let params = message.get("params")?;
    let tool_call = params.get("toolCall")?;
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(PermissionOption {
                        option_id: item.get("optionId")?.as_str()?.to_string(),
                        kind: item.get("kind")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((
        RuntimeStreamEvent::PermissionRequest {
            turn_id: turn_id.to_string(),
            tool_call_id: tool_call
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            tool_kind: tool_call
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("other")
                .to_string(),
            title: tool_call
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            raw_input: tool_call.get("input").cloned().unwrap_or_else(|| json!({})),
            paths: super::parser::extract_paths(tool_call.get("content")),
            options: params.get("options").cloned().unwrap_or_else(|| json!([])),
        },
        permission_id,
        options,
    ))
}

/// Send a permission decision back to the agent.
pub async fn send_permission_decision(
    process: &mut super::process::JsonRpcProcess,
    request_id: i64,
    options: &[PermissionOption],
    decision: PermissionDecisionKind,
) -> AdapterResult<()> {
    let outcome = match decision {
        PermissionDecisionKind::Cancelled => json!({ "outcome": "cancelled" }),
        PermissionDecisionKind::AllowOnce => selected_option(options, "allow_once")?,
        PermissionDecisionKind::AllowAlways => selected_option(options, "allow_always")?,
        PermissionDecisionKind::RejectOnce => selected_option(options, "reject_once")?,
        PermissionDecisionKind::RejectAlways => selected_option(options, "reject_always")?,
    };
    process
        .write_message(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": outcome
            }
        }))
        .await
}

/// Send a cancelled permission response back to the agent.
pub async fn send_cancelled_permission(
    process: &mut super::process::JsonRpcProcess,
    request_id: i64,
) -> AdapterResult<()> {
    process
        .write_message(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": {
                    "outcome": "cancelled"
                }
            }
        }))
        .await
}

/// Find and format the selected option for a permission decision.
fn selected_option(options: &[PermissionOption], kind: &str) -> AdapterResult<Value> {
    let option = options
        .iter()
        .find(|option| option.kind == kind)
        .ok_or_else(|| {
            AdapterError::Protocol(format!("permission option {kind} not offered by agent"))
        })?;
    Ok(json!({
        "outcome": "selected",
        "optionId": option.option_id
    }))
}