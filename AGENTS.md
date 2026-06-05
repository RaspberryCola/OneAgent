# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

OneAgent is a Tauri desktop application that provides a unified interface for managing multiple AI coding agents (Claude Code, OpenCode, Goose, etc.) through the Agent Client Protocol (ACP). It enables workspace management, conversation history, MCP server integration, and permission handling.

## Build Commands

```bash
# Setup (after cloning)
git submodule update --init --recursive  # Initialize git submodules (required: src-tauri/wechatbot)
npm install                             # Install frontend dependencies
npm run prepare:claude-runtime           # Download bundled Bun runtime and Claude adapter (required once)

# Development
npm run dev                  # Start Vite frontend dev server (port 1420)
npm run tauri dev            # Full Tauri development mode (frontend + backend)

# Build
npm run prepare:claude-runtime  # Download bundled Bun runtime and Claude adapter (required once)
npm run build                # TypeScript check + Vite build
npm run tauri build          # Full production build

# Tauri-specific
cd src-tauri && cargo build  # Build Rust backend only
cd src-tauri && cargo test   # Run Rust tests
cd src-tauri && cargo clippy # Lint Rust code (configured in rust-toolchain.toml)

# IM sidecar (Lark/WeChat integration)
cd im-sidecar && npm install && npm run build  # Build IM sidecar

# Frontend tests
npm run test                 # Run Vitest in watch mode
npm run test:run             # Run Vitest once (CI mode)

# Run a single test file
npm run test -- src/lib/utils/__tests__/conversation.test.ts
```

## Architecture

### Frontend (React + TypeScript + Vite)

**Core Files:**
- `src/App.tsx` - Main application component with layout
- `src/lib/store.ts` - Zustand state management (workspace, conversations, agents, timeline)
- `src/lib/backend/commands.ts` - Tauri command invocations
- `src/lib/backend/events.ts` - Tauri event subscriptions
- `src/lib/backend/transport.ts` - Transport abstraction (Tauri IPC vs Web REST/WS for WebUI mode)
- `src/lib/backend/types.ts` - TypeScript types matching Rust domain types

**Custom Hooks:**
- `useSearch` - Workspace file and conversation search
- `useWorkspaceFileTree` - File tree navigation
- `useModelSelector` - Model selection with state management
- `useModeSelector` - Agent mode selection
- `useAttachmentHandler` - File attachment handling
- `useScrollManager` - Chat scroll behavior management
- `useConversationComposer` - Message composition and sending
- `useGitDiff` - Git diff display

**Utilities:**
- `src/lib/utils/conversation.ts` - Conversation helpers (title building, status checks, cross-workspace lookup)
- `src/lib/utils/timeline.ts` - Timeline item merging, key generation, message/tool_call/terminal merging
- `src/lib/utils/settings.ts` - LocalStorage-based settings persistence
- `src/lib/utils/constants.ts` - Sync configuration (poll intervals, grace periods)

**Path Alias:** `@/*` maps to `./src/*` (configured in `tsconfig.json`).

State management uses a Map-based multi-workspace architecture where conversations are keyed by workspace_id for cross-workspace navigation.

### Backend (Rust + Tauri)

**Module Structure:**

| Module | Purpose |
|--------|---------|
| `domain/` | Core domain types (Workspace, AgentProfile, Conversation, MessageProjection, etc.) and BackendError definitions |
| `gateway/` | Facade layer — aggregates services, does lightweight validation; NOT a business orchestration layer |
| `application/` | Use-case services (create/import/send/cancel, permissions, attachments) — owns transaction boundaries |
| `runtime/` | Session orchestration, streaming, event projection, recovery |
| `channel_api/` | Tauri IPC commands exposed to frontend — must stay thin |
| `storage/` | SQLite database operations (workspaces, profiles, conversations, bindings, events) |
| `agent_adapters/` | Protocol adapters for AI agents (ACP, compat) |
| `capability_services/` | MCP registry, skill discovery, policy engine, agent discovery, browser CDP, terminal |

**Dependency direction (strict, no exceptions):**
```
channel_api -> gateway -> application -> runtime / capability_services / storage / agent_adapters
domain is shared by all backend modules but depends on none of the above
```
- `channel_api` must NOT directly access `storage`
- `domain` must NOT depend on Tauri, SQLite, or tokio subprocess details

**Storage Layer:**
- `storage/sqlite/` - Database connection, migrations, transaction management
- `storage/repositories/` - CRUD operations per entity (agent_profiles, conversations, workspaces, permissions, etc.)
- `storage/mappers/` - Row-to-domain mapping logic
- `storage/facade.rs` - Unified Database facade wrapping repository access

**Runtime Module:**
- `runtime/session_manager.rs` - Manages agent session lifecycle
- `runtime/stream_processor.rs` - Processes streaming events from agent subprocesses
- `runtime/projector/` - Event projection to timeline (message, tool_call, terminal, permission)
- `runtime/recovery.rs` - Session recovery and state reconstruction
- `runtime/event_bus.rs` - Event emission to frontend
- `runtime/snapshot_manager.rs` - Conversation snapshot persistence
- `runtime/turn.rs` - Turn lifecycle management

**Agent Adapters:**

- `agent_adapters/acp/` - ACP protocol adapter (JSON-RPC over stdin/stdout) for agents like Claude Code
  - `adapter.rs` - Adapter trait implementation
  - `process.rs` - Subprocess spawning and management
  - `parser.rs` - JSON-RPC message parsing
  - `permission.rs` - Permission request mapping
  - `live_session.rs` - Live session state
  - `types.rs` - ACP-specific types
- `agent_adapters/compat.rs` - Compatibility adapter for legacy agent protocols

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
- `@agentclientprotocol/claude-agent-acp` npm package into `src-tauri/resources/external_agents/`

These are bundled with the app for offline-ready agent execution.

## Design System

See `FRONTEND_DESIGN.md` for the Ollama-inspired design system:
- Pure grayscale palette (no chromatic colors except focus ring)
- Three-tier border-radius: 12px (containers/cards), 8px (interactive elements — buttons, inputs, tabs, tags), 9999px (pill — reserved for homepage Agent switcher and toggle switches only)
- SF Pro Rounded for headlines, zero shadows
- Font weights: only 400 (body) and 500 (headings) — no bold

## Backend Design Principles

See `BACKEND_DESIGN.md` for detailed backend architecture constraints:
- Strict unidirectional dependency flow: `channel_api -> gateway -> application -> runtime/storage/agent_adapters`
- `domain` module shared by all but depends on none
- `channel_api` must NOT directly access `storage`
- `domain` must NOT depend on Tauri, SQLite, or tokio subprocess details
- Multi-step writes must have explicit transaction boundaries
- Stream event processing must be decomposable into projector commands

## Configuration Files

- `src-tauri/tauri.conf.json` - Tauri app configuration, window settings, bundle resources
- `src-tauri/Cargo.toml` - Rust dependencies
- `src-tauri/capabilities/default.json` - Tauri v2 permissions for the main window
- `package.json` - Frontend dependencies and scripts
- `tailwind.config.ts` - Tailwind config with custom grayscale palette and 3-tier border-radius
- `rust-toolchain.toml` - Rust stable toolchain with clippy + rustfmt
- `.claude/agents/frontend-developer.md` - Custom Claude Code agent for frontend work

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

- Default workspace is at `~/.oneagent/workspace/`
- Global skills are at `~/.oneagent/skills/`
- Application data (database, keys, auth config) is stored in system directories (e.g., `~/Library/Application Support/oneagent/` on macOS)
- Agent profiles are auto-discovered on startup from installed tools
- MCP servers are configured per-workspace
- Skills are discovered from `.claude/skills/` directories
- **IM Sidecar:** `im-sidecar/` is a separate Node.js process for Lark and WeChat bot integration (depends on `@larksuiteoapi/node-sdk`). Build with `cd im-sidecar && npm run build`.
- **WebUI mode:** The app can also run as a web application (not just desktop) with JWT-based authentication, served via an embedded axum HTTP server (see `channel_api/web/`).
- **CI/CD:** GitHub Actions release workflow (`.github/workflows/release.yml`) builds for macOS, Ubuntu (deb), and Windows (nsis) on `v*` tags.
- **Git submodule:** `src-tauri/wechatbot/` — WeChat bot protocol library from corespeed-io. Run `git submodule update --init` after cloning.

## Troubleshooting

**Runtime preparation fails:** Run `npm run prepare:claude-runtime` manually to download bundled Bun and Claude ACP adapter. Check network connectivity to GitHub.

**Agent not discovered:** Verify the agent CLI is in PATH. Run "Refresh Agent Discovery" from the UI or call `listAgentDiscoveryStatus` to diagnose.

**Conversation stuck in "initializing":** Check backend logs (`tracing` output) for adapter spawn errors. May indicate missing runtime (Bun/Node) or authentication issues (Claude requires `CLAUDE_API_KEY`).

**Frontend tests failing:** Ensure `jsdom` environment is correctly configured in `vitest.config.ts`. Some tests may require Tauri API mocks.