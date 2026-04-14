# ACP Refactor Landing Zone

This directory is reserved for splitting `src-tauri/src/agent_adapters/acp.rs` into:

- `adapter.rs`
- `live_session.rs`
- `actor.rs`
- `process.rs`
- `parser.rs`
- `prompt_codec.rs`
- `permission.rs`
- `client_fs.rs`
- `client_terminal.rs`
- `types.rs`

Do not add `mod.rs` here until the parent module is intentionally migrated away from `acp.rs`.

