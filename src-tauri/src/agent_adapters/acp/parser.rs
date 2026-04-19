//! ACP protocol parsing functions.
//!
//! This module contains pure functions for parsing JSON-RPC responses and
//! ACP protocol messages into typed domain structures.

use serde_json::{json, Value};

use crate::{
    agent_adapters::RuntimeStreamEvent,
    domain::{
        AcpAvailableModel, AcpSessionMode, AcpSessionModeState, AcpSessionModels,
        AgentCapabilities, AgentPromptCapabilities, AgentSessionCapabilities, SessionConfigOption,
    },
};

use super::types::ACP_PROTOCOL_VERSION;
use super::types::{AcpSessionUpdate, AcpToolContentItem};

/// Extract error message from a JSON-RPC error response.
pub fn jsonrpc_error_message(response: &Value) -> Option<String> {
    let error = response.get("error")?;
    let code = error.get("code").and_then(Value::as_i64);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown JSON-RPC error")
        .to_string();
    let data = error.get("data");

    let mut details = String::new();
    if let Some(code) = code {
        details.push_str(&format!("code={code}"));
    }
    if let Some(data) = data {
        if !data.is_null() {
            if !details.is_empty() {
                details.push_str(", ");
            }
            details.push_str(&format!("data={data}"));
        }
    }

    Some(if details.is_empty() {
        message
    } else {
        format!("{message} ({details})")
    })
}

/// Parse agent capabilities from an initialize response.
pub fn parse_agent_capabilities(response: &Value) -> AgentCapabilities {
    let result = response.get("result").cloned().unwrap_or_else(|| json!({}));
    let protocol_version = result
        .get("protocolVersion")
        .and_then(|v| {
            v.as_u64()
                .map(|n| n.to_string())
                .or_else(|| v.as_str().map(ToOwned::to_owned))
        })
        .unwrap_or_else(|| ACP_PROTOCOL_VERSION.to_string());
    AgentCapabilities {
        protocol_version,
        agent_info: result
            .get("agentInfo")
            .cloned()
            .unwrap_or_else(|| json!({})),
        prompt_capabilities: parse_prompt_capabilities(&result),
        session_capabilities: parse_session_capabilities(&result),
        raw: response.clone(),
    }
}

/// Parse prompt capabilities from the agent capabilities result.
pub fn parse_prompt_capabilities(result: &Value) -> AgentPromptCapabilities {
    let prompt_capabilities = result
        .get("agentCapabilities")
        .and_then(|value| value.get("promptCapabilities"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let agent_name = result
        .get("agentInfo")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    // ClaudeCode ACP currently has schema/runtime differences around
    // resource_link prompt blocks. Force-disable resource_link to keep
    // compatibility and rely on text/resource fallbacks.
    let force_disable_resource_link = agent_name.contains("claude-code-acp");
    AgentPromptCapabilities {
        text: prompt_capabilities
            .get("text")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        resource_link: if force_disable_resource_link {
            false
        } else {
            prompt_capabilities
                .get("resourceLink")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        },
        embedded_context: prompt_capabilities
            .get("embeddedContext")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        image: prompt_capabilities
            .get("image")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        audio: prompt_capabilities
            .get("audio")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Parse session capabilities from the agent capabilities result.
pub fn parse_session_capabilities(result: &Value) -> AgentSessionCapabilities {
    let agent_caps = result
        .get("agentCapabilities")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let session_capabilities = agent_caps
        .get("sessionCapabilities")
        .cloned()
        .unwrap_or_else(|| json!({}));

    // Check load support from multiple locations:
    // 1. agentCapabilities.sessionCapabilities.load (bool or object like {})
    // 2. agentCapabilities.loadSession (used by claude-agent-acp bridge)
    let load_from_session_caps = session_capabilities
        .get("load")
        .map(|v| v.as_bool().unwrap_or_else(|| v.is_object()))
        .unwrap_or(false);
    let load_from_top_level = agent_caps
        .get("loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    AgentSessionCapabilities {
        load: load_from_session_caps || load_from_top_level,
        list: session_capabilities
            .get("list")
            .map(|v| v.as_bool().unwrap_or_else(|| v.is_object()))
            .unwrap_or(false),
    }
}

/// Parse config options from a result value.
pub fn parse_config_options(result: Option<&Value>) -> Vec<SessionConfigOption> {
    result
        .and_then(|value| value.get("configOptions"))
        .and_then(Value::as_array)
        .map(|items| parse_config_options_from_array(items))
        .unwrap_or_default()
}

/// Parse config options from an array of config option values.
pub fn parse_config_options_from_array(items: &[Value]) -> Vec<SessionConfigOption> {
    items
        .iter()
        .map(|item| SessionConfigOption {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| item.get("label").and_then(Value::as_str))
                .or_else(|| item.get("title").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string(),
            description: item
                .get("description")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            category: item
                .get("category")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            option_type: item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("string")
                .to_string(),
            current_value: item
                .get("currentValue")
                .cloned()
                .or_else(|| item.get("selectedValue").cloned())
                .or_else(|| item.get("value").cloned())
                .unwrap_or(Value::Null),
            options: item
                .get("options")
                .cloned()
                .or_else(|| item.get("enum").cloned())
                .unwrap_or_else(|| json!([])),
            raw: item.clone(),
        })
        .collect()
}

/// Parse modes from session/new or session/load response (unstable API).
pub fn parse_modes(result: Option<&Value>) -> Option<AcpSessionModeState> {
    let result = result?;
    let current_mode_id = result
        .get("modes")
        .and_then(|m| m.get("currentModeId"))
        .and_then(Value::as_str)?;
    let available_modes_val = result
        .get("modes")
        .and_then(|m| m.get("availableModes"))
        .and_then(Value::as_array)?;
    let mut available_modes = Vec::new();
    for m in available_modes_val {
        if let (Some(id), Some(name)) = (
            m.get("id").and_then(Value::as_str),
            m.get("name").and_then(Value::as_str),
        ) {
            available_modes.push(AcpSessionMode {
                id: id.to_string(),
                name: name.to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            });
        }
    }
    Some(AcpSessionModeState {
        current_mode_id: current_mode_id.to_string(),
        available_modes,
    })
}

/// Parse models from session/new or session/load response.
pub fn parse_models(result: Option<&Value>) -> Option<AcpSessionModels> {
    result.and_then(|value| {
        // Check top-level models first
        let models = value.get("models");
        // Also check _meta.models (used by some agents like iFlow)
        let meta_models = value.get("_meta").and_then(|m| m.get("models"));

        let models_source = models.or(meta_models)?;
        if models_source.is_null() {
            return None;
        }

        Some(AcpSessionModels {
            current_model_id: models_source
                .get("currentModelId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            available_models: models_source
                .get("availableModels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|item| AcpAvailableModel {
                            id: item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned),
                            model_id: item
                                .get("modelId")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned),
                            name: item
                                .get("name")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned),
                            raw: item.clone(),
                        })
                        .collect()
                }),
        })
    })
}

/// Parse a session/update notification into runtime stream events.
pub fn parse_session_update(message: &Value, turn_id: &str) -> Vec<RuntimeStreamEvent> {
    let mut events = Vec::new();
    let Some(update_value) = message.get("params").and_then(|p| p.get("update")).cloned() else {
        return events;
    };
    let Ok(update) = serde_json::from_value::<AcpSessionUpdate>(update_value) else {
        return events;
    };

    match update {
        AcpSessionUpdate::UserMessageChunk { .. } | AcpSessionUpdate::AgentMessageChunk { .. } => {
            if let Some(text) = update.message_text() {
                let role = if matches!(update, AcpSessionUpdate::AgentMessageChunk { .. }) {
                    "agent"
                } else {
                    "user"
                };
                let (thinking, stripped) = extract_and_strip_think_tags(text);
                if !thinking.is_empty() {
                    events.push(RuntimeStreamEvent::ThinkingChunk {
                        turn_id: turn_id.to_string(),
                        content: thinking,
                    });
                }
                if !stripped.is_empty() {
                    events.push(RuntimeStreamEvent::MessageChunk {
                        turn_id: turn_id.to_string(),
                        role: role.to_string(),
                        content: stripped,
                    });
                }
            }
        }
        AcpSessionUpdate::AgentThoughtChunk { .. }
        | AcpSessionUpdate::Thought { .. }
        | AcpSessionUpdate::Thinking { .. } => {
            let content = update.thought_text().unwrap_or_default();
            if !content.trim().is_empty() {
                events.push(RuntimeStreamEvent::ThinkingChunk {
                    turn_id: turn_id.to_string(),
                    content: content.to_string(),
                });
            }
        }
        AcpSessionUpdate::Plan { entries } => {
            events.push(RuntimeStreamEvent::Plan {
                turn_id: turn_id.to_string(),
                entries,
            });
        }
        AcpSessionUpdate::ToolCall { .. } | AcpSessionUpdate::ToolCallUpdate { .. } => {
            if let Some((tool_call_id, title, kind, status, raw_input, input, content)) =
                update.tool_call_parts()
            {
                let content = extract_content(content);
                let terminal_refs = content
                    .get("terminal_ids")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let raw_output = content
                    .get("text")
                    .cloned()
                    .unwrap_or_else(|| json!({ "text": "" }));
                let raw_input = raw_input
                    .cloned()
                    .or_else(|| input.cloned())
                    .unwrap_or_else(|| json!({}));

                events.push(RuntimeStreamEvent::ToolCall {
                    turn_id: turn_id.to_string(),
                    tool_call_id: tool_call_id.unwrap_or_default().to_string(),
                    title: title.unwrap_or_default().to_string(),
                    kind: kind.unwrap_or("other").to_string(),
                    status: normalize_tool_status(status.unwrap_or("pending")),
                    raw_input,
                    raw_output,
                    content: content.get("content").cloned().unwrap_or_else(|| json!([])),
                    diffs: content.get("diffs").cloned().unwrap_or_else(|| json!([])),
                    terminal_ids: terminal_refs.clone(),
                    locations: json!({
                        "terminals": terminal_refs,
                        "paths": extract_paths(content)
                    }),
                });
            }
        }
        AcpSessionUpdate::ConfigOptionUpdate { config_options } => {
            events.push(RuntimeStreamEvent::ConfigOptionsUpdated {
                config_options: parse_config_options_from_array(&config_options),
            });
        }
    }
    events
}

/// Extract and strip thinking tags from content.
/// Returns (thinking_content, remaining_content).
pub fn extract_and_strip_think_tags(content: &str) -> (String, String) {
    let mut thinking_parts = Vec::new();
    let mut remaining = content.to_string();

    // Handle both emoji-style and HTML-style thinking tags
    // The thinking emoji is used as delimiter by some agents
    for (open_tag, close_tag) in [
        // Using Unicode escape for thinking emoji (U+1F4AD)
        ("\u{1F4AD}", "\u{1F4AD}"),
        ("<thinking>", "</thinking>"),
    ] {
        while let Some(start) = remaining.find(open_tag) {
            let after_open = start + open_tag.len();
            if let Some(rel_end) = remaining[after_open..].find(close_tag) {
                let end = after_open + rel_end;
                let part = &remaining[after_open..end];
                if !part.trim().is_empty() {
                    thinking_parts.push(part.to_string());
                }
                remaining.replace_range(start..end + close_tag.len(), "");
            } else {
                // Unclosed tag - take rest as thinking
                let part = &remaining[after_open..];
                if !part.trim().is_empty() {
                    thinking_parts.push(part.to_string());
                }
                remaining.replace_range(start.., "");
                break;
            }
        }
    }

    // Clean up any remaining tag fragments
    let stripped = remaining
        .replace("\u{1F4AD}", "")
        .replace("<thinking>", "")
        .replace("</thinking>", "")
        .to_string();

    (thinking_parts.join("\n\n"), stripped)
}

/// Extract content from tool call update content array.
pub fn extract_content(content: Option<&[AcpToolContentItem]>) -> Value {
    let Some(items) = content else {
        return json!({
            "text": { "text": "" },
            "content": [],
            "diffs": [],
            "terminal_ids": [],
            "output": ""
        });
    };

    // Extract text from multiple content types:
    // - type: 'content' with content.text
    // - type: 'output' with text field
    // - legacy format with content.text or output field
    let texts: Vec<String> = items
        .iter()
        .filter_map(|item| {
            item.content
                .as_ref()
                .and_then(|c| c.text.clone())
                .or_else(|| item.text.clone())
                .or_else(|| item.output.clone())
        })
        .collect();

    let diffs: Vec<Value> = items.iter().filter_map(|item| item.diff.clone()).collect();

    let terminal_ids: Vec<String> = items
        .iter()
        .filter_map(|item| item.terminal_id.clone())
        .collect();

    json!({
        "text": { "text": texts.join("\n") },
        "content": items,
        "diffs": diffs,
        "terminal_ids": terminal_ids,
        "output": texts.join("\n")
    })
}

/// Extract file paths from content array.
pub fn extract_paths(content: Value) -> Vec<String> {
    content
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("content")
                        .and_then(|content| content.get("uri"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Normalize tool status from ACP to internal representation.
pub fn normalize_tool_status(status: &str) -> String {
    match status {
        "pending" => "declared",
        "in_progress" => "running",
        other => other,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_message_chunks() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "final answer" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                assert_eq!(role, "agent");
                assert_eq!(content, "final answer");
            }
            other => panic!("expected message chunk, got {other:?}"),
        }
    }

    #[test]
    fn separates_thinking_from_message_content() {
        let thinking_emoji = "\u{1F4AD}";
        let text = format!("{thinking_emoji}reasoning{thinking_emoji}final answer");
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 2);
        match &events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => assert_eq!(content, "reasoning"),
            other => panic!("expected thinking chunk, got {other:?}"),
        }
        match &events[1] {
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                assert_eq!(role, "agent");
                assert_eq!(content, "final answer");
            }
            other => panic!("expected agent text chunk, got {other:?}"),
        }
    }

    #[test]
    fn parses_agent_thought_chunk_updates() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "reasoning chunk" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                assert_eq!(content, "reasoning chunk")
            }
            other => panic!("expected thinking chunk, got {other:?}"),
        }
    }

    #[test]
    fn preserves_chunk_boundary_spaces_in_agent_thought_updates() {
        let first = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "The user " }
                }
            }
        });
        let second = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "is asking" }
                }
            }
        });

        let first_events = parse_session_update(&first, "turn");
        let second_events = parse_session_update(&second, "turn");

        match &first_events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                assert_eq!(content, "The user ");
            }
            _ => panic!("expected thinking chunk"),
        }
        match &second_events[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                assert_eq!(content, "is asking");
            }
            _ => panic!("expected thinking chunk"),
        }
    }

    #[test]
    fn strips_and_preserves_multiline_thinking() {
        let thinking_emoji = "\u{1F4AD}";
        let text = format!("{thinking_emoji}line 1\nline 2{thinking_emoji}final answer");
        let (thinking, stripped) = extract_and_strip_think_tags(&text);
        assert_eq!(thinking, "line 1\nline 2");
        assert_eq!(stripped, "final answer");
    }

    #[test]
    fn handles_thinking_tag_at_start_and_end() {
        let thinking_emoji = "\u{1F4AD}";
        let text = format!("{thinking_emoji}The user {thinking_emoji}final answer");
        let (thinking, stripped) = extract_and_strip_think_tags(&text);
        assert_eq!(thinking, "The user ");
        assert_eq!(stripped, "final answer");
    }

    #[test]
    fn handles_alternate_thinking_tag_name() {
        let text = "<thinking>reasoning</thinking>final answer";
        let (thinking, stripped) = extract_and_strip_think_tags(text);
        assert_eq!(thinking, "reasoning");
        assert_eq!(stripped, "final answer");
    }

    #[test]
    fn handles_think_tag_with_leading_and_trailing_text() {
        let thinking_emoji = "\u{1F4AD}";
        let text =
            format!("some preamble {thinking_emoji} reasoning {thinking_emoji} final answer");
        let (thinking, stripped) = extract_and_strip_think_tags(&text);
        assert_eq!(thinking, " reasoning ");
        assert_eq!(stripped, "some preamble  final answer");
    }

    #[test]
    fn handles_multiline_think_with_trailing_text() {
        let thinking_emoji = "\u{1F4AD}";
        let text = format!("{thinking_emoji}\nThe user \n{thinking_emoji}final answer");
        let (thinking, stripped) = extract_and_strip_think_tags(&text);
        assert_eq!(thinking, "\nThe user \n");
        assert_eq!(stripped, "final answer");
    }

    #[test]
    fn parses_plan_event() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [
                        {"content": "Step 1", "status": "pending"},
                        {"content": "Step 2", "status": "completed"}
                    ]
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::Plan { turn_id, entries } => {
                assert_eq!(turn_id, "turn");
                assert_eq!(entries.as_array().unwrap().len(), 2);
            }
            other => panic!("expected plan event, got {other:?}"),
        }
    }

    #[test]
    fn parses_tool_call_update_with_all_fields() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "title": "Run tests",
                    "kind": "execute",
                    "status": "in_progress",
                    "rawInput": { "command": "cargo test" },
                    "rawOutput": { "text": "running 5 tests" },
                    "content": [
                        { "terminalId": "term_1" },
                        { "content": { "text": "output" } },
                        { "diff": { "path": "src/lib.rs", "patch": "@@ -1 +1 @@" } }
                    ]
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::ToolCall {
                turn_id,
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                raw_output,
                terminal_ids,
                locations,
                ..
            } => {
                assert_eq!(turn_id, "turn");
                assert_eq!(tool_call_id, "call_1");
                assert_eq!(title, "Run tests");
                assert_eq!(kind, "execute");
                assert_eq!(status, "running"); // normalized from "in_progress"
                assert_eq!(raw_input["command"], "cargo test");
                // raw_output comes from content["text"], which joins all text content
                assert_eq!(raw_output["text"], "output");
                assert_eq!(terminal_ids.as_array().unwrap().len(), 1);
                assert_eq!(locations["terminals"].as_array().unwrap().len(), 1);
            }
            other => panic!("expected tool call event, got {other:?}"),
        }
    }

    #[test]
    fn normalizes_tool_status_from_acp() {
        assert_eq!(normalize_tool_status("pending"), "declared");
        assert_eq!(normalize_tool_status("in_progress"), "running");
        assert_eq!(normalize_tool_status("completed"), "completed");
        assert_eq!(normalize_tool_status("failed"), "failed");
        assert_eq!(normalize_tool_status("custom_status"), "custom_status");
    }

    #[test]
    fn parses_config_option_update() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {
                            "id": "model",
                            "name": "Model",
                            "category": "model",
                            "currentValue": "claude-3",
                            "options": [{"value": "claude-3"}, {"value": "claude-4"}]
                        }
                    ]
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::ConfigOptionsUpdated { config_options } => {
                assert_eq!(config_options.len(), 1);
                assert_eq!(config_options[0].id, "model");
                assert_eq!(config_options[0].current_value, "claude-3");
            }
            other => panic!("expected config options updated event, got {other:?}"),
        }
    }

    #[test]
    fn handles_malformed_session_update_gracefully() {
        // Missing params
        let message1 = json!({});
        let events1 = parse_session_update(&message1, "turn");
        assert!(events1.is_empty());

        // Missing update
        let message2 = json!({ "params": {} });
        let events2 = parse_session_update(&message2, "turn");
        assert!(events2.is_empty());

        // Unknown update type
        let message3 = json!({
            "params": {
                "update": {
                    "sessionUpdate": "unknown_type"
                }
            }
        });
        let events3 = parse_session_update(&message3, "turn");
        assert!(events3.is_empty());
    }

    #[test]
    fn extracts_content_with_various_formats() {
        // Terminal ref only
        let content1: Vec<AcpToolContentItem> =
            serde_json::from_value(json!([{ "terminalId": "term_1" }])).unwrap();
        let result1 = extract_content(Some(&content1));
        assert_eq!(result1["terminal_ids"], json!(["term_1"]));

        // Text content
        let content2: Vec<AcpToolContentItem> =
            serde_json::from_value(json!([{ "content": { "text": "hello" } }])).unwrap();
        let result2 = extract_content(Some(&content2));
        assert_eq!(result2["text"]["text"], "hello");

        // Diff content
        let content3: Vec<AcpToolContentItem> =
            serde_json::from_value(json!([{ "diff": { "path": "src/lib.rs", "patch": "@@" } }]))
                .unwrap();
        let result3 = extract_content(Some(&content3));
        assert_eq!(result3["diffs"][0]["path"], "src/lib.rs");

        // Legacy format with output field
        let content4: Vec<AcpToolContentItem> =
            serde_json::from_value(json!([{ "output": "legacy output" }])).unwrap();
        let result4 = extract_content(Some(&content4));
        assert_eq!(result4["output"], "legacy output");

        // Mixed content
        let content5: Vec<AcpToolContentItem> = serde_json::from_value(json!([
            { "terminalId": "term_1" },
            { "content": { "text": "output" } },
            { "diff": { "path": "file.rs", "patch": "@@" } }
        ]))
        .unwrap();
        let result5 = extract_content(Some(&content5));
        assert_eq!(result5["terminal_ids"].as_array().unwrap().len(), 1);
        assert_eq!(result5["diffs"].as_array().unwrap().len(), 1);
        assert_eq!(result5["text"]["text"], "output");
    }

    #[test]
    fn extracts_paths_from_content() {
        let content: Vec<AcpToolContentItem> = serde_json::from_value(json!([
            { "content": { "uri": "file:///tmp/test.txt" } },
            { "content": { "uri": "file:///home/user/file.rs" } }
        ]))
        .unwrap();
        let paths = extract_paths(extract_content(Some(&content)));
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], "file:///tmp/test.txt");
        assert_eq!(paths[1], "file:///home/user/file.rs");
    }

    #[test]
    fn extracts_empty_paths_when_no_content() {
        assert!(extract_paths(json!({})).is_empty());
        assert!(extract_paths(json!({ "content": [] })).is_empty());
        assert!(extract_paths(json!({ "content": {} })).is_empty());
    }

    #[test]
    fn parses_thought_and_thinking_updates() {
        // "thought" update type
        let message1 = json!({
            "params": {
                "update": {
                    "sessionUpdate": "thought",
                    "description": "thinking about this"
                }
            }
        });
        let events1 = parse_session_update(&message1, "turn");
        assert_eq!(events1.len(), 1);
        match &events1[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                assert_eq!(content, "thinking about this");
            }
            other => panic!("expected thinking chunk, got {other:?}"),
        }

        // "thinking" update type
        let message2 = json!({
            "params": {
                "update": {
                    "sessionUpdate": "thinking",
                    "subject": "analyzing code"
                }
            }
        });
        let events2 = parse_session_update(&message2, "turn");
        assert_eq!(events2.len(), 1);
        match &events2[0] {
            RuntimeStreamEvent::ThinkingChunk { content, .. } => {
                assert_eq!(content, "analyzing code");
            }
            other => panic!("expected thinking chunk, got {other:?}"),
        }
    }

    #[test]
    fn parses_user_message_chunk() {
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "text": "user input" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::MessageChunk { role, content, .. } => {
                assert_eq!(role, "user");
                assert_eq!(content, "user input");
            }
            other => panic!("expected message chunk, got {other:?}"),
        }
    }

    #[test]
    fn handles_tool_call_with_legacy_input_field() {
        // Some agents use "input" instead of "rawInput"
        let message = json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call_1",
                    "title": "Test",
                    "kind": "execute",
                    "input": { "legacy": "value" }
                }
            }
        });
        let events = parse_session_update(&message, "turn");
        assert_eq!(events.len(), 1);
        match &events[0] {
            RuntimeStreamEvent::ToolCall { raw_input, .. } => {
                assert_eq!(raw_input["legacy"], "value");
            }
            other => panic!("expected tool call event, got {other:?}"),
        }
    }
}
