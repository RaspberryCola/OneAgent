# OneAgent

<p align="right">
  <strong>English</strong> | <a href="./README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="public/oneagent_horizontal.svg" alt="OneAgent" width="420" />
</p>

<p align="center">
  <strong>A unified desktop workspace for multiple AI coding agents</strong>
</p>

<p align="center">
  Built with Tauri + ACP to manage Claude Code, OpenCode, Qwen Code, Gemini CLI, Kiro, OpenClaw, and more in one place with workspace isolation, conversation history, MCP integration, and permission controls.
</p>

<p align="center">
  <a href="#why-oneagent">Why OneAgent</a> •
  <a href="#highlights">Highlights</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#supported-agents">Supported Agents</a> •
  <a href="#development">Development</a>
</p>

## Screenshots

### Main Workspace

![OneAgent main workspace](docs/assets/main-home.png)

### Chat Session

![OneAgent chat session](docs/assets/main-chat.png)

---

## Why OneAgent

When working with multiple AI coding agents, common pain points include fragmented terminals, split context, and unclear permission boundaries.  
OneAgent brings everything into a single desktop workspace:

- One UI to manage multiple agents
- Workspace-level isolation for conversations and settings
- Explicit permission decisions for high-risk actions
- MCP-based extensibility for custom tools and integrations

## Inspiration

This project is inspired by [AionUi](https://github.com/iOfficeAI/AionUi). At the current stage, OneAgent is still primarily a faithful recreation of that interaction model.

Our main implementation difference is the architecture choice: OneAgent is built as a desktop app with **Tauri + Rust** for the backend runtime, while keeping a modern frontend workflow.

## Highlights

### Unified Multi-Agent Access
- Standardized communication through **Agent Client Protocol (ACP)**
- Automatic discovery of locally installed agents
- Switch between agent profiles in the same UX

### Workspace and Session Management
- Multi-workspace isolation for chats, bindings, and config
- Persistent conversation history for replay and continuation
- IDE-like workflow with less context switching

### MCP Extensibility
- Connect Model Context Protocol (MCP) servers
- Configure tools and capability extensions per workspace

### Granular Permission Controls
- Review sensitive operations such as file writes and command execution
- Supports `allow_once` / `allow_always` / `reject_once` / `reject_always`

## Quick Start

### Requirements

- macOS 12+ / Windows 10+ / Linux
- Node.js 18+
- Rust 1.70+

### Run from Source

```bash
git clone https://github.com/RaspberryCola/OneAgent.git
cd OneAgent

npm install

# Download bundled Bun and Claude ACP adapter (recommended once)
npm run prepare:claude-runtime

# Start full Tauri development mode
npm run tauri dev
```

### Build

```bash
npm run build
npm run tauri build
```

## Usage

### First Launch
1. On startup, OneAgent creates a default workspace at `~/.oneagent`
2. The app automatically discovers available agent profiles

### Create a Session
1. Select an agent profile
2. Create a new session and choose a target workspace
3. Enter your prompt and start the conversation

### Handle Permission Requests
When an agent asks for high-risk capabilities (such as file writes or command execution):
- Approve or reject in the permission dialog
- Choose one-time or persistent rules based on context

## Supported Agents

| Agent | Status | Integration |
|------|------|------|
| Claude Code | ✅ | ACP Bridge |
| OpenCode | ✅ | ACP |
| Qwen Code | ✅ | ACP |
| Gemini CLI | ✅ | ACP |
| Kiro | ✅ | ACP |
| OpenClaw | ✅ | ACP |
| Other ACP-compatible agents | 🚧 | Validation in progress |

## Development

### Common Commands

```bash
# Frontend dev server (Vite)
npm run dev

# Tauri dev mode (frontend + backend)
npm run tauri dev

# Build (includes TypeScript checks)
npm run build

# Build desktop app
npm run tauri build

# Build Rust backend only
cd src-tauri && cargo build

# Run Rust tests
cd src-tauri && cargo test
```

### Project Structure (Simplified)

```text
.
├── src/                    # React + TypeScript frontend
├── src-tauri/              # Rust + Tauri backend
├── scripts/                # Tooling scripts (including runtime prep)
├── public/                 # Static assets (logos, etc.)
└── docs/                   # Design and architecture docs
```

## Roadmap

- [ ] Validate and support more ACP-compatible agents
- [ ] Improve cross-platform packaging and install docs
- [ ] Add polished UI screenshots and demo GIFs

## Contributing

Issues and pull requests are welcome.  
Before submitting, please run:

```bash
npm run build
cd src-tauri && cargo test
```

## License

[MIT](LICENSE) © OneAgent Contributors
