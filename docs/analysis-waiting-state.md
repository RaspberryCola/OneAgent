# 问题2：发送消息后的等待状态

## 问题描述

当前模式下，发送完消息之后，应当进入一个等待状态，能让用户知道 Agent 正在运行中。至少要包含：
1. 发送按钮变成转圈动画
2. 聊天界面有一个提示（如 "Thinking..."）

## 当前状态分析

### 前端实现

**关键文件：`src/App.tsx`**

1. **发送处理函数** (lines 694-724)
   ```typescript
   const handleSend = async () => {
     if (!canSend || !activeAgentProfileId) return;

     // 准备附件和文本
     const payload: Types.AttachmentInput[] = attachmentStates.map(...);
     const text = input.trim();

     // 清空输入框
     setAttachments([]);
     setInput("");
     setComposerNotice(null);

     try {
       await sendMessage(text, payload, sessionConfigOverrides);
       // 发送成功后没有视觉反馈
     } catch (error) {
       // 错误时恢复输入
       setInput(text);
       setAttachments(draftAttachments);
       setComposerNotice("Failed to send message.");
     }
   };
   ```

2. **发送按钮渲染** (需要找到具体位置)
   ```tsx
   // 当前发送按钮是静态图标，没有 loading 状态
   <button onClick={handleSend} disabled={!canSend}>
     <ArrowUp className="w-4 h-4" />
   </button>
   ```

3. **对话状态元数据** (lines 362-404)
   ```typescript
   function statusMeta(status?: Types.Conversation["status"]) {
     switch (status) {
       case "starting": return { label: "Initializing", dot: "bg-amber-500", pulse: true };
       case "running": return { label: "Thinking", dot: "bg-blue-500", pulse: true };
       case "ready" | "idle": return { label: "Connected", dot: "bg-emerald-500", pulse: false };
       case "failed": return { label: "Failed", dot: "bg-rose-500", pulse: false };
       // ...
     }
   }
   ```

4. **状态同步机制** (`src/lib/store.ts` lines 173-219)
   ```typescript
   function startConversationSync(conversationId: string, ...) {
     // 每 500ms 轮询 getConversationTimeline 和 getConversationState
     for (let attempt = 0; attempt < 1200; attempt += 1) {
       const [timeline, state] = await Promise.all([
         API.getConversationTimeline(conversationId),
         API.getConversationState(conversationId),
       ]);
       set({ activeConversationState: state, ... });
       if (!isConversationActive(state)) return;
       await new Promise((resolve) => window.setTimeout(resolve, 500));
     }
   }
   ```

### 后端实现

**关键文件：`src-tauri/src/runtime/mod.rs`**

1. **消息发送流程** (lines 369-443)
   ```rust
   pub async fn send_user_message(&self, input: SendUserMessageInput) -> RuntimeResult<TimelineResponse> {
       // 1. 验证对话状态（非 running）
       // 2. 更新状态为 "Running"
       self.db.update_conversation_status(&conversation.id, ConversationStatus::Running)?;

       // 3. 创建 turn ID 和消息记录
       // 4. emit conversation.message_appended 事件

       // 5. 后台异步执行 turn 任务
       tokio::spawn(async move {
           run_turn_task(...).await;
       });

       // 6. 立即返回 timeline（不等待完成）
       Ok(timeline)
   }
   ```

2. **状态变更事件** 
   ```rust
   // emit_conversation_state 发送 ConversationStateChanged 事件
   fn emit_conversation_state(&self, conversation_id: &str) -> RuntimeResult<()> {
       let state = self.build_conversation_state(conversation_id)?;
       self.event_tx.send(EventPayload::ConversationStateChanged { ... });
   }
   ```

### 问题根因分析

1. **发送按钮无状态变化**
   - `handleSend` 清空输入后立即等待 `sendMessage` 完成
   - 没有设置 `isSending` 状态来控制按钮动画
   - 按钮组件没有接收 loading prop

2. **对话状态延迟感知**
   - 状态同步依赖 500ms 轮询，有延迟
   - 发送成功后需要等待下一轮轮询才能看到 "running" 状态

3. **缺少即时视觉反馈**
   - 没有 "Thinking..." 消息占位
   - 没有 Thought 显示区域（思考过程）

## 参考实现：AionUi

### 核心状态管理

**关键文件：`/Users/smkl/mydevelop/GithubProjects/AionUi/src/renderer/pages/conversation/platforms/acp/useAcpMessage.ts`**

1. **多层状态定义** (lines 15-27)
   ```typescript
   type UseAcpMessageReturn = {
     running: boolean;                    // Agent 执行状态
     hasHydratedRunningState: boolean;    // 是否已从后端恢复状态
     acpStatus: 'connecting' | 'connected' | 'authenticated' | 'session_active' | 'disconnected' | 'error' | null;
     aiProcessing: boolean;               // AI 响应处理中
     setAiProcessing: React.Dispatch<...>;
     resetState: () => void;
     tokenUsage: TokenUsageData | null;
     contextLimit: number;
     hasThinkingMessage: boolean;         // 是否有思考消息
   };
   ```

2. **事件驱动状态更新** (lines 143-295)
   ```typescript
   case 'start':
     // 新 turn 开始
     turnFinishedRef.current = false;
     setRunning(true);
     runningRef.current = true;
     break;

   case 'finish':
     // Turn 完成
     turnFinishedRef.current = true;
     setRunning(false);
     setAiProcessing(false);
     setThought({ subject: '', description: '' });
     break;

   case 'content':
     // 首个内容 token — AI 已开始响应
     if (!hasContentInTurnRef.current) {
       hasContentInTurnRef.current = true;
       setAiProcessing(false);  // 清除处理指示
     }
     break;

   case 'error':
     // 错误时停止所有加载状态
     setRunning(false);
     setAiProcessing(false);
     break;
   ```

3. **Throttled Thought 更新** (lines 74-104)
   ```typescript
   // 减少 thought 更新频率，避免过度渲染
   const throttledSetThought = useMemo(() => {
     const THROTTLE_MS = 50;
     return (data: ThoughtData) => {
       // throttle logic...
     };
   }, []);
   ```

### SendBox 组件

**关键文件：`/Users/smkl/mydevelop/GithubProjects/AionUi/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx`**

1. **状态计算** (line 138)
   ```typescript
   const isBusy = running || aiProcessing;
   ```

2. **SendBox loading prop** (lines 348-362)
   ```tsx
   <SendBox
     value={content}
     onChange={setContent}
     loading={isBusy}                    // ← 控制 loading 状态
     disabled={false}
     placeholder={t('acp.sendbox.placeholder', { backend: agentName })}
     onStop={handleStop}                // ← 停止按钮
   />
   ```

3. **ThoughtDisplay 组件** (line 346)
   ```tsx
   <ThoughtDisplay
     running={aiProcessing && !hasThinkingMessage}
     onStop={handleStop}
   />
   ```

### SendBox 组件实现

**关键文件：`/Users/smkl/mydevelop/GithubProjects/AionUi/src/renderer/components/chat/sendbox.tsx`**

该组件接收 `loading` prop 并显示：
- Loading 时：转圈动画 + 停止按钮
- 正常时：发送按钮

## 实施方案

### Phase 1：增加发送状态管理

**修改文件：`src/App.tsx`**

1. 新增状态变量
   ```typescript
   const [isSending, setIsSending] = useState(false);
   ```

2. 修改 `handleSend`
   ```typescript
   const handleSend = async () => {
     if (!canSend) return;
     setIsSending(true);  // ← 立即显示 loading

     try {
       await sendMessage(text, payload, sessionConfigOverrides);
     } finally {
       setIsSending(false);  // ← 完成后清除
     }
   };
   ```

3. 计算综合 busy 状态
   ```typescript
   const isBusy = isSending ||
     conversationStatus?.label === "Thinking" ||
     conversationStatus?.label === "Initializing";
   ```

### Phase 2：改进发送按钮 UI

**修改文件：`src/App.tsx`**

1. 发送按钮支持 loading 状态
   ```tsx
   <button onClick={handleSend} disabled={!canSend || isBusy}>
     {isBusy ? (
       <Loader2 className="w-4 h-4 animate-spin" />
     ) : (
       <ArrowUp className="w-4 h-4" />
     )}
   </button>
   ```

2. 增加 stop 按钮（可选）
   ```tsx
   {isBusy && (
     <button onClick={handleStop}>
       <Square className="w-4 h-4" />
     </button>
   )}
   ```

### Phase 3：增加消息发送状态提示

**修改文件：`src/App.tsx`**

1. 在消息列表区域增加状态提示
   ```tsx
   {(conversationStatus?.pulse || isSending) && (
     <div className="flex items-center gap-2 text-sm text-stone animate-pulse">
       <Loader2 className="w-4 h-4 animate-spin" />
       <span>{conversationStatus?.label || "Sending..."}</span>
     </div>
   )}
   ```

### Phase 4：增加 Thought 显示区域（可选增强）

**新增组件：`src/components/ThoughtDisplay.tsx`**

参考 AionUi 的 ThoughtDisplay 组件：
- 显示 Agent 思考过程
- 支持 throttle 更新
- 包含停止按钮

### Phase 5：优化事件驱动更新（可选增强）

**修改文件：`src/lib/store.ts`**

当前使用 500ms 轮询同步状态，可改为：
1. 监听 `ConversationStateChanged` 事件实时更新
2. 监听 `agent_status` 类型的消息流事件

## 验证方案

1. 发送消息后，观察发送按钮是否立即变成转圈动画
2. 消息发送过程中，聊天界面显示 "Thinking..." 提示
3. Agent 响应到达后，loading 状态消失
4. 错误场景（网络失败）时，loading 状态正确清除
5. 多条消息连续发送时，状态正确切换

## 涉及的关键文件

| 文件 | 修改内容 |
|------|----------|
| `src/App.tsx` | 增加 isSending 状态、改进发送按钮 UI、增加状态提示 |
| `src/lib/store.ts` | 可选：优化事件驱动状态更新 |
| `src/components/ThoughtDisplay.tsx` | 新增：思考过程显示组件（可选） |