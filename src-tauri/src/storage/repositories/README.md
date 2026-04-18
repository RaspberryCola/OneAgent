# Storage Repositories Status

Repository-oriented persistence modules currently in use:

- `agent_profiles.rs`
- `workspaces.rs`
- `conversations.rs`
- `events.rs`
- `permissions.rs`
- `terminals.rs`
- `skills.rs`

Notes:

- `task_runs` and `snapshots` are currently implemented in `conversations.rs`.
- `messages` and `tool_calls` are currently implemented in `events.rs`.
- `mcp` is currently implemented in `terminals.rs`.
- Further physical splits are optional cleanup and can be scheduled independently.
