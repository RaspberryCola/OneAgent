# 状态优化 - 潜在问题排查

## 已修复的问题

1. **移除了废弃的状态变体**
   - 从枚举中删除了 `Idle`、`Starting`、`Ready`
   - 使用 `#[serde(alias)]` 在新状态上保持向后兼容

2. **更新了状态匹配逻辑**
   - `gateway/mod.rs`: 简化了 bootstrap 中的状态匹配
   - `store.ts`: 更新了 `isConversationActive` 函数

3. **状态映射**
   - `idle` / `ready` → 反序列化为 `Connected`
   - `starting` → 反序列化为 `Running`

## 可能的运行时问题

### 1. 数据库中的旧状态
如果数据库中已有 `idle`、`ready`、`starting` 状态的记录：
- **解决方案**: serde 的 `alias` 会自动处理反序列化
- 序列化时会输出新状态名称（`connected`、`running`）

### 2. 前端类型不匹配
TypeScript 类型中保留了旧状态名称以兼容：
```typescript
status: 'sleep' | 'initializing' | 'recovering' | 'connected' | 'running' | ... | 'idle' | 'starting' | 'ready'
```

### 3. 测试建议

#### 测试场景 1: 新建会话
```
预期: initializing → running → connected
```

#### 测试场景 2: 应用重启后
```
1. 启动应用
2. 检查旧会话状态 → 应该是 sleep (灰点)
3. 点击旧会话发送消息
4. 预期: sleep → recovering → running → connected
```

#### 测试场景 3: 内存常驻会话
```
1. 新建会话并完成一轮对话 → connected
2. 不关闭应用，再次发送消息
3. 预期: connected → running → connected (无 recovering)
```

## 调试命令

### 检查编译错误
```bash
cd src-tauri
cargo check
```

### 查看具体错误
```bash
cargo build 2>&1 | grep -A 5 "error"
```

### 运行应用
```bash
npm run tauri dev
```

## 如果仍有错误

请提供具体的错误信息：
1. 编译错误（Rust）
2. 运行时错误（控制台日志）
3. 前端错误（浏览器控制台）
