//! ACP (Agent Client Protocol) adapter module.
//!
//! This module provides the adapter implementation for agents that communicate
//! via the Agent Client Protocol (ACP), a JSON-RPC protocol over stdin/stdout.
//!
//! ## Module Structure
//!
//! - `adapter.rs`: Main `AgentAdapter` trait implementation
//! - `live_session.rs`: Live session management with streaming events
//! - `process.rs`: JSON-RPC process transport and client handlers (fs/terminal)
//! - `parser.rs`: Protocol parsing functions
//! - `prompt_codec.rs`: Prompt encoding for attachments
//! - `permission.rs`: Permission handling
//! - `types.rs`: Constants and type definitions
//!
//! ## Public Interface
//!
//! The module exports two main types:
//! - `AcpAdapter`: The adapter for the `AgentAdapter` trait
//! - `AcpLiveSession`: For managing live streaming sessions

mod adapter;
mod live_session;
mod parser;
mod permission;
mod process;
mod prompt_codec;
mod types;

// Re-export public types
pub use adapter::AcpAdapter;
pub use live_session::AcpLiveSession;
