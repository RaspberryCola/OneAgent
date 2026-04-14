//! ACP protocol constants and internal type definitions.
//!
//! This module contains constants used throughout the ACP adapter implementation.

/// The ACP protocol version supported by this adapter.
pub const ACP_PROTOCOL_VERSION: u64 = 1;

/// Maximum size for embedded text content (128KB).
pub const MAX_EMBEDDED_TEXT_BYTES: u64 = 128 * 1024;

/// Maximum size for embedded image content (10MB).
pub const MAX_EMBEDDED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Maximum size for embedded audio content (10MB).
pub const MAX_EMBEDDED_AUDIO_BYTES: u64 = 10 * 1024 * 1024;