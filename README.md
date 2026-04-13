# OneAgent

<p align="center">
  <img src="public/tauri.svg" alt="OneAgent" width="120" />
</p>

<p align="center">
  <strong>AI 编码代理的统一管理界面</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装">安装</a> •
  <a href="#使用方法">使用方法</a> •
  <a href="#支持的代理">支持的代理</a> •
  <a href="#开发">开发</a>
</p>

---

## 简介

OneAgent 是一个基于 Tauri 的桌面应用程序，为多个 AI 编码代理提供统一的管理界面。它实现了 **Agent Communication Protocol (ACP)** 协议，让你可以在一个界面中无缝切换和管理 Claude Code、OpenCode、Goose 等多种 AI 助手。

不再需要在多个终端窗口之间切换，OneAgent 为你提供 IDE 般的体验：工作区管理、对话历史、权限控制，一应俱全。

## 功能特性

### 🎯 多代理管理
- 支持 Claude Code、OpenCode、Goose 等主流 AI 编码代理
- 通过 ACP 协议实现标准化通信
- 自动发现已安装的代理

### 💼 工作区管理
- 类似 IDE 的项目工作区
- 每个工作区独立的配置和对话历史
- 快速切换不同项目

### 💬 对话历史
- 完整的对话记录保存
- 随时回顾之前的对话
- 跨会话的连续性

### 🔌 MCP 服务器集成
- 支持 Model Context Protocol (MCP) 服务器
- 扩展 AI 代理的功能
- 自定义工具和集成

### 🔒 权限管理
- 细粒度的权限控制
- 对文件操作、命令执行等敏感操作进行审批
- 支持允许一次、总是允许、拒绝一次、总是拒绝等多种策略

## 安装

### 系统要求

- macOS 12+ / Windows 10+ / Linux
- Node.js 18+
- Rust 1.70+

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/yourusername/oneagent.git
cd oneagent

# 安装依赖
npm install

# 下载 bundled Bun 运行时和 Claude 适配器
npm run prepare:claude-runtime

# 开发模式
npm run tauri dev

# 构建生产版本
npm run tauri build
```

## 使用方法

### 首次启动

1. 启动 OneAgent 后，默认会在 `~/.oneagent` 创建工作区
2. 应用会自动探测已安装的 AI 代理

### 创建会话

1. 选择左侧的代理配置文件
2. 点击"新建会话"选择工作区
3. 开始与 AI 代理对话

### 管理权限

当代理请求执行敏感操作（如文件写入、命令执行）时：
- 在弹出的权限对话框中选择你的决策
- 可以选择"允许一次"、"总是允许"、"拒绝一次"或"总是拒绝"

## 支持的代理

| 代理 | 状态 | 说明 |
|------|------|------|
| Claude Code | ✅ 已支持 | 通过 ACP 协议 |
| OpenCode | ✅ 已支持 | 通过 ACP 协议 |
| Goose | ✅ 已支持 | 通过 ACP 协议 |
| 其他 ACP 兼容代理 | 🚧 开发中 | 理论支持 |

## 开发

### 项目结构

```
oneagent/
├── src/                    # 前端代码 (React + TypeScript)
│   ├── App.tsx            # 主应用组件
│   ├── lib/               # 工具库
│   │   ├── store.ts       # Zustand 状态管理
│   │   └── backend/       # 后端通信
│   └── components/        # UI 组件
├── src-tauri/             # 后端代码 (Rust)
│   ├── src/
│   │   ├── domain/        # 领域模型
│   │   ├── gateway/       # API 层
│   │   ├── runtime/       # 运行时管理
│   │   ├── agent_adapters/# 代理适配器
│   │   └── storage/       # 数据存储
│   └── Cargo.toml
└── scripts/               # 构建脚本
```

### 技术栈

- **前端**: React 18, TypeScript, Vite, Zustand
- **后端**: Rust, Tauri
- **数据库**: SQLite
- **协议**: ACP (Agent Communication Protocol)

### 常用命令

```bash
# 前端开发服务器
npm run dev

# Tauri 开发模式（前端 + 后端）
npm run tauri dev

# 类型检查
npm run build

# 生产构建
npm run tauri build

# 仅构建 Rust 后端
cd src-tauri && cargo build

# 运行 Rust 测试
cd src-tauri && cargo test
```

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开 Pull Request

## 许可证

[MIT](LICENSE) © OneAgent Contributors

---

<p align="center">
  使用 ❤️ 和 Rust + React 构建
</p>
