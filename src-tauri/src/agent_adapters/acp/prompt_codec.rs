//! ACP prompt encoding functions.
//!
//! This module handles building prompt blocks from user messages and attachments,
//! converting them to the ACP protocol format.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde_json::{json, Value};

use crate::{
    agent_adapters::{AdapterError, AdapterResult},
    domain::{
        AgentPromptCapabilities, AttachmentDeliveryPreference, AttachmentInput, AttachmentKind,
        AttachmentUsageIntent,
    },
};

use super::types::{MAX_EMBEDDED_AUDIO_BYTES, MAX_EMBEDDED_IMAGE_BYTES, MAX_EMBEDDED_TEXT_BYTES};

/// Build prompt blocks from a user message and optional attachments.
pub async fn build_prompt_blocks_from_message(
    input: &str,
    attachments: &[AttachmentInput],
    capabilities: &AgentPromptCapabilities,
) -> AdapterResult<Vec<Value>> {
    let mut prompt = vec![json!({
        "type": "text",
        "text": input
    })];
    for attachment in attachments {
        prompt.push(build_attachment_block(attachment, capabilities).await?);
    }
    Ok(prompt)
}

/// Build an attachment block for inclusion in a prompt.
///
/// Determines the appropriate encoding based on attachment kind,
/// agent capabilities, and file size constraints.
async fn build_attachment_block(
    attachment: &AttachmentInput,
    capabilities: &AgentPromptCapabilities,
) -> AdapterResult<Value> {
    let path = PathBuf::from(&attachment.path);
    let metadata = tokio::fs::metadata(&path).await?;
    let inferred_mime = attachment
        .mime_type
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            mime_guess::from_path(&path)
                .first_raw()
                .unwrap_or("application/octet-stream")
                .to_string()
        });
    let uri = format!("file://{}", path.display());
    let prefer_resource_link = matches!(
        attachment.delivery_preference,
        AttachmentDeliveryPreference::ResourceLink
    ) || matches!(attachment.usage_intent, AttachmentUsageIntent::FileResource);

    // If resource_link is preferred and supported, use it
    if capabilities.resource_link && prefer_resource_link {
        return Ok(resource_link_block(&attachment.name, &uri, &inferred_mime));
    }
    // If caller explicitly prefers file-resource semantics but agent has no
    // structured resource_link support, degrade to a controlled text hint.
    if prefer_resource_link && capabilities.text {
        return Ok(fallback_text_path_block(&attachment.name, &uri, &inferred_mime));
    }

    match attachment.kind {
        AttachmentKind::Image if capabilities.image => {
            if metadata.len() <= MAX_EMBEDDED_IMAGE_BYTES
                && !prefer_resource_link
            {
                let bytes = tokio::fs::read(&path).await?;
                return Ok(json!({
                    "type": "image",
                    "mimeType": inferred_mime,
                    "data": BASE64_STANDARD.encode(bytes),
                    "uri": uri
                }));
            }
        }
        AttachmentKind::Audio if capabilities.audio => {
            if metadata.len() <= MAX_EMBEDDED_AUDIO_BYTES
                && !prefer_resource_link
            {
                let bytes = tokio::fs::read(&path).await?;
                return Ok(json!({
                    "type": "audio",
                    "mimeType": inferred_mime,
                    "data": BASE64_STANDARD.encode(bytes),
                    "uri": uri
                }));
            }
        }
        AttachmentKind::File if capabilities.embedded_context => {
            if metadata.len() <= MAX_EMBEDDED_TEXT_BYTES
                && !prefer_resource_link
                && is_text_like_mime(&inferred_mime)
            {
                let text = tokio::fs::read_to_string(&path).await?;
                return Ok(json!({
                    "type": "resource",
                    "resource": {
                        "uri": uri,
                        "mimeType": inferred_mime,
                        "text": text
                    }
                }));
            }
        }
        _ => {}
    }

    // Fall back to resource_link if supported
    if capabilities.resource_link {
        return Ok(resource_link_block(&attachment.name, &uri, &inferred_mime));
    }
    if capabilities.text {
        return Ok(fallback_text_path_block(
            &attachment.name,
            &uri,
            &inferred_mime,
        ));
    }

    Err(AdapterError::Protocol(format!(
        "agent does not support a compatible delivery mode for attachment {}",
        attachment.name
    )))
}

/// Create a resource link block for an attachment.
fn resource_link_block(name: &str, uri: &str, mime_type: &str) -> Value {
    json!({
        "type": "resource_link",
        "name": name,
        "uri": uri,
        "mimeType": mime_type
    })
}

fn fallback_text_path_block(name: &str, uri: &str, mime_type: &str) -> Value {
    json!({
        "type": "text",
        "text": format!(
            "[Attached file]\nname: {name}\nuri: {uri}\nmime_type: {mime_type}"
        )
    })
}

/// Check if a MIME type is suitable for text-based embedded context.
fn is_text_like_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/x-javascript"
                | "application/typescript"
                | "application/x-sh"
                | "application/yaml"
                | "application/x-yaml"
        )
}
