use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

use crate::domain::{PersistAttachmentBlobInput, PersistAttachmentBlobOutput};

use super::{ApplicationError, ApplicationResult};

#[derive(Clone, Default)]
pub struct AttachmentAppService;

impl AttachmentAppService {
    pub fn new() -> Self {
        Self
    }

    pub fn persist_attachment_blob(
        &self,
        input: PersistAttachmentBlobInput,
    ) -> ApplicationResult<PersistAttachmentBlobOutput> {
        let bytes = BASE64_STANDARD
            .decode(input.base64_data.as_bytes())
            .map_err(|err| ApplicationError::Validation(format!("invalid attachment payload: {err}")))?;
        let extension = input
            .mime_type
            .as_deref()
            .and_then(guess_extension_for_mime)
            .unwrap_or("bin");
        let filename = sanitize_attachment_name(&input.name);
        let stem = filename
            .rsplit_once('.')
            .map(|(base, _)| base.to_string())
            .unwrap_or(filename);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default();
        let path = std::env::temp_dir()
            .join("oneagent-attachments")
            .join(format!("{stem}-{timestamp}.{extension}"));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                ApplicationError::Validation(format!("failed to create temp attachment dir: {err}"))
            })?;
        }
        std::fs::write(&path, bytes)
            .map_err(|err| ApplicationError::Validation(format!("failed to persist attachment: {err}")))?;
        Ok(PersistAttachmentBlobOutput {
            path: path.to_string_lossy().to_string(),
        })
    }
}

fn guess_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" => Some("wav"),
        "audio/webm" => Some("webm"),
        "application/pdf" => Some("pdf"),
        "application/json" => Some("json"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}

fn sanitize_attachment_name(name: &str) -> String {
    let candidate: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if candidate.is_empty() {
        "attachment".to_string()
    } else {
        candidate
    }
}
