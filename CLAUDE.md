# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OneAgent is a Tauri desktop application that provides a unified interface for managing multiple AI coding agents (Claude Code, OpenCode, Goose, etc.) through the Agent Client Protocol (ACP). It enables workspace management, conversation history, MCP server integration, and permission handling.

## Build Commands

```bash
# Development
npm run dev                  # Start Vite frontend dev server (port 1420)
npm run tauri dev            # Full Tauri development mode (frontend + backend)

# Build
npm run prepare:claude-runtime  # Download bundled Bun runtime and Claude adapter
npm run build                # TypeScript check + Vite build
npm run tauri build          # Full production build

# Tauri-specific
cd src-tauri && cargo build  # Build Rust backend only
cd src-tauri && cargo test   # Run Rust tests
```

## Architecture

### Frontend (React + TypeScript + Vite)

- `src/App.tsx` - Main application component with layout
- `src/lib/store.ts` - Zustand state management (workspace, conversations, agents, timeline)
- `src/lib/backend/commands.ts` - Tauri command invocations
- `src/lib/backend/events.ts` - Tauri event subscriptions
- `src/lib/backend/types.ts` - TypeScript types matching Rust domain types

State management uses a Map-based multi-workspace architecture where conversations are keyed by workspace_id for cross-workspace navigation.

### Backend (Rust + Tauri)

**Module Structure:**

| Module | Purpose |
|--------|---------|
| `domain/` | Core domain types (Workspace, AgentProfile, Conversation, MessageProjection, etc.) and BackendError definitions |
| `gateway/` | API layer coordinating storage and runtime operations |
| `runtime/` | Session orchestration, message handling, event emission, permission management |
| `channel_api/` | Tauri IPC commands exposed to frontend |
| `storage/` | SQLite database operations (workspaces, profiles, conversations, bindings, events) |
| `agent_adapters/` | Protocol adapters for AI agents |
| `capability_services/` | MCP registry, skill discovery, policy engine, agent discovery |

**Agent Adapters:**

- `acp.rs` - ACP protocol adapter (JSON-RPC over stdin/stdout) for agents like Claude Code
- `compat.rs` - Compatibility adapter for legacy agent protocols

The ACP adapter handles:
- Session initialization with `initialize`, `session/new`, `session/load`
- Prompt streaming with text, thinking, tool_call, permission_request events
- Config options (model selection, etc.)
- Permission resolution

**Agent Launch Flow:**

Agents can be launched in two modes:
- `Native` - Direct command execution
- `NpmAdapter` - Via bundled/system Bun or Node runtime

Priority for NpmAdapter: bundled Bun > system bunx > system bun x > system npx

**Runtime Priority:**
- `BundledBun` - Uses pre-packaged Bun in `resources/bundled-bun/{platform}/`
- `SystemBun` - Uses system-installed Bun
- `SystemNode` - Uses system Node.js

### Key Data Flow

1. Frontend calls `bootstrapWorkspace` to load workspace data
2. Gateway coordinates with storage and runtime
3. Runtime creates session via appropriate adapter (ACP/Compat)
4. Adapter spawns agent subprocess, establishes JSON-RPC communication
5. Events stream back through runtime -> gateway -> Tauri emit -> frontend

### Bundled Resources

The `scripts/prepare-claude-runtime.mjs` script downloads:
- Bun runtime from GitHub releases into `src-tauri/resources/bundled-bun/{platform}/`
- `@zed-industries/claude-code-acp` npm package into `src-tauri/resources/external_agents/`

These are bundled with the app for offline-ready agent execution.

## Design System

See `FRONTEND_DESIGN.md` for the Ollama-inspired design system:
- Pure grayscale palette (no chromatic colors except focus ring)
- Binary border-radius: 12px (containers) or 9999px (pill-shaped interactive elements)
- SF Pro Rounded for headlines, zero shadows
- Pill-shaped buttons/inputs/tabs/tags

## Configuration Files

- `src-tauri/tauri.conf.json` - Tauri app configuration, window settings, bundle resources
- `src-tauri/Cargo.toml` - Rust dependencies
- `package.json` - Frontend dependencies and scripts

## Event System

Frontend subscribes to Tauri events via `src/lib/backend/events.ts`:
- `conversation:message_appended` - New message chunk
- `conversation:message_updated` - Message content update
- `conversation:tool_call_changed` - Tool call status change
- `conversation:permission_requested` - Permission request pending
- `conversation:permission_resolved` - Permission decision made
- `conversation:state_changed` - Conversation status change
- `conversation:turn_finished` - Agent turn completed
- `conversation:deleted` - Conversation removed
- `task_run:state_changed` - Task run status update
- `agent:profile_probed` - Agent capabilities discovered

## Permission System

When agents request permissions (file operations, commands, etc.), the runtime:
1. Emits `conversation:permission_requested` event
2. Frontend displays pending permission UI
3. User makes decision (allow_once, allow_always, reject_once, reject_always)
4. Frontend calls `resolvePermissionRequest`
5. Runtime forwards decision to adapter, agent continues

## Notes

- Default workspace is at `~/.oneagent`
- Agent profiles are auto-discovered on startup from installed tools
- The database is SQLite, stored alongside the workspace
- MCP servers are configured per-workspace
- Skills are discovered from `.claude/skills/` directories