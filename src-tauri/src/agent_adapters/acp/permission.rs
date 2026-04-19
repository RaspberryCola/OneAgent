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
use super::types::AcpPermissionRequest;

/// Parse a permission request notification from the agent.
/// Returns the runtime event, permission request ID, and available options.
pub fn parse_permission_request(
    message: &Value,
    turn_id: &str,
) -> Option<(RuntimeStreamEvent, i64, Vec<PermissionOption>)> {
    let request = serde_json::from_value::<AcpPermissionRequest>(message.clone()).ok()?;
    let permission_id = request.id;
    let options_raw = request.params.options;
    let tool_call = request.params.tool_call;

    let options = options_raw
        .iter()
        .map(|item| PermissionOption {
            option_id: item.option_id.clone(),
            kind: item.kind.clone(),
        })
        .collect::<Vec<_>>();

    let tool_call_content = tool_call.content.clone().unwrap_or_default();
    let normalized_content = super::parser::extract_content(Some(&tool_call_content));
    Some((
        RuntimeStreamEvent::PermissionRequest {
            turn_id: turn_id.to_string(),
            tool_call_id: tool_call.tool_call_id,
            tool_kind: tool_call.kind.unwrap_or_else(|| "other".to_string()),
            title: tool_call.title.unwrap_or_default(),
            raw_input: tool_call.input.unwrap_or_else(|| json!({})),
            paths: super::parser::extract_paths(normalized_content.clone()),
            options: serde_json::to_value(&options_raw).unwrap_or_else(|_| json!([])),
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