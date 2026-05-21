//! ACP permission handling functions.
//!
//! This module handles permission request parsing and sending permission decisions
//! back to the agent.

use serde_json::{json, Value};

use crate::{
    agent_adapters::{AdapterError, AdapterResult, RuntimeStreamEvent},
    domain::{PermissionDecisionKind, PermissionOptionKind, ToolKind},
};

use super::live_session::PermissionOption;
use super::types::AcpPermissionRequest;

/// Parse a permission request notification from the agent.
/// Returns the runtime event, permission request ID, and available options.
pub fn parse_permission_request(
    message: &Value,
    turn_id: &str,
) -> Option<(RuntimeStreamEvent, Value, Vec<PermissionOption>)> {
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
    let raw_input = tool_call.input.unwrap_or_else(|| json!({}));
    let paths = merge_paths(
        super::parser::extract_paths(&normalized_content),
        extract_paths_from_input(&raw_input),
    );
    Some((
        RuntimeStreamEvent::PermissionRequest {
            turn_id: turn_id.to_string(),
            tool_call_id: tool_call.tool_call_id,
            tool_kind: tool_call.kind.unwrap_or(ToolKind::Other),
            title: tool_call.title.unwrap_or_default(),
            raw_input,
            paths,
            options: serde_json::to_value(&options_raw).unwrap_or_else(|_| json!([])),
        },
        permission_id,
        options,
    ))
}

/// Send a permission decision back to the agent.
pub async fn send_permission_decision(
    process: &mut super::process::JsonRpcProcess,
    request_id: Value,
    options: &[PermissionOption],
    decision: PermissionDecisionKind,
) -> AdapterResult<()> {
    let outcome = match decision {
        PermissionDecisionKind::Cancelled => json!({ "outcome": "cancelled" }),
        PermissionDecisionKind::AllowOnce => selected_option(options, &PermissionOptionKind::AllowOnce)?,
        PermissionDecisionKind::AllowAlways => selected_option(options, &PermissionOptionKind::AllowAlways)?,
        PermissionDecisionKind::RejectOnce => selected_option(options, &PermissionOptionKind::RejectOnce)?,
        PermissionDecisionKind::RejectAlways => selected_option(options, &PermissionOptionKind::RejectAlways)?,
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
    request_id: Value,
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
fn selected_option(options: &[PermissionOption], kind: &PermissionOptionKind) -> AdapterResult<Value> {
    let option = options
        .iter()
        .find(|option| option.kind == *kind)
        .ok_or_else(|| {
            AdapterError::Protocol(format!("permission option {kind:?} not offered by agent"))
        })?;
    Ok(json!({
        "outcome": "selected",
        "optionId": option.option_id
    }))
}

fn extract_paths_from_input(input: &Value) -> Vec<String> {
    const PATH_KEYS: [&str; 5] = ["path", "file_path", "filePath", "old_path", "new_path"];

    let mut paths = Vec::new();
    if let Some(object) = input.as_object() {
        for key in PATH_KEYS {
            if let Some(path) = object.get(key).and_then(Value::as_str) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

fn merge_paths(mut left: Vec<String>, right: Vec<String>) -> Vec<String> {
    for path in right {
        if !left.contains(&path) {
            left.push(path);
        }
    }
    left
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_permission_request_with_raw_input_and_string_id() {
        let message = json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "options": [
                    { "kind": "allow_once", "name": "Allow", "optionId": "allow" },
                    { "kind": "reject_once", "name": "Reject", "optionId": "reject" }
                ],
                "toolCall": {
                    "toolCallId": "tool-1",
                    "title": "Write CLAUDE.md",
                    "rawInput": {
                        "file_path": "/tmp/CLAUDE.md",
                        "content": "hello"
                    }
                }
            }
        });

        let (event, request_id, options) = parse_permission_request(&message, "turn-1").unwrap();

        assert_eq!(request_id, json!("permission-1"));
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].kind, PermissionOptionKind::AllowOnce);

        match event {
            RuntimeStreamEvent::PermissionRequest {
                turn_id,
                tool_call_id,
                title,
                raw_input,
                paths,
                ..
            } => {
                assert_eq!(turn_id, "turn-1");
                assert_eq!(tool_call_id, "tool-1");
                assert_eq!(title, "Write CLAUDE.md");
                assert_eq!(raw_input["file_path"], "/tmp/CLAUDE.md");
                assert_eq!(paths, vec!["/tmp/CLAUDE.md"]);
            }
            other => panic!("expected permission request, got {other:?}"),
        }
    }

    #[test]
    fn parses_permission_request_with_diff_block() {
        let message = json!({
            "jsonrpc": "2.0",
            "id": "permission-2",
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "options": [
                    { "kind": "allow_once", "name": "Allow", "optionId": "allow" },
                    { "kind": "reject_once", "name": "Reject", "optionId": "reject" }
                ],
                "toolCall": {
                    "toolCallId": "tool-2",
                    "title": "Write src/main.rs",
                    "content": [
                        {
                            "type": "diff",
                            "path": "src/main.rs",
                            "newText": "hello",
                            "oldText": ""
                        }
                    ]
                }
            }
        });

        let (event, request_id, options) = parse_permission_request(&message, "turn-2").unwrap();

        assert_eq!(request_id, json!("permission-2"));
        assert_eq!(options.len(), 2);

        match event {
            RuntimeStreamEvent::PermissionRequest {
                turn_id,
                tool_call_id,
                title,
                paths,
                ..
            } => {
                assert_eq!(turn_id, "turn-2");
                assert_eq!(tool_call_id, "tool-2");
                assert_eq!(title, "Write src/main.rs");
                assert_eq!(paths, vec!["src/main.rs"]);
            }
            other => panic!("expected permission request, got {other:?}"),
        }
    }
}
