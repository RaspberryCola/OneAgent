# ACP Rust SDK vs OneAgent 实现对比分析

> 对比对象：`agent-client-protocol` crate v0.12.1（docs.rs）[https://docs.rs/agent-client-protocol/latest/agent_client_protocol/index.html]
> 项目实现：`src-tauri/src/agent_adapters/acp/` 目录

---

## 一、值得直接照搬的设计

### 1.1 ToolCall / ToolCallUpdate 分层设计

SDK 将 tool call 分为三个层次：

```
ToolCall           — 完整的 tool call（创建时发送）
ToolCallUpdate     — 增量更新（只包含 tool_call_id + 变化字段）
ToolCallUpdateFields — 所有字段都是 Option，只传需要更新的
```

**项目现状**：`AcpSessionUpdate::ToolCall` 和 `ToolCallUpdate` 字段完全相同（7 个字段全部重复），没有区分"创建"和"更新"语义。

**SDK 做法**：

```rust
// ToolCall — 完整结构
struct ToolCall {
    tool_call_id: ToolCallId,
    title: String,
    kind: ToolKind,          // enum，不是 String
    status: ToolCallStatus,  // enum，不是 String
    content: Vec<ToolCallContent>,  // enum，不是 Vec<Value>
    locations: Vec<ToolCallLocation>,
    raw_input: Option<Value>,
    raw_output: Option<Value>,
    meta: Option<Map<String, Value>>,
}

// ToolCallUpdate — 只有 id + 变化字段
struct ToolCallUpdate {
    tool_call_id: ToolCallId,
    fields: ToolCallUpdateFields,
    meta: Option<Map<String, Value>>,
}

// ToolCallUpdateFields — 全部 Optional
struct ToolCallUpdateFields {
    kind: Option<ToolKind>,
    status: Option<ToolCallStatus>,
    title: Option<String>,
    content: Option<Vec<ToolCallContent>>,
    locations: Option<Vec<ToolCallLocation>>,
    raw_input: Option<Value>,
    raw_output: Option<Value>,
}
```

**建议**：在 `types.rs` 中拆分 `AcpSessionUpdate::ToolCall` 和 `ToolCallUpdate`，让 Update 只携带变化的字段。这样下游的 merge 逻辑更清晰（当前 `parser.rs` 对两者用完全相同的处理路径，语义上不精确）。

### 1.2 ToolKind / ToolCallStatus 枚举

SDK 定义了类型安全的枚举，项目用的是 `String`。

**ToolKind 枚举**（SDK）：

| Variant | 说明 |
|---------|------|
| `Read` | 读文件/数据 |
| `Edit` | 修改文件/内容 |
| `Delete` | 删除文件/数据 |
| `Move` | 移动/重命名文件 |
| `Search` | 搜索信息 |
| `Execute` | 执行命令 |
| `Think` | 内部推理 |
| `Fetch` | 获取外部数据 |
| `SwitchMode` | 切换 session mode |
| `Other` | 其他（默认） |

**ToolCallStatus 枚举**（SDK）：

| Variant | 说明 |
|---------|------|
| `Pending` | 等待执行（input 未就绪或等待审批） |
| `InProgress` | 正在执行 |
| `Completed` | 成功完成 |
| `Failed` | 执行失败 |

**项目现状**：`kind` 和 `status` 都是 `String`，`normalize_tool_status` 做了 `"pending" -> "declared"` 和 `"in_progress" -> "running"` 的映射，但没有对 `kind` 做任何规范化。

**建议**：

- 在 `domain/` 中添加 `ToolKind` 和 `ToolCallStatus` 枚举（带 `#[serde(other)]` fallback）
- `ToolCallStatus` 保持与 SDK 一致的命名（`Pending`/`InProgress`/`Completed`/`Failed`），内部映射到项目现有的 `"declared"`/`"running"` 等值
- `ToolKind` 可以直接照搬 SDK 的变体集

### 1.3 StopReason 枚举

SDK 定义了：

```rust
enum StopReason {
    EndTurn,          // 正常结束
    MaxTokens,        // 达到 token 上限
    MaxTurnRequests,  // 达到 turn 请求上限
    Refusal,          // agent 拒绝继续
    Cancelled,        // 被 client 取消
}
```

**项目现状**：`PromptResult.stop_reason` 是 `Option<String>`，在 `live_session.rs` 中直接作为字符串传递。

**建议**：添加 `StopReason` 枚举，用于类型安全的 stop reason 处理。对 UI 展示（如区分"正常结束"和"被取消"）有直接价值。

### 1.4 ToolCallContent 枚举

SDK 用枚举统一了 tool call 的内容类型：

```rust
enum ToolCallContent {
    Content(Content),  // 标准内容块（text/image/resource）
    Diff(Diff),        // 文件 diff
    Terminal(Terminal), // 终端引用
}
```

**项目现状**：`AcpToolContentItem` 是一个扁平 struct，所有字段都 Optional（`terminal_id`、`content`、`diff`、`text`、`output`），解析时需要逐个检查哪个字段存在。

**建议**：参考 SDK 的枚举设计，将 `AcpToolContentItem` 改为 `AcpToolContent` 枚举，每种内容类型有明确的语义。这样 `extract_content` 函数可以简化为 pattern matching。

### 1.5 ToolCallLocation

SDK 有独立的 `ToolCallLocation` 类型表示工具调用涉及的文件位置。

**项目现状**：在 `RuntimeStreamEvent::ToolCall` 中，locations 被构造为 `json!({"terminals": ..., "paths": ...})` 的 raw JSON。

**建议**：添加 `ToolCallLocation` struct，至少包含 `path` 和 `terminal_id` 字段，替代 raw JSON。

---

## 二、值得参考借鉴的设计

### 2.1 ContentBlock / ContentChunk 内容体系

SDK 有完整的内容类型层次：

```
ContentBlock (enum)
├── Text(TextContent)      — { text, annotations }
├── Image(ImageContent)    — { data, mime_type, uri, annotations }
├── Audio(AudioContent)    — { data, mime_type, annotations }
├── Resource(EmbeddedResource) — { resource, annotations }
└── ResourceLink(ResourceLink) — { uri, name, description, mime_type, size, annotations }

ContentChunk (struct) — 流式内容块，用于 session/update

Annotations (struct) — 可选的注解信息
```

**项目现状**：`AcpTextContent` 只有 `text` 字段，`AcpToolContentItem` 是扁平 struct，没有 image/audio 的独立类型。

**建议**：不需要完全照搬（项目对 image/audio 的处理在 prompt_codec.rs 中已经有独立逻辑），但可以参考 `ContentBlock` 的枚举设计来规范化 `AcpSessionUpdate` 中的内容块表示。

### 2.2 Capabilities 结构化

SDK 的 capabilities 有完整的层次：

```
AgentCapabilities {
    load_session: bool,
    prompt_capabilities: PromptCapabilities,
    mcp_capabilities: McpCapabilities,
    session_capabilities: SessionCapabilities,
    meta: Option<Value>,
}

ClientCapabilities {
    fs: FileSystemCapabilities,
    terminal: bool,
    meta: Option<Value>,
}

SessionCapabilities {
    load: Option<SessionLoadCapabilities>,
    list: Option<SessionListCapabilities>,
    close: Option<SessionCloseCapabilities>,
    resume: Option<SessionResumeCapabilities>,
}

PromptCapabilities {
    text: bool,
    resource_link: bool,
    embedded_context: bool,
    image: bool,
    audio: bool,
}
```

**项目现状**：`AgentCapabilities` 是自定义 struct，`session_capabilities` 只有 `load` 和 `list` 两个 bool。`AgentSessionCapabilities`、`AgentPromptCapabilities` 是独立的 struct。

**建议**：

- 参考 SDK 补充 `close` 和 `resume` capabilities（如果未来需要支持）
- `McpCapabilities` 目前项目没有，但 MCP over ACP 是 SDK 的重要特性，值得关注
- `FileSystemCapabilities` 可以细化当前的 `AcpClientFsCapabilities`（SDK 可能有更多字段如 `create`、`list_dir` 等）

### 2.3 SessionUpdate 新变体

SDK 的 `SessionUpdate` 比项目多几个变体：

| SDK Variant | 项目是否有 | 说明 |
|-------------|-----------|------|
| `UserMessageChunk` | ✅ | 用户消息块 |
| `AgentMessageChunk` | ✅ | agent 消息块 |
| `AgentThoughtChunk` | ✅ | agent 思考块 |
| `ToolCall` | ✅ | 工具调用 |
| `ToolCallUpdate` | ✅ | 工具调用更新 |
| `Plan` | ✅ | 执行计划 |
| `AvailableCommandsUpdate` | ❌ | 可用命令更新 |
| `CurrentModeUpdate` | ❌ | 当前模式变更 |
| `ConfigOptionUpdate` | ✅ | 配置选项更新 |
| `SessionInfoUpdate` | ❌ | session 信息更新 |

**建议**：补充 `AvailableCommandsUpdate`、`CurrentModeUpdate`、`SessionInfoUpdate` 三个变体。这些对 UI 的实时更新有价值（如 mode 切换后 UI 需要立即反映）。

### 2.4 SessionConfigOption 类型化

SDK 有完整的配置选项类型体系：

```
SessionConfigOption {
    id: SessionConfigId,
    name: String,
    description: Option<String>,
    category: Option<SessionConfigOptionCategory>,
    kind: SessionConfigKind,  // enum: Select / Range / Toggle / ...
    meta: Option<Value>,
}

SessionConfigKind (enum) {
    Select(SessionConfigSelect),
    // 可能还有其他变体
}

SessionConfigSelect {
    options: Vec<SessionConfigSelectOption>,
    current_value: Option<SessionConfigValueId>,
}
```

**项目现状**：`SessionConfigOption` 是自定义 struct，`option_type` 是 String，`options` 和 `current_value` 都是 raw `Value`。

**建议**：参考 SDK 的 `SessionConfigKind` 枚举设计，将配置选项按类型（select/range/toggle）做结构化表示，而不是全部用 `Value`。

### 2.5 SessionMode / SessionModeState

SDK 有：

```
SessionMode {
    id: SessionModeId,
    name: String,
    description: Option<String>,
}

SessionModeState {
    available_modes: Vec<SessionMode>,
    current_mode_id: SessionModeId,
}
```

**项目现状**：`AcpSessionMode` 和 `AcpSessionModeState` 的字段基本一致，但命名和结构上可以对齐 SDK。

**建议**：低优先级，当前实现已经够用。

### 2.6 Plan / PlanEntry 类型化

SDK 有：

```
Plan {
    entries: Vec<PlanEntry>,
    meta: Option<Value>,
}

PlanEntry {
    content: String,           // 非 Optional
    status: PlanEntryStatus,   // enum，不是 String
    priority: Option<PlanEntryPriority>,
    meta: Option<Value>,
}

PlanEntryStatus (enum) {
    Pending,
    InProgress,
    Completed,
    Failed,
}

PlanEntryPriority (enum) {
    Low,
    Medium,
    High,
}
```

**项目现状**：`PlanEntry` 的 `content` 是 `Option<String>`，`status` 是 `Option<String>`，没有 priority。

**建议**：

- `content` 改为 `String`（必填），`status` 改为枚举
- 补充 `PlanEntryPriority`（对 UI 排序和展示有帮助）

### 2.7 PermissionOptionKind / RequestPermissionOutcome

SDK 有：

```
PermissionOptionKind (enum) {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

RequestPermissionOutcome (enum) {
    Selected(SelectedPermissionOutcome),
    Cancelled,
}

SelectedPermissionOutcome {
    option_id: PermissionOptionId,
}
```

**项目现状**：`AcpPermissionOption.kind` 是 String，权限决策在 `permission.rs` 中通过 match string `"allow_once"` 等来处理。

**建议**：添加 `PermissionOptionKind` 枚举，让权限处理类型安全。当前的 string match 容易出 typo。

### 2.8 MCP over ACP

SDK 有 `McpOverAcpMessage`、`McpConnectRequest`、`McpConnectResponse`、`McpDisconnectNotification` 等类型，支持在 ACP 通道内转发 MCP 消息。

**项目现状**：MCP server 配置通过 `NewSessionParams.mcp_servers` 传给 agent，但不支持 MCP over ACP 消息转发。

**建议**：关注但不急于实现。这是一个高级特性，取决于是否有 agent 需要通过 ACP 通道接收 MCP 消息。

### 2.9 ExtRequest / ExtResponse / ExtNotification

SDK 提供了扩展点：

```rust
struct ExtRequest { method: String, params: Value }
struct ExtResponse { result: Value }
struct ExtNotification { method: String, params: Value }
```

用于在 ACP 协议内发送自定义消息，同时保持协议兼容。

**项目现状**：没有扩展点机制。`handle_client_request` 对未知方法返回 `-32601` error。

**建议**：低优先级。如果未来需要支持 agent-specific 的自定义方法，可以参考这个设计。

---

## 三、不需要照搬的部分

### 3.1 传输层（Builder / Stdio / ByteStreams）

SDK 的 `Builder` 是 long-running connection 模型，注册回调处理消息。项目是 subprocess + actor 模型，架构不同。

**不需要照搬**，当前的 `JsonRpcProcess` + `tokio::select!` actor 模型更适合项目的场景。

### 3.2 HandleDispatchFrom / Dispatch

SDK 的 handler 系统是为 Builder 模式设计的类型安全消息分发。项目已经有自己的分发逻辑（`run_turn_loop` 中的 method match）。

**不需要照搬**，但如果未来重构 live_session 的消息分发，可以参考其类型安全的设计思路。

### 3.3 ConnectTo / Component 抽象

SDK 的 component 系统（`ConnectTo` trait、`DynConnectTo`、`AcpAgent`）是为构建可组合的 ACP 组件设计的。项目只需要作为 client 连接 agent，不需要这个抽象层。

### 3.4 ChainRun / NullRun

SDK 的 `ChainRun` 组合多个 `RunIn` 实现并行执行，`NullRun` 是空操作。项目不需要。

### 3.5 MetaCapability / MetaCapabilityExt

SDK 的 `_meta` capability 系统用于在 capabilities 中附加额外元数据。项目通过 `serde(flatten)` 的 `extra` HashMap 已经实现了类似功能。

---

## 四、优先级排序

### P0 — 直接影响类型安全和代码质量

1. **ToolKind 枚举** — 消除 kind 字段的 string match
2. **ToolCallStatus 枚举** — 消除 status 字段的 string match
3. **StopReason 枚举** — 消除 stop_reason 的 string 处理
4. **PermissionOptionKind 枚举** — 消除权限 kind 的 string match

### P1 — 改善数据模型精度

5. **ToolCall / ToolCallUpdate 分层** — 区分创建和更新语义
6. **ToolCallContent 枚举** — 替代扁平的 AcpToolContentItem
7. **PlanEntry 类型化** — content 改必填，status 改枚举，加 priority
8. **ToolCallLocation struct** — 替代 raw JSON locations

### P2 — 补充协议覆盖

9. **SessionUpdate 新变体** — AvailableCommandsUpdate、CurrentModeUpdate、SessionInfoUpdate
10. **SessionConfigOption 类型化** — SessionConfigKind 枚举
11. **Capabilities 细化** — close/resume capabilities

### P3 — 关注但不急于实现

12. **MCP over ACP** — 等有实际需求
13. **ExtRequest/ExtNotification** — 等有 agent 需要自定义方法
14. **ContentBlock 完整体系** — 当前 image/audio 处理已够用

---

## 五、实施建议

### 阶段一：枚举化（P0）

在 `src-tauri/src/domain/` 中添加：

```rust
// domain/tool.rs（新文件或加入现有文件）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    #[serde(other)]
    Other,
}
```

然后更新 `types.rs` 中的 `AcpSessionUpdate` 使用这些枚举，更新 `parser.rs` 中的 `normalize_tool_status` 等函数。

### 阶段二：数据模型重构（P1）

- 拆分 `AcpSessionUpdate::ToolCall` 和 `ToolCallUpdate`
- 将 `AcpToolContentItem` 改为 `AcpToolContent` 枚举
- 添加 `ToolCallLocation` struct
- 改进 `PlanEntry` 类型

### 阶段三：协议扩展（P2）

- 补充 `SessionUpdate` 新变体
- 细化 `SessionConfigOption`
- 扩展 capabilities

---

## 六、参考链接

- SDK 文档：https://docs.rs/agent-client-protocol/latest/agent_client_protocol/
- SDK 源码：https://github.com/agentclientprotocol/rust-sdk
- ACP 协议规范：https://agentclientprotocol.github.io/acp/
