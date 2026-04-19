# OneAgent Backend Design

## 1. 文档目的

本文档定义 OneAgent 后端的长期设计规范。

它不是某个阶段性版本的“实现说明”，而是后端在未来持续演进时都应遵守的架构约束、模块边界和工程原则。

目标是让后端具备以下特征：

- 单进程桌面应用场景下的清晰分层
- 长期可维护
- 低耦合、可替换、可测试
- 允许多个 agent / 多个开发者并行演进
- 兼容当前产品需求，并为后续协议、能力和运行时扩展留接口

## 1.1 实施现状快照（2026-04-19）

- `storage` 已完成 `sqlite/repositories/mappers` 物理拆分，并已引入 `sqlite/tx.rs`。
- `runtime` 已完成 `session_manager/recovery/stream_processor/projector/snapshot_model` 拆分并接线。
- `application` 已接入 `Gateway` 主流程，不再是纯占位目录。
- ACP 已目录化拆分，关键消息族已完成类型化解析。
- 事务覆盖关键多写流程（`import/cancel/delete/permission resolve`）已完成原子化。
- 回归测试矩阵已覆盖事务关键路径与 runtime 投影关键行为。
- 当前主要缺口为 D3：异步路径中的同步 SQLite 访问边界仍需继续硬化。

## 1.2 Refactor 追踪（合并自 `docs/backend-refactor-next.md`）

### 稳定契约（禁止破坏）

- 现有 Tauri command 名称与 request/response JSON 字段
- 现有 runtime 事件名：
  - `conversation:state_changed`
  - `conversation:message_appended`
  - `conversation:message_updated`
  - `conversation:tool_call_changed`
  - `conversation:permission_requested`
  - `conversation:permission_resolved`
  - `conversation:terminal_output`
  - `conversation:turn_finished`
  - `task_run:state_changed`
- SQLite 存储位置与 identity 语义

### 当前焦点（P0）

- D3 边界/性能硬化：降低高频流路径的同步 DB 压力，持续为后续 `spawn_blocking`/连接池迁移保留明确 seam。

## 2. 设计目标

OneAgent 后端是桌面端本地运行的统一 Agent Runtime。它的职责不是做“所有事情”，而是为上层 UI 和下层 agent/protocol 之间提供稳定、可演进的中间层。

后端应满足以下目标：

- 统一管理 workspace、conversation、task run、permission、tool call、terminal 等核心实体
- 对接不同 agent/protocol，但不把协议细节扩散到全局
- 对外提供稳定 command 和事件契约
- 对内保持用例编排、运行时、协议适配、存储四大层次的清晰边界
- 在失败、恢复、重启、并发和逐步重构场景下保持行为可预测

## 3. 核心原则

### 3.1 单向依赖

后端必须遵循单向依赖：

```text
channel_api -> gateway -> application -> runtime / capability_services / storage / agent_adapters
domain 被所有后端模块共享，但不依赖上层
```

禁止出现：

- `channel_api` 直接操作 `storage`
- `gateway` 直接承载多步业务流程
- `runtime` 依赖具体 SQL 细节
- `domain` 依赖 Tauri、SQLite、tokio 子进程等基础设施

### 3.2 先定义边界，再追求抽象

后端设计不追求“抽象很多层”，而追求：

- 每一层为什么存在是清楚的
- 每个模块的责任是单一的
- 依赖方向是稳定的

如果一个模块同时承载多个抽象层次，即使文件不大，也是不合格设计。

### 3.3 Facade 稳定优先

重构时优先保持 facade 稳定，再迁移内部实现。

这意味着：

- 可以先增加 wrapper / re-export
- 可以先抽实现，再逐步迁移调用方
- 不鼓励“一次性把所有调用点全改掉”

### 3.4 结构改造与行为改造分离

后端结构调整应尽量和语义修改分开：

1. 先拆文件和边界
2. 再迁移逻辑
3. 再修改行为

这样才能降低回归风险并提高 review 可读性。

### 3.5 对外契约稳定

在没有明确协议升级计划前，下列内容默认稳定：

- Tauri command 名称
- command 请求/响应 JSON 结构
- runtime emit 的事件名称
- conversation / task / permission 的核心语义

## 4. 模块分层

### 4.1 `channel_api`

职责：

- 暴露 `#[tauri::command]`
- 反序列化输入
- 调用 `gateway`
- 把错误转换为对前端稳定的错误结构

不负责：

- 业务编排
- 路径修正以外的领域校验
- 运行时状态修复
- 存储细节

### 4.2 `gateway`

职责：

- 后端 facade
- 聚合多个 service 的返回结果
- 做轻量输入校验与参数整形

不负责：

- 多步业务流程
- 多次持久化写入的编排
- 协议/适配器实现细节

### 4.3 `application`

这是后端用例服务层。

职责：

- 承载明确的业务用例
- 管理事务边界
- 协调 runtime、repositories、capability services、adapters

典型用例：

- CreateConversation
- ImportConversation
- SendUserMessage
- CancelTurn
- ResolvePermission
- BootstrapWorkspace
- PersistAttachment

原则：

- 一个 public 方法应对应一个清晰业务动作
- 用例层不写原始 SQL
- 用例层不解析协议报文

### 4.4 `runtime`

这是会话运行时层。

职责：

- 管理 live session 池
- 管理热/冷会话与恢复
- 推进运行时状态机
- 接收 agent stream event
- 把 stream event 分派给 projector / event bus

不负责：

- 仓储实现
- command DTO 拼装
- 长篇协议解析代码

### 4.5 `agent_adapters`

职责：

- 封装 agent/protocol 差异
- 向 runtime 提供统一行为接口

当前设计原则：

- 上层只依赖统一 adapter trait
- 协议细节只停留在 adapter 内部
- 协议 transport、parser、prompt codec、permission mapping 应进一步分层

### 4.6 `storage`

职责：

- 提供持久化能力
- 管理 migrations
- 管理 transaction
- 提供 repositories
- 管理 read model / snapshot / event log 的持久化

不负责：

- 业务流程编排
- 前端 DTO 组装
- 运行时状态机

### 4.7 `capability_services`

职责：

- 承担横切能力
- 不承载主业务流程

典型包括：

- MCP registry
- skill discovery/index
- permission policy engine
- agent discovery / launch helper

### 4.8 `domain`

职责：

- 承载后端共享领域模型和规则
- 提供稳定的类型基础

原则：

- `domain` 必须尽量与具体基础设施解耦
- 若某个类型只服务于某个 adapter 内部，不应进入 `domain`
- 若某个类型是对外 API DTO，不应与内部 snapshot model 混为一谈

## 5. 推荐目录结构

目标目录结构如下：

```text
src-tauri/src/
  application/
  runtime/
  agent_adapters/
  storage/
  capability_services/
  domain/
  gateway/
  channel_api/
  lib.rs
  main.rs
```

进一步建议：

```text
runtime/
  mod.rs
  session_manager.rs
  recovery.rs
  stream_processor.rs
  projector.rs
  event_bus.rs
  types.rs

agent_adapters/acp/
  mod.rs
  adapter.rs
  live_session.rs
  actor.rs
  process.rs
  parser.rs
  prompt_codec.rs
  permission.rs
  client_fs.rs
  client_terminal.rs
  types.rs

storage/
  mod.rs
  sqlite/
    connection.rs
    migrations.rs
    tx.rs
  repositories/
  mappers/
```

## 6. 领域建模规范

### 6.1 核心实体

后端至少应围绕以下实体建模：

- Workspace
- AgentProfile
- Conversation
- AgentSessionBinding
- TaskRun
- RuntimeEvent
- ConversationSnapshot
- MessageProjection
- ToolCallProjection
- PendingPermissionRequest
- PermissionDecision
- TerminalRecord

### 6.2 实体与投影分离

必须区分：

- 领域实体
- 事件
- projection/read model
- API DTO
- snapshot model

禁止把它们混为同一个结构只是因为“字段差不多”。

例如：

- `ConversationState` 可以作为对外聚合视图
- 但不应默认作为 snapshot 内部存储模型

### 6.3 状态建模必须显式

所有长生命周期对象都应显式状态化，例如：

- conversation runtime state
- task run status
- tool call status
- pending permission status
- terminal status

原则：

- 状态枚举必须比字符串字面量优先
- 状态转换规则应集中，而不是在多个模块中隐式散落

## 7. 状态与一致性规范

### 7.1 哪些状态是持久化真相，哪些是内存态

必须明确区分：

- 内存实时态
- 持久化快照态
- 可回放事件态

推荐规则：

- live session 是否存在：以内存态为准
- 历史审计与回放：以 event log 为准
- UI 初始化聚合视图：以 snapshot + projection 为准
- 跨重启不可直接相信的“实时连接状态”：不得持久化为强真相

### 7.2 多步写入必须有事务边界

任何一个业务用例，只要包含多次相关写入，就必须定义事务边界。

典型包括：

- create conversation
- import conversation
- create task run
- resolve permission
- cancel turn

原则：

- 事务边界属于 `application` + `storage/tx`
- 不能依赖“按顺序成功执行通常没问题”

### 7.3 Snapshot 不是 DTO 缓存

Snapshot 的作用应是：

- 加速恢复
- 降低初始化聚合成本
- 保存内部稳定状态

不应让 snapshot 成为“把整个前端返回 JSON 原样塞进数据库”。

### 7.4 Event log 不是杂项日志

Event log 必须有清晰用途：

- 历史审计
- 故障排查
- replay / recovery 辅助

如果一个事件既不服务恢复，也不服务诊断，也不服务审计，就不应随意追加。

## 8. Adapter 设计规范

### 8.1 上层只依赖统一接口

`runtime` 和 `application` 层只能依赖 adapter trait 暴露出的能力，不应感知协议细节。

### 8.2 协议内部分层

每个复杂协议 adapter 都必须进一步拆分：

- facade
- live session API
- actor
- transport
- parser
- codec
- local capability bridge

禁止把它们堆在一个文件中长期存在。

### 8.3 `Value` 只留在协议边界

`serde_json::Value` 可以用于：

- 原始协议输入输出
- 短期兼容层

但不应在整个系统中当通用业务模型使用。

原则：

- 越靠近业务层，类型越应明确
- 越靠近协议边界，越可以保留 `Value`

## 9. 存储设计规范

### 9.1 存储层分工

存储层至少分成四类职责：

- connection
- migrations
- repositories
- row mappers / serialization helpers

### 9.2 Repository 以聚合或读模型边界组织

推荐按以下边界组织：

- conversations
- task_runs
- events
- snapshots
- messages
- tool_calls
- permissions
- terminals
- mcp
- skills
- agent_profiles
- workspaces

### 9.3 不把所有查询放进一个 `Database` 巨型对象

`Database` 或 `Storage` facade 可以存在，但只应作为：

- 连接持有者
- repository 组合入口
- transaction 入口

不应继续演化成“所有 CRUD 都在里面”。

### 9.4 允许当前继续使用 SQLite，但必须隔离边界

当前是否使用 `rusqlite` 不是最关键问题。

关键是：

- 上层不依赖具体 driver
- 高频流式路径不要散落大量同步查询
- 未来如需优化为连接池或 blocking boundary，不能重新推翻全局结构

## 10. Runtime 设计规范

### 10.1 Runtime 的职责边界

`runtime` 只负责运行时协调，不负责一切业务。

必须拆分的内部职责：

- session manager
- recovery
- stream processor
- projector
- event bus

### 10.2 Stream event 处理必须可拆

任何类似 `apply_stream_event` 的函数，如果同时做以下多件事，就必须继续拆：

- 推状态
- 写 projection
- 写 event log
- 处理 permission
- 发 UI 事件

推荐模式：

```text
RuntimeStreamEvent
  -> stream processor
  -> projector command(s)
  -> repositories + event bus
```

### 10.3 恢复逻辑独立

recovery/replay 逻辑必须独立模块化，不能散落在 create/send/cancel 主流程中。

## 11. Gateway 与 API 设计规范

### 11.1 `gateway` 是 facade，不是业务核心

`gateway` 的职责是“给前端一个稳定入口”，不是承担复杂业务规则。

允许：

- 输入校验
- 轻量参数整理
- 聚合多个 service 的结果

不允许：

- 长链路状态修正
- 多步持久化流程
- 协议恢复逻辑

### 11.2 `channel_api` 必须尽量薄

`channel_api` 只应成为桌面命令适配层，不应演化成第二个 gateway。

## 12. 错误处理规范

### 12.1 分层错误

错误必须按层次归属：

- adapter error
- runtime error
- storage error
- gateway/application validation error
- frontend-facing backend error

禁止用一个宽泛错误枚举吞掉所有上下文。

### 12.2 错误信息要可诊断

原则：

- 对开发者：要有足够诊断信息
- 对前端：要有稳定错误类型/码
- 对用户：不要暴露无意义底层细节

## 13. 测试规范

### 13.1 测试分层

后端至少应有以下测试层次：

- parser/unit tests
- repository tests
- runtime use-case tests
- recovery tests
- projector tests
- integration tests for critical flows

### 13.2 优先保护高风险路径

优先覆盖：

- create/import/send/cancel
- replay/recovery
- permission auto/manual resolution
- terminal output accumulation
- tool call / diff / message chunk projection

### 13.3 结构重构前先补测试

对于高风险大模块，必须先有回归护栏，再做深拆。

## 14. 并行开发规范

### 14.1 按写入域拆任务

推荐任务边界：

- `storage/**`
- `runtime/**`
- `agent_adapters/acp/**`
- `application/**`
- `docs/**`

不要让多个 agent 同时深改同一个巨型文件。

### 14.2 每个任务一个主题

一个分支只做一件事，例如：

- storage split
- runtime session manager extraction
- acp modularization

不要把“结构拆分 + 语义改动 + cleanup”混在一起。

### 14.3 保持 facade 兼容

在大重构过程中，旧入口可以临时保留，只要它不继续承载核心实现。

## 15. 非目标

本文档不要求当前后端：

- 立刻改成微服务
- 立刻更换数据库
- 立刻完全 event-sourcing 化
- 立刻把所有协议 JSON 强类型化
- 引入重量级 DI 容器

这些都可以作为未来优化议题，但不属于当前的基础架构规范。

## 16. 当前结论

OneAgent 后端未来的正确方向不是继续在 `runtime/mod.rs`、`storage/mod.rs`、`agent_adapters/acp.rs` 上累加功能，而是遵守本文档的边界持续拆分：

- 用 `application` 承载业务用例
- 用 `runtime` 承载会话与状态协调
- 用 `agent_adapters` 承载协议差异
- 用 `storage` 承载持久化与事务
- 用稳定 facade 保护上层 API

后续所有后端升级都应以这份文档为基线；如果要偏离，必须先更新 ADR，而不是在实现里悄悄偏离。
