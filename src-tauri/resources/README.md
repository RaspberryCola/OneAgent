This directory stores bundled runtime resources for external agents.

- `bundled-bun/<platform>/bun[.exe]`: Bun runtime copied by `npm run prepare:claude-runtime`
- `external_agents/claude-agent-acp/<version>/...`: Bundled Claude ACP adapter package

These resources are prepared during `npm run prepare:claude-runtime` and packaged through `src-tauri/tauri.conf.json`.
