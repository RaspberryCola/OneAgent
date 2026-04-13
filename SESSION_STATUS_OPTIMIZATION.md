# 会话状态优化说明

## 改动概述

优化了会话状态管理，区分内存常驻会话和冷启动会话，提供更准确的状态反馈。

## 新增状态

| 状态 | 颜色 | 脉动 | 说明 |
|------|------|------|------|
| `sleep` | 灰色 | 否 | 应用重启后，非内存会话的休眠状态 |
| `initializing` | 黄色 | 是 | 新建会话时的初始化状态 |
| `recovering` | 黄色 | 是 | 从 sleep 状态恢复会话（执行 session/load） |
| `connected` | 绿色 | 否 | 会话已连接并准备就绪（替代 ready） |
| `running` | 蓝色 | 是 | 会话正在执行任务（执行 session/prompt） |

## 状态转换流程

### 1. 新建会话
```
initializing (黄点) 
  → [create_conversation 完成]
connected (绿点)
  → [用户发送消息，内存中有会话]
running (蓝点)
  → [Turn 完成]
connected (绿点)
```

### 2. 冷启动会话（应用重启后）
```
connected (绿点) 
  → [应用重启，bootstrap 检测到不在内存]
sleep (灰点)
  → [用户发送消息，设置 recovering]
recovering (黄点) 
  → [spawn 进程 + initialize + session/load 完成]
running (蓝点)
  → [session/prompt 开始，adapter 发送 StateChanged 事件]
  → [Turn 完成]
connected (绿点)
```

### 3. 热启动会话（内存常驻）
```
connected (绿点)
  → [用户发送消息，检测到在内存中]
running (蓝点)
  → [直接使用已有进程 session/prompt]
  → [Turn 完成]
connected (绿点)
```

### 4. 导入外部会话
```
initializing (黄点)
  → [session/load 完成，重放历史]
connected (绿点)
```

## 核心实现

### 1. 后端状态枚举（`domain/mod.rs`）
```rust
pub enum ConversationStatus {
    Sleep,          // 新增：休眠状态
    Initializing,   // 新增：初始化中
    Recovering,     // 新增：恢复中（session/load）
    #[serde(alias = "ready", alias = "idle")]
    Connected,      // 新增：已连接（替代 Ready）
    #[serde(alias = "starting")]
    Running,        // 运行中（session/prompt）
    // ...
}
```

### 2. 发送消息时的状态判断（`runtime/mod.rs`）
```rust
// 检查会话是否在内存中
let is_session_in_memory = self.is_session_in_memory(conversation_id);
let initial_status = if is_session_in_memory {
    ConversationStatus::Running  // 内存中直接运行
} else if matches!(conversation.status, ConversationStatus::Sleep) {
    ConversationStatus::Recovering  // 从休眠恢复（将执行 session/load）
} else {
    ConversationStatus::Initializing  // 新建会话
};
```

### 3. 状态事件处理（`runtime/mod.rs`）
```rust
// adapter.prompt() 在 session/prompt 开始时发送 StateChanged { status: "running" }
RuntimeStreamEvent::StateChanged { status } => {
    if status == "running" {
        self.db.update_conversation_status(conversation_id, ConversationStatus::Running)?;
    }
    // ...
}
```

### 4. Recovering 的实际操作（`agent_adapters/acp.rs`）
```rust
async fn prompt(...) -> AdapterResult<Vec<RuntimeStreamEvent>> {
    // 1. 启动新进程
    let mut process = JsonRpcProcess::spawn(profile).await?;
    
    // 2. 初始化
    process.initialize().await?;
    
    // 3. 加载会话（Recovering 状态覆盖这个过程）
    process.request("session/load", json!({
        "sessionId": handle.remote_session_id,
        "cwd": handle.cwd,
        "mcpServers": []
    })).await?;
    
    // 4. 发送 prompt（此时发送 StateChanged { status: "running" }）
    process.write_message(json!({
        "method": "session/prompt",
        "params": { "sessionId": ..., "prompt": ... }
    })).await?;
    
    // 5. 返回事件流（包含 StateChanged 事件）
    let mut events = vec![RuntimeStreamEvent::StateChanged {
        status: "running".to_string(),
    }];
    // ...
}
```

### 5. Bootstrap 时标记休眠会话（`gateway/mod.rs`）
```rust
// 标记非内存会话为 Sleep
for conversation in &mut conversations {
    if !self.runtime.is_session_in_memory(&conversation.id)
        && conversation.status == ConversationStatus::Connected {
        self.db.update_conversation_status(&conversation.id, ConversationStatus::Sleep)?;
        conversation.status = ConversationStatus::Sleep;
    }
}
```

### 6. 前端状态显示（`App.tsx`）
```typescript
function statusMeta(status?: Types.Conversation["status"]) {
  switch (status) {
    case "sleep":
      return { label: "Sleep", dot: "bg-stone-400", pulse: false };
    case "initializing":
    case "starting":
      return { label: "Initializing", dot: "bg-amber-500", pulse: true };
    case "recovering":
      return { label: "Recovering", dot: "bg-amber-500", pulse: true };
    case "running":
      return { label: "Running", dot: "bg-blue-500", pulse: true };
    case "connected":
    case "ready":
    case "idle":
      return { label: "Connected", dot: "bg-emerald-500", pulse: false };
    // ...
  }
}
```

## 用户体验改进

1. **清晰的状态反馈**：用户可以直观看到会话是否在内存中
2. **准确的恢复提示**：
   - `Recovering` = 正在执行 `session/load`（重新加载会话状态）
   - `Running` = 正在执行 `session/prompt`（AI 处理中）
3. **统一的术语**：使用 "Connected" 替代 "Ready"，更符合会话连接的语义
4. **视觉区分**：
   - 灰点 = 休眠/已取消
   - 黄点 + 脉动 = 初始化/恢复中（准备阶段）
   - 蓝点 + 脉动 = 运行中（AI 工作中）
   - 绿点 = 已连接就绪（等待输入）

## 兼容性

- 保留了旧状态别名（`idle`、`starting`、`ready`）用于反序列化
- 前端同时支持新旧状态名称
- 数据库中的旧状态会在 bootstrap 时自动转换
