# OneAgent 后端架构分析与重构方案

## 1. 目标与范围

本文面向 `src-tauri` 后端，目标不是立即重写，而是在**保持当前产品能力和 Tauri 单进程部署模型不变**的前提下，完成一次可渐进落地的架构升级，使后端具备：

- 清晰的分层和职责边界
- 更低的模块耦合度
- 更好的长期维护性和可测试性
- 支持后续继续接入更多 agent / protocol / runtime 能力
- 支持多 agent 并行协作实施，而不是只能由单人串行“手术式”改造

本文重点分析以下核心模块及其辐射问题：

- `src-tauri/src/agent_adapters/acp.rs`
- `src-tauri/src/runtime/mod.rs`
- `src-tauri/src/storage/mod.rs`
- 以及与它们强耦合的 `gateway` / `channel_api` / `capability_services`

## 2. 当前后端的真实结构

当前整体数据流大致如下：

```text
Tauri Commands (channel_api)
  -> Gateway
    -> Runtime
      -> AgentAdapter (ACP / Compat)
      -> Storage(Database)
      -> Capability Services (MCP / Skills / Policy)
    -> Storage(Database)
```

这条主链路本身没有错，说明项目已经有“API 层 / 业务层 / 基础设施层”的雏形。

但问题在于，核心模块没有继续沿着这个方向深化分层，而是把多个层次的职责继续堆叠在单个文件里。

### 2.1 `runtime/mod.rs` 当前承担的职责

`src-tauri/src/runtime/mod.rs:33-41` 的 `Runtime` 同时持有：

- `Database`
- `McpRegistry`
- `SkillRegistry`
- `PolicyEngine`
- UI `EventEmitter`
- 内存会话池 `sessions`
- 内存运行时状态 `runtime_states`
- 流式消息缓冲 `streaming_messages`

此外它还同时负责：

- 用例编排：创建会话、导入会话、发送消息、取消、删除、切换 model / mode
  - 见 `src-tauri/src/runtime/mod.rs:188-391`
  - 见 `src-tauri/src/runtime/mod.rs:476-561`
- 会话恢复与热/冷状态管理
  - 见 `src-tauri/src/runtime/mod.rs:564-842`
- 流式事件落库、投影、状态推进、UI 发射
  - 见 `src-tauri/src/runtime/mod.rs:1344-1865`
- replay 恢复逻辑
  - 见 `src-tauri/src/runtime/mod.rs:1867-1899`
- snapshot 读取/更新
  - 见 `src-tauri/src/runtime/mod.rs:1901-2001`

换句话说，`Runtime` 同时是：

- Application Service
- Session Manager
- State Machine
- Event Projector
- Read Model Builder
- UI Event Bus

这是当前最核心的架构瓶颈。

### 2.2 `storage/mod.rs` 当前承担的职责

`src-tauri/src/storage/mod.rs` 把以下内容全部塞在一个 `Database` 类型里：

- 数据库连接管理
  - `src-tauri/src/storage/mod.rs:25-42`
- 全量建表和“补列式”迁移
  - `src-tauri/src/storage/mod.rs:45-240`
- 所有聚合/投影的 CRUD
  - `src-tauri/src/storage/mod.rs:255-1099`
- 所有 row mapper
  - `src-tauri/src/storage/mod.rs:1109-1334`
- JSON / enum / datetime 序列化细节
  - `src-tauri/src/storage/mod.rs:1336-1365`

这里实际上混合了：

- connection / driver 层
- migration 层
- repository 层
- row mapping 层
- serialization helper 层

这会直接导致：

- 任何数据结构变更都必须进入一个巨型文件
- 任何 agent 都很容易在这个文件里产生编辑冲突
- repository 无法独立测试
- transaction 边界无法被明确建模

### 2.3 `agent_adapters/acp.rs` 当前承担的职责

`src-tauri/src/agent_adapters/acp.rs` 同时包含：

- `AgentAdapter` 的 ACP 实现
  - `src-tauri/src/agent_adapters/acp.rs:121-483`
- ACP live session actor
  - `src-tauri/src/agent_adapters/acp.rs:485-984`
- JSON-RPC 进程传输层
  - `src-tauri/src/agent_adapters/acp.rs:986-1173`
- ACP client-side method handlers
  - `fs/*` 与 `terminal/*`
  - `src-tauri/src/agent_adapters/acp.rs:1184-1567`
- prompt / attachment 编码策略
  - `src-tauri/src/agent_adapters/acp.rs:1712-1818`
- ACP capability / update / permission 解析器
  - `src-tauri/src/agent_adapters/acp.rs:1845-2392`
- 协议单元测试
  - `src-tauri/src/agent_adapters/acp.rs:2405-2579`

这意味着一个文件同时覆盖：

- 协议适配
- 进程生命周期
- actor 并发模型
- 本地文件系统与终端桥接
- 内容编码
- 事件解析
- 权限交互

这不仅是“大文件”问题，更是**基础设施层内部没有继续拆边界**的问题。

### 2.4 `gateway/mod.rs` 的现状

`gateway` 大多数地方只是 facade，但仍夹杂业务逻辑：

- agent discovery 清理和同步：`src-tauri/src/gateway/mod.rs:45-67`
- attachment blob 持久化：`src-tauri/src/gateway/mod.rs:234-271`
- workspace bootstrap 与“状态修正”：`src-tauri/src/gateway/mod.rs:324-360`

也就是说 `Gateway` 现在既是 API facade，又在承担一部分 application service 逻辑。

## 3. 当前架构的主要问题

下面不是泛泛而谈，而是结合当前代码的具体问题。

### 3.1 单模块承担多个抽象层次

这是目前最严重的问题。

表现：

- `runtime` 同时写业务状态、落库、投影、发事件、恢复会话
- `storage` 同时管理 schema、迁移、repo、mapper
- `acp` 同时处理 transport、protocol、terminal、permission、parsing

后果：

- 任何改动都需要理解过多上下文
- 容易出现“顺手改了不该改的层”
- 代码 review 成本高，局部修改难以评估副作用
- 无法稳定地并行开发

### 3.2 状态一致性边界不清晰

当前很多业务动作由多次数据库写入组成，但没有统一事务边界。

典型例子：

- `create_conversation` 中依次执行：
  - `db.create_conversation`
  - `db.upsert_binding`
  - `record_lifecycle_event`
  - `replace_snapshot`
  - `emit_conversation_state`
  - 见 `src-tauri/src/runtime/mod.rs:188-263`
- `create_task_run` 也是同类流程
  - 见 `src-tauri/src/runtime/mod.rs:393-474`

只有 `delete_conversation` 明确用了 transaction：

- `src-tauri/src/storage/mod.rs:549-598`

这意味着一旦中途失败，系统很容易留下半成品状态：

- conversation 已创建，但 binding 未写入
- event 已追加，但 snapshot 未更新
- task_run 已存在，但 runtime 状态未同步

### 3.3 内存态与持久态的职责分离不清

当前系统同时依赖：

- 内存 `sessions`
- 内存 `runtime_states`
- 数据库中的 `conversation.status`
- 数据库 event log
- 数据库 snapshot

并且它们之间缺少统一的“哪个是真相源”的定义。

例如：

- app 重启后，`bootstrap_workspace` 还需要手动把旧的 `Connected/Running/...` 修正为 `Sleep`
  - `src-tauri/src/gateway/mod.rs:331-348`

这说明：

- 持久化层里保存了“看起来像实时态”的字段
- 但真正实时态又只在内存中成立

这是一种典型的状态模型泄漏。

### 3.4 `Runtime` 的事件处理是“投影器 + UI 通知器 + 状态机”混写

`apply_stream_event` 非常典型：

- 推进 runtime state
- upsert message/tool_call/terminal
- record lifecycle event
- 管理 pending permissions
- 发 conversation / terminal / permission 事件

全部在 `src-tauri/src/runtime/mod.rs:1344-1865` 中完成。

后果：

- 事件处理逻辑无法独立测试
- 新增一种 stream event 会牵扯多套副作用
- 很难判断哪个行为属于 domain 规则，哪个只是 UI projection

### 3.5 `storage` 是一个“全知型数据库对象”

`Database` 现在暴露几十个方法，覆盖所有实体类型。

问题不只是方法多，而是：

- conversation、message、tool_call、terminal、permission、mcp、skills 都被一个类型直接操控
- repository 层没有任何子边界
- 读模型与写模型混在一起
- mapper 与 schema 细节泄漏到统一文件

这会让所有业务代码都对 `Database` 形成强耦合。

### 3.6 ACP 适配层内部耦合严重

`acp.rs` 中最不合理的点有几个：

- `JsonRpcProcess` 同时维护进程 stdin/stdout、当前 turn、terminal 记录、stderr buffer
  - `src-tauri/src/agent_adapters/acp.rs:986-995`
- ACP client method handler 直接实现文件系统与终端桥接
  - `src-tauri/src/agent_adapters/acp.rs:1184-1567`
- parser 与 session actor 处于同一文件
  - `src-tauri/src/agent_adapters/acp.rs:707-984`
  - `src-tauri/src/agent_adapters/acp.rs:1845-2392`

这会让 ACP 成为一个“黑洞模块”：

- 想改 terminal 行为，要动 ACP
- 想改 permission 流程，要动 ACP
- 想改 JSON-RPC 传输，要动 ACP
- 想加更多协议兼容，要先读懂 ACP 巨型文件

### 3.7 同步 SQLite + async runtime 的边界未隔离

当前使用 `rusqlite + parking_lot::Mutex<Connection>`，并且在 async 流程中直接同步调用数据库：

- `src-tauri/src/storage/mod.rs:25-27`
- `src-tauri/src/runtime/mod.rs` 多处 async 方法直接调用 `db.*`

这在规模不大时能工作，但长期风险是：

- 所有数据库操作串行化到同一个连接
- 大量 `list_messages/list_tool_calls/list_events` 会阻塞 async 执行路径
- 未来如果对话流、terminal 输出频率上来，会放大瓶颈

这里不一定要马上换库，但至少需要建立**存储访问边界**，避免未来无处下刀。

### 3.8 Snapshot 设计偏“方便”，缺少清晰边界

当前 snapshot 保存的是整个 `ConversationState` JSON：

- `src-tauri/src/storage/mod.rs:755-790`
- `src-tauri/src/runtime/mod.rs:1955-2001`

这带来的问题：

- 写局部状态要先重建整份 state
- 读局部配置要反序列化整个 `ConversationState`
- snapshot 结构和对外 API DTO 紧耦合

更合理的做法应是：

- snapshot 只服务内部恢复/查询需求
- API DTO 与 snapshot model 分离

### 3.9 重复代码较多，说明缺少稳定用例骨架

典型重复：

- `create_conversation` / `create_task_run` / `import_conversation`
  - 都在做 workspace/profile/mcp 加载、session 创建、binding 写入、snapshot 建立、emit
- fallback `AgentSessionHandle` 组装逻辑在多个位置重复
  - `session_runtime`
  - `delete_conversation`

这类重复不是简单抽函数，而是说明“会话用例服务”的抽象尚未形成。

### 3.10 测试颗粒度偏底层，缺少跨模块回归保护

现在可见的测试主要集中在：

- ACP parser 小测试
- skill / policy 小测试

缺少：

- runtime 用例级测试
- projection 测试
- recovery 测试
- storage repository 测试
- ACP integration 测试

这会使重构风险非常高。

## 4. 现状中值得保留的部分

不是所有东西都需要推翻。以下设计值得保留：

- 已有 `AgentAdapter` trait，说明 protocol 适配层已经有统一入口
- `domain` 模型相对集中，至少类型系统基础存在
- `capability_services` 的粒度比核心模块清晰
- `gateway -> runtime/storage` 的大方向是对的
- 已有 event log + snapshot 的雏形，说明系统天然适合“事件驱动 + 投影”的演进方式

所以本次升级建议走**渐进式重构**，不是一次性重写。

## 5. 目标架构

建议把后端调整为下面这套结构。

```text
channel_api            -> 仅负责 Tauri command DTO 映射
gateway                -> 仅负责 API facade / 参数校验 / 聚合多个 application service
application            -> 用例服务层
domain                 -> 领域模型 / 领域规则 / 状态机
runtime                -> 会话生命周期与运行时协调
agent_adapters         -> 各协议适配
storage                -> repository / migration / transaction / read model
capability_services    -> 横切能力服务
```

### 5.1 推荐模块拆分

建议目标目录如下：

```text
src-tauri/src/
  application/
    mod.rs
    conversations.rs
    task_runs.rs
    permissions.rs
    workspaces.rs
    attachments.rs

  runtime/
    mod.rs                 # facade
    session_manager.rs
    state_store.rs
    recovery.rs
    stream_processor.rs
    projector.rs
    event_bus.rs
    types.rs

  agent_adapters/
    mod.rs
    compat.rs
    acp/
      mod.rs
      adapter.rs
      live_session.rs
      actor.rs
      process.rs
      client_fs.rs
      client_terminal.rs
      prompt_codec.rs
      parser.rs
      permission.rs
      types.rs

  storage/
    mod.rs                 # facade / re-export
    sqlite/
      mod.rs
      connection.rs
      migrations.rs
      tx.rs
    repositories/
      mod.rs
      agent_profiles.rs
      workspaces.rs
      conversations.rs
      task_runs.rs
      events.rs
      snapshots.rs
      messages.rs
      tool_calls.rs
      permissions.rs
      terminals.rs
      mcp.rs
      skills.rs
    mappers/
      mod.rs
      conversation.rs
      message.rs
      tool_call.rs
      permission.rs
      terminal.rs

  domain/
    mod.rs
    conversation.rs
    runtime.rs
    task_run.rs
    permissions.rs
    agent.rs
```

### 5.2 目标职责边界

#### `channel_api`

只做：

- Tauri command 入参反序列化
- 调用 gateway / application service
- 错误转换为 `BackendError`

不做：

- 业务编排
- 状态修正
- 文件系统逻辑

#### `gateway`

只做：

- Facade
- 轻量参数校验
- 聚合多个 service 返回 bootstrap 响应

不做：

- 直接操作数据库细节
- 运行时状态修正逻辑
- attachment 文件持久化细节

#### `application`

负责：

- `CreateConversation`
- `ImportConversation`
- `SendUserMessage`
- `CancelTurn`
- `ResolvePermission`
- `BootstrapWorkspace`

它是主要的业务用例入口。

#### `runtime`

负责：

- 会话池
- 热/冷会话切换
- recovery
- 运行时状态机推进
- stream event 进入 projector 前的协调

不直接承担所有数据库投影细节。

#### `stream_processor / projector`

负责：

- 把 `RuntimeStreamEvent` 转成内部 command
- 更新消息/tool_call/terminal/pending_permission projection
- 发出 UI 事件

重点是把现在 `apply_stream_event` 拆掉。

#### `agent_adapters/acp`

拆成 4 类职责：

- `adapter.rs`: `AgentAdapter` 实现
- `process.rs`: JSON-RPC transport / process 生命周期
- `actor.rs` + `live_session.rs`: live session actor
- `parser.rs` / `prompt_codec.rs` / `permission.rs`: 纯函数逻辑
- `client_fs.rs` / `client_terminal.rs`: ACP client-side method bridge

#### `storage`

拆成：

- migration
- transaction
- repository
- mapper

并定义一个更明确的存储访问边界。

## 6. 重构原则

### 6.1 保持外部 API 尽量稳定

前端依赖的 command 和事件名尽量不先变：

- `conversation:state_changed`
- `conversation:message_appended`
- `conversation:message_updated`
- `conversation:tool_call_changed`
- `conversation:permission_requested`
- `conversation:permission_resolved`
- `conversation:terminal_output`

先在后端内部重构，再决定是否升级对外协议。

### 6.2 先拆职责，再优化实现

先做：

- 文件拆分
- 类型与边界抽象
- 事务边界
- 测试补齐

再做：

- SQLite 访问性能优化
- 更细颗粒的 event sourcing
- 更强类型的 ACP message model

### 6.3 不建议一步到位改成“纯 event sourcing”

当前已有 event log + snapshot 雏形，但体系还不完整。

更稳妥的方式是：

1. 先把 `event log / snapshot / projections` 的职责分离
2. 再决定未来是否继续往完整 event sourcing 演进

### 6.4 保持单进程架构

当前是 Tauri 桌面应用，不建议为了“解耦”就引入微服务、多进程后台、外部 DB 服务。

本次方案是**单进程内的模块化升级**。

## 7. 分阶段改造路线

## Phase 0：基线与护栏

目标：

- 建立模块拆分蓝图
- 补关键测试护栏
- 定义不变的外部 API 和事件契约

产出：

- 架构 ADR / 目录规划
- 用例级测试清单
- ACP parser / runtime replay / permission / terminal 的回归样例

## Phase 1：拆 `storage`

目标：

- 先把最容易并行、最容易形成稳定边界的模块拆出来

原因：

- `runtime` 与 `acp` 的改造都依赖更清晰的存储接口

结果：

- `storage/mod.rs` 只保留 facade
- 引入 `repositories/*`
- 引入 `sqlite/migrations.rs`
- 引入 `tx.rs`

## Phase 2：拆 `runtime`

目标：

- 把 `Runtime` 变成协调器，而不是业务全家桶

重点拆分：

- `session_manager`
- `recovery`
- `stream_processor`
- `projector`
- `event_bus`

## Phase 3：拆 `acp`

目标：

- 把协议 transport / actor / parser / local bridge 解开

结果：

- ACP 后续更容易支持更多 agent 差异
- 更容易替换 terminal/fs bridge

## Phase 4：收口 `gateway/application`

目标：

- 让 gateway 只保留 facade
- 正式引入 application services
- 收敛重复的 create/import/task-run 流程

## Phase 5：一致性与性能修正

目标：

- 将关键用例写入事务化
- 把同步 SQLite 边界隔离出来
- 优化流式 chunk 的高频读写模式

## 8. 并行任务拆分

下面的任务设计目标是：**尽量让多个 agent 能并行推进，且写文件范围冲突最小**。

---

### Task A1：输出后端模块蓝图与迁移约束

目标：

- 建立统一的目标目录、命名和迁移规则，防止多个 agent 各拆各的

主要工作：

- 新增后端架构 ADR / 迁移约束文档
- 定义 module naming、error 分层、DTO 与 domain 的边界
- 定义重构期间哪些 API / event 名称不可改

建议写入范围：

- `docs/`
- 必要时新增 `src-tauri/src/application/mod.rs` 等空模块骨架

依赖：

- 无

可并行性：

- 高

验收标准：

- 后续任务能直接按蓝图建文件，不再争论目录结构

---

### Task A2：拆分 `storage` 为 repository + migration + tx

目标：

- 把 `storage/mod.rs` 从“巨型数据库对象”拆成稳定基础设施层

主要工作：

- 提取 `sqlite/connection.rs`
- 提取 `sqlite/migrations.rs`
- 提取 `repositories/*`
- 提取 `mappers/*`
- 新增 transaction helper / unit-of-work 入口

建议拆分优先级：

1. conversations / bindings / task_runs
2. events / snapshots
3. messages / tool_calls / terminals / permissions
4. mcp / skills / agent_profiles

建议写入范围：

- `src-tauri/src/storage/**`

依赖：

- A1

可并行性：

- 高，但要按 repository 维度切文件所有权

验收标准：

- `storage/mod.rs` 只做 re-export / facade
- 不再存在一个文件承载全部 schema + repo + mapper

---

### Task A3：引入存储事务边界与关键用例的原子性策略

目标：

- 解决 create/import/send/cancel 等流程中途失败留下半状态的问题

主要工作：

- 定义 transaction API
- 标记哪些用例需要事务
- 改造以下流程为原子写入单元：
  - create conversation
  - create task run
  - import conversation
  - resolve permission
  - cancel turn

注意：

- 这里不要求先改完整业务实现，但必须先把事务机制铺出来

建议写入范围：

- `src-tauri/src/storage/sqlite/tx.rs`
- `src-tauri/src/storage/repositories/*`
- 可能触及 `runtime` / `application`

依赖：

- A2

可并行性：

- 中

验收标准：

- 关键用例不再依赖“多次独立写库碰运气成功”

---

### Task B1：提取 `runtime` 的 session manager

目标：

- 把会话池、热/冷切换、fallback handle 组装从 `Runtime` 主体中拿出去

主要工作：

- 提取 `session_manager.rs`
- 提取 `ManagedSession`
- 提取 `session_runtime` 与 `ensure_live_session` 相关逻辑
- 统一 fallback handle 构建

建议写入范围：

- `src-tauri/src/runtime/session_manager.rs`
- `src-tauri/src/runtime/types.rs`

依赖：

- A1

可并行性：

- 高

验收标准：

- `runtime/mod.rs` 不再直接管理全部 session 恢复细节

---

### Task B2：提取 `runtime` 的 recovery 模块

目标：

- 把会话恢复和 replay 逻辑单独封装

主要工作：

- 提取 `consume_replay_events_for_recovery`
- 提取 `apply_replay_events`
- 提取“恢复时重放 model/mode/config”策略

建议写入范围：

- `src-tauri/src/runtime/recovery.rs`

依赖：

- B1
- A2

可并行性：

- 中高

验收标准：

- recovery 逻辑不再嵌在主 runtime 文件中

---

### Task B3：提取 `stream_processor` / `projector`

目标：

- 把 `apply_stream_event` 这个超大副作用函数拆掉

主要工作：

- 定义内部 `ProjectionCommand` 或等价结构
- 提取 message projector
- 提取 tool_call projector
- 提取 permission projector
- 提取 terminal projector
- 提取 UI emit adapter

建议写入范围：

- `src-tauri/src/runtime/stream_processor.rs`
- `src-tauri/src/runtime/projector.rs`
- 可能新增多个 projector 文件

依赖：

- A2
- A3
- B1

可并行性：

- 中

验收标准：

- `runtime/mod.rs` 不再包含 500+ 行的 event match 副作用逻辑

---

### Task B4：引入 application service 层并收敛重复用例

目标：

- 让 `create_conversation` / `create_task_run` / `import_conversation` / `send_user_message` 拥有统一用例骨架

主要工作：

- 新增 `application/conversations.rs`
- 新增 `application/task_runs.rs`
- 新增 `application/permissions.rs`
- 把 gateway 中的业务编排迁移到 application services

建议写入范围：

- `src-tauri/src/application/**`
- `src-tauri/src/gateway/mod.rs`
- `src-tauri/src/runtime/mod.rs`

依赖：

- A2
- B1

可并行性：

- 中

验收标准：

- gateway 只保留 facade 和轻量校验
- 重复创建流程被模板化

---

### Task C1：拆分 ACP 为 transport / actor / parser / bridge

目标：

- 把 `acp.rs` 从黑洞模块拆成稳定的协议子模块

主要工作：

- 提取 `acp/adapter.rs`
- 提取 `acp/process.rs`
- 提取 `acp/live_session.rs`
- 提取 `acp/actor.rs`
- 提取 `acp/parser.rs`
- 提取 `acp/prompt_codec.rs`
- 提取 `acp/client_fs.rs`
- 提取 `acp/client_terminal.rs`
- 提取 `acp/permission.rs`

建议写入范围：

- `src-tauri/src/agent_adapters/acp/**`
- `src-tauri/src/agent_adapters/mod.rs`

依赖：

- A1

可并行性：

- 高，但必须按文件所有权拆

验收标准：

- `acp.rs` 被替换为目录模块
- parser/transport/bridge 至少物理分离

---

### Task C2：为 ACP 建立更强类型的协议模型

目标：

- 逐步减少 `serde_json::Value` 在 ACP 内部横飞

主要工作：

- 为 initialize/session/update/permission 等消息引入 typed struct
- parser 输出 typed intermediate model
- 只在协议边界保留 `Value`

注意：

- 这是重构增强项，不要求一次性类型化全部消息

建议写入范围：

- `src-tauri/src/agent_adapters/acp/types.rs`
- `src-tauri/src/agent_adapters/acp/parser.rs`

依赖：

- C1

可并行性：

- 中

验收标准：

- 关键 ACP message 不再全部依赖 ad-hoc JSON 取字段

---

### Task D1：重构 snapshot/read model 设计

目标：

- 把 snapshot 与 API DTO 解耦

主要工作：

- 定义内部 snapshot model
- 把 `ConversationState` 与 snapshot 存储分离
- 收敛 `conversation_config_options/models/modes` 的重复反序列化读取

建议写入范围：

- `src-tauri/src/runtime/*`
- `src-tauri/src/storage/repositories/snapshots.rs`
- 可能新增 `domain/runtime.rs`

依赖：

- A2
- B3

可并行性：

- 中

验收标准：

- snapshot 不再直接等于对外 API state

---

### Task D2：补全测试矩阵

目标：

- 为重构提供可持续回归保护

主要工作：

- repository 测试
- runtime 用例测试
- recovery 测试
- stream projector 测试
- ACP actor / parser / permission 测试

建议优先覆盖：

- `create/import/send/cancel`
- replay
- permission auto-resolve / manual resolve
- terminal output 累积
- tool_call / diff / message chunk 切换

建议写入范围：

- `src-tauri/src/**/tests`
- 或 `tests/` 集成测试目录

依赖：

- A2
- B3
- C1

可并行性：

- 高

验收标准：

- 核心用例具备回归测试，不再只靠 parser 小测试兜底

---

### Task D3：收敛同步 DB 与 async runtime 的边界

目标：

- 为后续性能优化和并发稳定性预留空间

主要工作：

- 评估哪些高频读写需要隔离到专门边界
- 避免在高频 chunk 路径中重复 `list_messages`
- 为未来 `spawn_blocking` 或连接池改造预留接口

建议优先关注：

- `apply_stream_event` 中的高频消息检查
  - `src-tauri/src/runtime/mod.rs:1415-1419`
  - `src-tauri/src/runtime/mod.rs:1467-1471`
- timeline/state 的全量读取频率

依赖：

- A2
- B3

可并行性：

- 中

验收标准：

- 高频流式路径不再依赖重复全量查询判断“append 还是 update”

## 9. 推荐并行执行顺序

为了减少冲突，建议按下面顺序组织多个 agent：

### 第一批并行

- A1：架构蓝图与迁移约束
- A2：storage 物理拆分
- B1：session manager 抽离
- C1：ACP 目录化拆分
- D2：测试骨架搭建

### 第二批并行

- A3：事务边界
- B2：recovery 抽离
- B3：stream projector 抽离
- C2：ACP 类型化

### 第三批并行

- B4：application service 层
- D1：snapshot/read model 重构
- D3：性能与 async boundary 优化

## 10. 每个任务的协作要求

为了避免多个 agent 互相覆盖，建议统一遵守下面规则：

- 不要在同一个任务里同时改 `storage`、`runtime`、`acp` 三大区域
- 每个任务只负责一个明确写入域
- 先做物理拆分和 re-export，后做行为迁移
- 先补测试，再替换旧逻辑
- 每次任务都保留兼容 facade，避免一批任务未完成时主干无法编译

建议每个任务 PR 都包含：

- 改动范围说明
- 当前剩余 TODO
- 与其他任务的接口约束
- 回归测试说明

## 11. 建议优先解决的三个核心痛点

如果资源有限，优先级建议如下：

### 优先级 1：拆 `storage`

原因：

- 这是所有后续重构的基础
- 对业务行为影响相对较小
- 最适合并行

### 优先级 2：拆 `runtime` 的 event/projector 逻辑

原因：

- 这是当前复杂度最高的维护热点
- 对会话、消息、terminal、permission 的副作用全在这里

### 优先级 3：拆 `acp`

原因：

- 这是后续接入更多 agent / protocol 的核心阻碍
- 也是目前单文件规模最大、层次最混乱的基础设施模块

## 12. 不建议现在做的事

- 不建议直接改成多进程后端
- 不建议直接更换数据库
- 不建议引入过重的 DI 容器
- 不建议一次性把所有 `serde_json::Value` 全部类型化
- 不建议在没有测试护栏前大规模改 `apply_stream_event`

## 13. 结论

当前后端并不是“方向错了”，而是**停留在第一阶段分层之后，没有继续把核心模块拆到可维护粒度**。

最核心的三个问题是：

1. `runtime` 过度集中，业务编排、状态机、投影、恢复、通知全部混在一起
2. `storage` 缺乏 repository / migration / transaction 边界
3. `acp` 同时承担协议、transport、actor、terminal bridge、parser 等多个层次

推荐策略不是重写，而是：

1. 先拆 `storage`
2. 再拆 `runtime`
3. 再拆 `acp`
4. 最后收口 `gateway/application` 和一致性边界

这样改造的优点是：

- 可以由多个 agent 并行推进
- 可以逐步迁移，不必停机式重构
- 每一步都有明确产出和验收标准
- 能在较短时间内显著降低维护复杂度

