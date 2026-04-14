# ACP Module - Refactored

This directory contains the ACP (Agent Client Protocol) adapter implementation, split into focused modules.

## Module Structure

| File | Purpose | Lines (approx) |
|------|---------|----------------|
| `mod.rs` | Public interface and re-exports | ~30 |
| `adapter.rs` | `AcpAdapter` and `AgentAdapter` trait implementation | ~220 |
| `live_session.rs` | `AcpLiveSession`, `LiveSessionCommand`, actor loop (`spawn_live_actor`, `run_turn_loop`) | ~580 |
| `process.rs` | `JsonRpcProcess`, terminal/fs client handlers, `TerminalHandle` | ~700 |
| `parser.rs` | All `parse_*` functions, `extract_and_strip_think_tags`, `extract_content/paths` | ~550 |
| `prompt_codec.rs` | Prompt building, attachment encoding (`build_prompt_blocks_from_message`) | ~150 |
| `permission.rs` | Permission handling (`parse_permission_request`, `send_permission_decision`) | ~120 |
| `types.rs` | Constants (`ACP_PROTOCOL_VERSION`, `MAX_EMBEDDED_*`) | ~20 |

## Public Interface

The module exports two public types:
- `AcpAdapter` - Implements the `AgentAdapter` trait
- `AcpLiveSession` - For managing live streaming sessions

## Internal Dependencies

```
adapter.rs
  └── live_session.rs (AcpLiveSession)
  └── parser.rs (parse_agent_capabilities, etc.)
  └── prompt_codec.rs (build_prompt_blocks)
  └── process.rs (JsonRpcProcess)

live_session.rs
  └── process.rs (JsonRpcProcess)
  └── parser.rs (parse_session_update, parse_config_options, etc.)
  └── permission.rs (send_permission_decision)
  └── prompt_codec.rs (build_prompt_blocks)

process.rs
  └── parser.rs (jsonrpc_error_message)
  └── types.rs (ACP_PROTOCOL_VERSION)

permission.rs
  └── parser.rs (extract_paths)
  └── live_session.rs (PermissionOption struct)

prompt_codec.rs
  └── types.rs (MAX_EMBEDDED_* constants)
```

## Remaining Coupling

1. **process.rs contains all client handlers** - fs and terminal handlers remain as methods on `JsonRpcProcess`. Could be further split into `client_fs.rs` and `client_terminal.rs` using separate impl blocks.

2. **live_session.rs contains actor** - `spawn_live_actor` and `run_turn_loop` are in `live_session.rs` to avoid circular dependency with process.rs. Could be extracted to `actor.rs` in a follow-up.

3. **parser.rs returns RuntimeStreamEvent** - This couples parser to `agent_adapters/mod.rs` types. Acceptable for current phase.

## Future Work (C2 - Type化)

After physical split is stable, type化 should start from:
- `parser.rs` - Define typed structs for ACP messages
- `types.rs` - Add typed protocol message definitions
- Replace `serde_json::Value` with typed structs in parser output