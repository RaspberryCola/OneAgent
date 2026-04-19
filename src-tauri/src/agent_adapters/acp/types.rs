//! ACP protocol constants and internal type definitions.
//!
//! This module contains constants used throughout the ACP adapter implementation.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The ACP protocol version supported by this adapter.
pub const ACP_PROTOCOL_VERSION: u64 = 1;

/// Maximum size for embedded text content (128KB).
pub const MAX_EMBEDDED_TEXT_BYTES: u64 = 128 * 1024;

/// Maximum size for embedded image content (10MB).
pub const MAX_EMBEDDED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Maximum size for embedded audio content (10MB).
pub const MAX_EMBEDDED_AUDIO_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpTextContent {
    #[serde(default)]
    pub(crate) text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpToolContentRef {
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) uri: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpToolContentItem {
    #[serde(rename = "terminalId", default)]
    pub(crate) terminal_id: Option<String>,
    #[serde(default)]
    pub(crate) content: Option<AcpToolContentRef>,
    #[serde(default)]
    pub(crate) diff: Option<Value>,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) output: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "sessionUpdate")]
pub(crate) enum AcpSessionUpdate {
    #[serde(rename = "user_message_chunk")]
    UserMessageChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
    },
    #[serde(rename = "agent_message_chunk")]
    AgentMessageChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
    },
    #[serde(rename = "agent_thought_chunk")]
    AgentThoughtChunk {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "thought")]
    Thought {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "thinking")]
    Thinking {
        #[serde(default)]
        content: Option<AcpTextContent>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        subject: Option<String>,
    },
    #[serde(rename = "plan")]
    Plan {
        #[serde(default)]
        entries: Value,
    },
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(rename = "toolCallId", default)]
        tool_call_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(rename = "rawInput", default)]
        raw_input: Option<Value>,
        #[serde(default)]
        input: Option<Value>,
        #[serde(default)]
        content: Option<Vec<AcpToolContentItem>>,
    },
    #[serde(rename = "tool_call_update")]
    ToolCallUpdate {
        #[serde(rename = "toolCallId", default)]
        tool_call_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(rename = "rawInput", default)]
        raw_input: Option<Value>,
        #[serde(default)]
        input: Option<Value>,
        #[serde(default)]
        content: Option<Vec<AcpToolContentItem>>,
    },
    #[serde(rename = "config_option_update")]
    ConfigOptionUpdate {
        #[serde(rename = "configOptions", default)]
        config_options: Vec<Value>,
    },
}

impl AcpSessionUpdate {
    pub(crate) fn message_text(&self) -> Option<&str> {
        match self {
            Self::UserMessageChunk { content } | Self::AgentMessageChunk { content } => {
                content.as_ref()?.text.as_deref()
            }
            _ => None,
        }
    }

    pub(crate) fn thought_text(&self) -> Option<&str> {
        match self {
            Self::AgentThoughtChunk {
                content,
                description,
                subject,
            }
            | Self::Thought {
                content,
                description,
                subject,
            }
            | Self::Thinking {
                content,
                description,
                subject,
            } => content
                .as_ref()
                .and_then(|v| v.text.as_deref())
                .or(description.as_deref())
                .or(subject.as_deref()),
            _ => None,
        }
    }

    pub(crate) fn tool_call_parts(
        &self,
    ) -> Option<(
        Option<&str>,
        Option<&str>,
        Option<&str>,
        Option<&str>,
        Option<&Value>,
        Option<&Value>,
        Option<&[AcpToolContentItem]>,
    )> {
        match self {
            Self::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                input,
                content,
            }
            | Self::ToolCallUpdate {
                tool_call_id,
                title,
                kind,
                status,
                raw_input,
                input,
                content,
            } => Some((
                tool_call_id.as_deref(),
                title.as_deref(),
                kind.as_deref(),
                status.as_deref(),
                raw_input.as_ref(),
                input.as_ref(),
                content.as_deref(),
            )),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AcpPermissionOption {
    #[serde(rename = "optionId")]
    pub(crate) option_id: String,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionToolCall {
    #[serde(rename = "toolCallId")]
    pub(crate) tool_call_id: String,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) input: Option<Value>,
    #[serde(default)]
    pub(crate) content: Option<Vec<AcpToolContentItem>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionParams {
    #[serde(rename = "toolCall")]
    pub(crate) tool_call: AcpPermissionToolCall,
    #[serde(default)]
    pub(crate) options: Vec<AcpPermissionOption>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AcpPermissionRequest {
    pub(crate) id: i64,
    pub(crate) params: AcpPermissionParams,
}
