# OneAgent V1 Backend Design

## 1. 目标与范围

OneAgent V1 后端的目标是提供一个本地优先、桌面端优先的统一 Agent Runtime 内核，覆盖两类核心场景：

- 作为现有 Agent CLI 的统一可视化后端，负责 Agent 管理、工作区、会话、权限、工具调用和外部会话导入。
- 作为 OneAgent 自己的桌面 WorkerAgent 后端，在指定目录创建任务运行，并复用同一套对话运行时。

V1 当前不实现前端页面细节，但后端需要把这些部分实现到“前端直接接入即可消费”的程度：

- 领域模型
- 存储模型
- 运行时状态机
- Agent 适配器接口
- MCP / Skills / 权限策略
- 桌面端命令接口和事件契约

## 2. 总体架构

后端按职责拆为 6 个子系统：

### 2.1 `channel_api`

职责：

- 面向桌面 UI 暴露统一命令接口
- 提供统一的输入 DTO / 输出 DTO
- 不持有业务状态

当前实现：

- 已通过 `#[tauri::command]` 绑定到真实 Tauri 2 commands。
- 事件通过 `Gateway -> Runtime -> Tauri app handle emit` 统一推送到桌面端。

### 2.2 `gateway`

职责：

- 接收 UI 请求
- 做路径校验、参数校验、输入规整
- 将命令路由到 runtime / storage / capability services
- 不直接管理 Agent 子进程

### 2.3 `runtime`

职责：

- Conversation / TaskRun 生命周期管理
- session/new、session/load、prompt、cancel、set_config
- 事件聚合和投影
- 权限阻塞点协调
- 快照落盘与状态恢复基础

这是后端主内核。

### 2.4 `agent_adapters`

包含两个方向：

- `AcpAdapter`
  - 标准 ACP Agent 主链路
- `CompatAdapter`
  - 非标准 Agent 的兼容接口预留

V1 只承诺 ACP 主链路可用，Compat 先占位，不做实际兼容实现。

### 2.5 `capability_services`

包含：

- `mcp_registry`
  - 工作区级 MCP 配置和透传
- `skill_registry`
  - 仅做 Skills 发现、索引、展示
- `policy_engine`
  - 会话级权限策略

### 2.6 `storage`

职责：

- SQLite 持久化
- 事件溯源主表
- 投影视图
- 快照表
- 仓储层读写

## 3. 模块目录

当前后端目录结构：

```text
src-tauri/
  src/
    agent_adapters/
      acp.rs
      compat.rs
      mod.rs
    capability_services/
      mcp.rs
      policy.rs
      skills.rs
      mod.rs
    channel_api/
      mod.rs
    domain/
      mod.rs
    gateway/
      mod.rs
    runtime/
      mod.rs
    storage/
      mod.rs
    lib.rs
    main.rs
```

说明：

- 当前已经重新接回真实 Tauri 2 壳层。
- 项目额外使用 `rust-toolchain.toml` 固定 `stable` 工具链，避免桌面壳层与后端内核分叉。
- `channel_api` 已形成稳定契约，后续前端接入时不需要重做后端领域层。

## 3.1 当前实现状态

截至当前版本，V1 后端已经具备这些能力：

- 真实 Tauri 2 commands/events 壳层
- SQLite 事件表、投影视图、快照表
- ACP `initialize / session/list / session/new / session/load / session/prompt / session/cancel / session/set_config`
- ACP 长连接 live session actor
- imported session 历史回放
- MCP 工作区配置透传
- Skills 发现、索引、展示
- 会话级权限策略、待处理权限请求持久化
- `fs/*` 与 `terminal/*` client capabilities 的最小可用实现
- WorkerTask 与普通 conversation 共享 runtime

V1 明确仍然不做：

- CompatAdapter 的真实非标准 Agent 兼容实现
- MCP 代理模式
- Skills 注入 / 激活
- 多渠道接入
- 重启后继续原 ACP pending turn

## 4. 领域模型

### 4.1 Workspace

语义：

- 工作区即绝对目录路径
- V1 不做命名工作区聚合

字段：

- `id`
- `cwd`
- `display_name`
- `trusted`
- `created_at`
- `updated_at`

### 4.2 AgentProfile

语义：

- 一个可运行的 Agent 配置
- 绑定一种适配方式和一条命令

字段：

- `id`
- `kind(acp|compat)`
- `name`
- `command`
- `args`
- `env`
- `capabilities_cache`
- `enabled`

### 4.3 Conversation

语义：

- OneAgent 顶层会话实体
- UI 和任务都围绕它展开

字段：

- `id`
- `workspace_id`
- `agent_profile_id`
- `origin(oneagent_managed|agent_discovered|imported|worker_task)`
- `status(idle|starting|ready|running|cancelling|cancelled|failed|completed|closed)`
- `title`
- `created_at`
- `updated_at`
- `last_event_seq`

### 4.4 AgentSessionBinding

语义：

- 平台 Conversation 和底层 Agent session 的绑定关系

字段：

- `id`
- `conversation_id`
- `adapter_kind`
- `remote_session_id`
- `cwd`
- `load_supported`
- `source(discovered|new|imported)`
- `last_synced_at`

### 4.5 TaskRun

语义：

- WorkerAgent 任务实体
- 一个 TaskRun 必须包裹一个 Conversation

字段：

- `id`
- `conversation_id`
- `workspace_id`
- `agent_profile_id`
- `goal`
- `status(pending|running|completed|failed|cancelled)`
- `result_summary`
- `created_at`
- `updated_at`

### 4.6 MessageProjection

语义：

- 面向 UI 的消息视图

字段：

- `id`
- `conversation_id`
- `turn_id`
- `role(user|agent|system|tool)`
- `kind(text|status|plan|terminal|error|diff|resource)`
- `content_json`
- `created_at`

### 4.7 ToolCallProjection

语义：

- 工具调用视图

字段：

- `id`
- `conversation_id`
- `turn_id`
- `tool_call_id`
- `title`
- `kind`
- `status`
- `raw_input_json`
- `raw_output_json`
- `content_json`
- `diffs_json`
- `terminal_ids_json`
- `locations_json`
- `started_at`
- `ended_at`

### 4.8 PermissionDecision

语义：

- 会话级权限决策记录

字段：

- `id`
- `conversation_id`
- `tool_call_id`
- `scope(session)`
- `fingerprint`
- `decision(allow_once|allow_always|reject_once|reject_always|cancelled)`
- `created_at`

### 4.9 PendingPermissionRequest

语义：

- 当前待处理或已归档的权限请求
- 用于 UI 权限弹窗、恢复本地 pending 记录、审计 turn 阻塞点

字段：

- `id`
- `conversation_id`
- `turn_id`
- `tool_call_id`
- `fingerprint`
- `options_json`
- `status(pending|resolved|cancelled|expired)`
- `created_at`
- `resolved_at`

### 4.10 McpServerConfig

语义：

- 工作区级 MCP server 配置

字段：

- `id`
- `workspace_id`
- `name`
- `command`
- `args_json`
- `env_json`
- `enabled`

### 4.11 SkillRecord

语义：

- Skills 索引记录

字段：

- `id`
- `scope(project|user|agent_specific)`
- `name`
- `description`
- `location`
- `source_dir`
- `owner(agent_common|opencode|other)`
- `enabled`
- `diagnostics_json`

### 4.12 TerminalRecord

语义：

- 本地 terminal 会话记录
- 用于工具时间线、终端输出面板、release 后历史保留

字段：

- `id`
- `conversation_id`
- `turn_id`
- `terminal_id`
- `cwd`
- `command`
- `args_json`
- `status(running|exited|killed|released|failed)`
- `stdout_buffer`
- `stderr_buffer`
- `started_at`
- `ended_at`

### 4.13 RuntimeEvent

语义：

- 事件溯源主表

字段：

- `seq`
- `conversation_id`
- `event_type`
- `payload_json`
- `created_at`

### 4.14 ConversationSnapshot

语义：

- Conversation 状态快照

字段：

- `conversation_id`
- `snapshot_version`
- `state_json`
- `event_seq`
- `created_at`

## 5. 存储策略

V1 采用“事件溯源优先 + 投影视图”：

- 所有运行时事实先写入 `runtime_events`
- `conversations`、`message_projections`、`tool_call_projections`、`permission_decisions` 是投影视图
- `conversation_snapshots` 用于加速恢复
- SQLite 是唯一结构化存储

当前 SQLite 表：

- `workspaces`
- `agent_profiles`
- `conversations`
- `agent_session_bindings`
- `task_runs`
- `runtime_events`
- `conversation_snapshots`
- `message_projections`
- `tool_call_projections`
- `permission_decisions`
- `mcp_server_configs`
- `skill_records`

## 6. 会话与任务模型

### 6.1 会话来源

Conversation 分为四类：

- `oneagent_managed`
  - OneAgent 新建并管理
- `agent_discovered`
  - 仅代表外部可发现会话，不默认进入本地主列表
- `imported`
  - 从 discovered 导入接管
- `worker_task`
  - TaskRun 包裹的任务会话

### 6.2 外部会话发现策略

默认策略：

- 只按当前工作区目录调用 `session/list(cwd=workspace.cwd)`
- discovered sessions 单独分组，不和 managed/imported 混排
- 用户导入后，升级为 OneAgent 本地索引会话

### 6.3 WorkerTask 设计

TaskRun 不是独立执行内核，而是：

- `TaskRun + Conversation + AgentSessionBinding`

好处：

- 和普通聊天共用同一运行时
- 可以统一权限流和工具时间线
- 后续可单独列出任务历史

## 7. Agent 适配器设计

统一接口：

- `initialize(profile)`
- `list_sessions(profile, cwd?)`
- `new_session(profile, cwd, mcp_servers)`
- `load_session(profile, remote_session_id, cwd, mcp_servers)`
- `prompt(profile, handle, input, attachments)`
- `cancel(profile, handle)`
- `set_config_option(profile, handle, config_id, value)`
- `close(profile, handle)`

### 7.1 ACP Adapter

当前实现特点：

- 使用子进程 + stdio 进行 JSON-RPC 通信
- 优先按换行分隔 JSON 处理
- 支持：
  - `initialize`
  - `session/list`
  - `session/new`
  - `session/load`
  - `prompt`
  - `session/cancel`
  - `session/set_config`

当前流式实现是可工作的主链路骨架：

- 发送 `prompt`
- 读取 `session/update`
- 聚合 text delta
- 结束时生成 message complete / turn finished

V1 尚未完全覆盖所有 ACP 事件分支，后续可继续扩展：

- 更完整的 tool call 事件映射
- 更完整的 permission request / response 闭环
- terminal 事件细节
- slash command 细化

### 7.2 Compat Adapter

当前仅预留接口，返回 `not implemented in v1`。

目的是保证未来支持非标准 Agent 时：

- 不需要推翻现有 runtime
- 只需要实现新的 adapter

## 8. Runtime 状态机

### 8.1 Conversation 状态

主状态：

- `idle`
- `starting`
- `ready`
- `running`
- `cancelling`
- `cancelled`
- `failed`
- `completed`
- `closed`

常见流转：

- 新建：`starting -> ready`
- 发消息：`ready/idle -> running -> idle`
- 取消：`running -> cancelled`
- 异常：`starting/running -> failed`

### 8.2 Prompt Turn 状态

概念状态：

- `accepted`
- `agent_streaming`
- `waiting_permission`
- `tool_running`
- `completed`
- `cancelled`
- `failed`

当前实现已落地：

- `TurnStarted`
- `UserMessageAccepted`
- `AgentMessageChunkReceived`
- `AgentMessageCompleted`
- `TurnCompleted`
- `TurnCancelled`
- `TurnFailed`

### 8.3 Imported Session 状态

设计状态：

- `discovered`
- `importing`
- `replaying_history`
- `ready`

当前实现：

- 已支持 `load_session`
- 已支持导入后本地建索引并持久跟踪
- 历史回放当前仍需补充为更完整的事件重建

## 9. MCP / Skills / 权限设计

### 9.1 MCP

V1 边界：

- MCP 由 OneAgent 在工作区层统一配置
- 在 `new_session/load_session` 时透传给 Agent
- 不做 OneAgent 自己的 MCP 代理层
- MCP 改动不自动热更新到已经运行的 session

### 9.2 Skills

V1 边界：

- 只做发现与展示
- 不做注入和激活
- 不接管 AgentCLI 自己的 skill runtime

扫描目录：

- `<workspace>/.agents/skills/`
- `<workspace>/.oneagent/skills/`
- `<workspace>/.opencode/skills/`
- `~/.agents/skills/`
- `~/.oneagent/skills/`

策略：

- project-level / agent-specific skills 会受 `Workspace.trusted` 影响
- 当前解析只提取 `SKILL.md` 的标题和首段说明

### 9.3 权限策略

V1 使用会话级权限模型：

- 所有权限决策依赖 `conversation_id + fingerprint`
- 命中 `allow_always / reject_always` 时自动决策
- 未命中时生成待处理权限请求

`fingerprint` 由这些输入归一化构成：

- tool kind
- title
- raw input
- paths

## 10. 公共接口契约

### 10.1 Commands

已定义统一入口：

- `list_agent_profiles`
- `upsert_agent_profile`
- `probe_agent_profile`
- `list_workspaces`
- `open_workspace`
- `list_conversations`
- `list_discovered_sessions`
- `create_conversation`
- `import_conversation`
- `create_task_run`
- `send_user_message`
- `cancel_turn`
- `set_session_config`
- `list_permissions`
- `resolve_permission_request`
- `list_workspace_mcp`
- `upsert_workspace_mcp`
- `list_workspace_skills`
- `get_conversation_timeline`
- `get_conversation_state`

### 10.2 Events

当前 runtime 的标准事件目标：

- `conversation.state_changed`
- `conversation.message_appended`
- `conversation.message_updated`
- `conversation.turn_finished`
- `conversation.permission_requested`
- `conversation.permission_resolved`
- `conversation.tool_call_changed`
- `conversation.terminal_output`
- `task_run.state_changed`
- `agent.profile_probed`

目前事件已经通过通用 emitter 接口抽象出来，后续可直接接回 Tauri 的 event 系统。

## 11. 当前实现状态

### 已完成

- `src-tauri` 后端基础骨架
- 领域模型定义
- SQLite schema 和基础仓储
- 事件表 / 快照表 / 投影视图
- ACP adapter 主链路骨架
- Compat adapter 接口预留
- Runtime 主内核
- Gateway 路由层
- 统一 channel_api 契约
- MCP registry
- Skills 扫描与索引
- 会话级权限策略基础
- 单元测试基础

### 已验证

已通过：

- `cargo check`
- `cargo test`

### 尚未完成

- 真正接回 Tauri commands/events
- 更完整的 ACP 流式事件支持
- imported session 的完整历史回放
- TaskRun 结果摘要自动生成
- 更完整的 tool call / terminal / permission 事件映射
- 更细粒度的异常恢复策略

## 12. 后续建议

建议按这个顺序继续推进：

1. 完成 ACP event 映射
2. 完成 imported session replay
3. 把 `channel_api` 绑定回真正的 Tauri commands/events
4. 增加 runtime / projector / adapter 的集成测试
5. 在此基础上再接前端对话区和右侧活动面板

## 13. 非目标

V1 当前明确不做：

- OneAgent 主动注入 Skills 到 Agent
- OneAgent 自己代理 MCP
- 多渠道接入
- 多进程 daemon
- 非标准 Agent 的完整适配
- 前端页面实现
