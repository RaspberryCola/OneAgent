# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OneAgent is a Tauri 2 desktop application that provides a unified interface for managing multiple AI coding agents (Claude Code, OpenCode, Qwen Code, Gemini CLI, Kiro, OpenClaw, etc.) through the **Agent Client Protocol (ACP)**. It also supports a WebUI mode served via an embedded axum HTTP server with JWT authentication.

Inspired by [AionUi](https://github.com/iOfficeAI/AionUi) but built as a desktop app with Tauri + Rust backend.

## Build Commands

```bash
# Setup (after cloning)
git submodule update --init --recursive  # Initialize git submodules (required: src-tauri/wechatbot)
npm install
npm run prepare:claude-runtime           # Download bundled Bun + Claude ACP adapter (required once)

# Development
npm run tauri dev            # Full Tauri dev mode (frontend + backend, port 1420)
npm run dev                  # Vite frontend dev server only

# Build
npm run build                # TypeScript check + Vite build
npm run tauri build          # Full production build

# Rust backend
cd src-tauri && cargo build
cd src-tauri && cargo test
cd src-tauri && cargo clippy   # Lint (configured in rust-toolchain.toml)

# Frontend tests (Vitest)
npm run test                 # Watch mode
npm run test:run             # CI mode
npm run test -- src/lib/utils/__tests__/conversation.test.ts  # Single file

# IM sidecar (Lark/WeChat)
cd im-sidecar && npm install && npm run build
```

## Architecture

### Backend Layers (strict unidirectional dependency)

```
channel_api  →  gateway  →  application  →  runtime / capability_services / storage / agent_adapters
                  ↑ shared by all, depends on none ↑
                              domain
```

| Module | Responsibility |
|--------|---------------|
| `channel_api/` | Tauri IPC commands (`mod.rs`, ~33KB) + WebUI server (`web/`) + IM channels (`im/`). Must stay thin — no business logic. |
| `gateway/` | Facade aggregating services with lightweight validation. Not an orchestration layer. |
| `application/` | Use-case services owning transaction boundaries (create/import/send/cancel, permissions, attachments). |
| `runtime/` | Session lifecycle, streaming, event projection, recovery. Key files: `session_manager.rs`, `stream_processor.rs`, `projector/`, `recovery.rs`, `event_bus.rs`, `snapshot_manager.rs`, `turn.rs`. |
| `agent_adapters/` | `acp/` — JSON-RPC over stdin/stdout for ACP agents (adapter, process, parser, permission, live_session, types). `compat.rs` — legacy protocol adapter. |
| `capability_services/` | MCP registry, skill discovery, policy engine, agent discovery, browser CDP, terminal, crypto. |
| `storage/` | `sqlite/` (connection, migrations, tx), `repositories/` (CRUD per entity), `mappers/` (row→domain), `facade.rs` (unified Database facade). |
| `domain/` | Core types (Workspace, AgentProfile, Conversation, MessageProjection, etc.) and BackendError. **No Tauri, SQLite, or tokio dependencies.** |

**Invariant violations to watch for:**
- `channel_api` must NOT directly access `storage`
- `gateway` must NOT carry multi-step business flows (that's `application`'s job)
- `runtime` must NOT depend on specific SQL details
- Multi-step writes must have explicit transaction boundaries in `application`

### Agent Launch Flow

Agents launch in two modes:
- **Native** — direct command execution
- **NpmAdapter** — via bundled/system Bun or Node runtime

Runtime resolution priority: `BundledBun` → `SystemBun` → `SystemNode`  
Binary resolution priority: bundled Bun → system `bunx` → system `bun x` → system `npx`

The `scripts/prepare-claude-runtime.mjs` downloads the bundled Bun runtime into `src-tauri/resources/bundled-bun/{platform}/` and the `@agentclientprotocol/claude-agent-acp` npm package into `src-tauri/resources/external_agents/`.

### Frontend (React + TypeScript + Vite)

**State management:** Zustand (`src/lib/store.ts`, ~66KB) with a Map-based multi-workspace architecture. Conversations keyed by `workspace_id` for cross-workspace navigation.

**Backend communication:**
- `src/lib/backend/commands.ts` — Tauri IPC command invocations
- `src/lib/backend/events.ts` — Tauri event subscriptions
- `src/lib/backend/transport.ts` — Transport abstraction (Tauri IPC vs Web REST/WS for WebUI mode)
- `src/lib/backend/types.ts` — TypeScript types matching Rust domain types

**Path alias:** `@/*` maps to `./src/*`

**Key custom hooks:** `useSearch`, `useWorkspaceFileTree`, `useModelSelector`, `useModeSelector`, `useAttachmentHandler`, `useScrollManager`, `useConversationComposer`, `useGitDiff`

**Key utilities:** `src/lib/utils/conversation.ts` (cross-workspace lookup, title building), `src/lib/utils/timeline.ts` (item merging, key generation), `src/lib/utils/settings.ts` (LocalStorage persistence), `src/lib/utils/constants.ts` (sync config)

### Event System

Frontend subscribes to real-time Tauri events via `src/lib/backend/events.ts`. Key event families:
- `conversation:*` — `state_changed`, `message_appended`, `message_updated`, `tool_call_changed`, `permission_requested`, `permission_resolved`, `terminal_output`, `turn_finished`, `deleted`
- `task_run:state_changed`
- `agent:profile_probed`

**Stable contract:** These event names and their JSON shapes are stable — do not rename or restructure them without migration.

### Permission Flow

1. Runtime emits `conversation:permission_requested` event
2. Frontend shows pending permission UI
3. User decides: `allow_once` | `allow_always` | `reject_once` | `reject_always`
4. Frontend calls `resolvePermissionRequest`
5. Runtime forwards decision to adapter; agent continues

## Design System

Ollama-inspired minimalism. See `FRONTEND_DESIGN.md` for full spec.

- **Palette:** Pure grayscale only. The only chromatic color is `#3b82f6` at 50% for keyboard focus rings — never visible in normal flow.
- **Border-radius:** 3 tiers — 12px (containers/cards), 8px (interactive: buttons, inputs, tabs, tags), 9999px (pill: reserved for homepage Agent switcher and toggle switches only).
- **Typography:** SF Pro Rounded for display headlines, system sans for body. Only weights 400 (body) and 500 (headings) — no bold.
- **Depth:** Zero shadows. Separation via background color shifts and 1px borders only.
- **Tailwind config:** Custom grayscale palette and border-radius tiers in `tailwind.config.ts`.

## Configuration Files

| File | Purpose |
|------|---------|
| `src-tauri/tauri.conf.json` | Tauri v2 app config, window settings, bundle resources |
| `src-tauri/Cargo.toml` | Rust dependencies |
| `src-tauri/capabilities/default.json` | Tauri v2 permissions for the main window |
| `src-tauri/rust-toolchain.toml` | Rust stable toolchain with clippy + rustfmt |
| `package.json` | Frontend dependencies and scripts |
| `tailwind.config.ts` | Tailwind config with custom grayscale palette and 3-tier border-radius |
| `tsconfig.json` | TypeScript strict mode, ESNext, `@/*` path alias |
| `vite.config.ts` | Vite + React + Vitest config (port 1420) |
| `.claude/agents/frontend-developer.md` | Custom Claude Code agent for frontend work |

## Troubleshooting

**Runtime preparation fails:** Run `npm run prepare:claude-runtime` manually. Check network connectivity to GitHub.

**Agent not discovered:** Verify the agent CLI is in PATH. Call `listAgentDiscoveryStatus` to diagnose.

**Conversation stuck in "initializing":** Check backend logs (`tracing` output) for adapter spawn errors. May indicate missing runtime (Bun/Node) or auth issues (Claude requires `CLAUDE_API_KEY`).

**Frontend tests failing:** Ensure `jsdom` environment is configured in `vite.config.ts`. Some tests may require Tauri API mocks.

## Notes

- Default workspace: `~/.oneagent/workspace/`
- Global skills: `~/.oneagent/skills/`
- Application data (database, keys, auth config) stored in system directories (e.g., `~/Library/Application Support/oneagent/` on macOS)
- Agent profiles auto-discovered on startup from installed tools
- MCP servers configured per-workspace
- Skills discovered from `.claude/skills/` directories
- **IM Sidecar:** `im-sidecar/` is a separate Node.js process for Lark and WeChat bot integration
- **WebUI mode:** Same backend serves HTTP/WebSocket via axum (see `channel_api/web/`)
- **CI/CD:** GitHub Actions release workflow (`.github/workflows/release.yml`) builds for macOS, Ubuntu (deb), and Windows (nsis) on `v*` tags
- **Git submodule:** `src-tauri/wechatbot/` — WeChat bot protocol library. Run `git submodule update --init` after cloning.
