# 问题1：模型列表查看与切换功能

## 实施状态：已完成 ✅

实施日期：2026-04-12

---

## 核心问题与解决方案

### 根本原因

1. **旧版 adapter (0.1.6) 不返回模型信息**
   - `session/new` 响应只包含 `{ sessionId }`

2. **模型切换 API 名称错误**
   - OneAgent 使用 `unstable_setSessionModel`，但实际 API 是 `session/set_model`

3. **事件覆盖问题**
   - `onConversationStateChanged` 会完全替换 `activeConversationState`
   - 如果事件中的 models 是旧值，会覆盖刚设置的模型

### 解决方案

**升级 adapter + 修正 API + 保护 models 状态**

---

## 实施摘要

### 修复 1：升级 adapter 版本 ✅

| 文件 | 改动 |
|------|------|
| `agent_launch.rs` | 版本号 0.1.6 → 0.16.2 |
| `prepare-claude-runtime.mjs` | 版本号 0.1.6 → 0.16.2 |
| `acp.rs` | `ACP_PROTOCOL_VERSION` → `1` (u64) |

### 修复 2：添加 setModel API ✅

**后端：**
| 文件 | 改动 |
|------|------|
| `domain/mod.rs` | 新增 `SetModelInput` 类型 |
| `agent_adapters/acp.rs` | 新增 `SetModel` 命令，调用 `session/set_model` |
| `runtime/mod.rs` | 新增 `set_model` 方法、`update_snapshot_models` |
| `gateway/mod.rs` | 新增 `set_model` 方法 |
| `channel_api/mod.rs` | 新增 `set_model` 命令 |
| `lib.rs` | 注册命令 |

**前端：**
| 文件 | 改动 |
|------|------|
| `types.ts` | 新增 `SetModelInput` 类型 |
| `commands.ts` | 新增 `setModel` API |
| `events.ts` | `ConversationConfigUpdatedPayload` 支持 `models` 字段 |
| `store.ts` | `setSessionConfig` 自动判断模型切换并调用 `setModel` |
| `store.ts` | 新增 `setModel` 方法 |
| `store.ts` | sendMessage 中分离 modelOverrides 使用 `setModel` |
| `store.ts` | `onConversationStateChanged` 保护已设置的 models |

### 修复 3：保护 models 状态 ✅

**问题：** `state_changed` 事件会覆盖 models

**解决：**
```typescript
// 在 onConversationStateChanged 中
if (currentAvailableModels && currentAvailableModels.length > 0 &&
    (!payloadAvailableModels || payloadAvailableModels.length === 0)) {
  // 保留当前 models，不使用 payload 中的空值
  newState = { ...payload.state, models: currentModels };
}
```

---

## 数据流

### 创建新对话

```
首页选择模型 → sendMessage
    ↓
createConversation → models: default
    ↓
modelOverrides → API.setModel(modelId)
    ↓
返回 models: { currentModelId: modelId }
    ↓
store 更新 activeConversationState.models
    ↓
发送消息使用正确模型
```

### 切换模型

```
handleModelChange(modelId) → setSessionConfig("model", modelId)
    ↓
store 检测是模型 → API.setModel
    ↓
后端 session/set_model
    ↓
返回 models → emit config_updated
    ↓
store 更新 models
    ↓
UI 显示新模型
```

---

## 测试验证

- ✅ adapter 0.16.2 返回 models 信息
- ✅ `session/set_model` API 正确切换模型
- ✅ 新对话时模型选择正确传递
- ✅ 已有对话时模型切换正常工作

---

## 原问题分析

当前模式下 Claude Code 无法查看模型列表，无法切换模型。用户在选择 Agent 后，应该能够看到可用的模型选项并进行切换。

## 当前状态分析

### 前端实现

**关键文件：`src/App.tsx`**

1. **模型选择器状态构建** (lines 272-341)
   ```typescript
   function buildModelSelectorState(
     configOptions: Types.SessionConfigOption[],
     models?: Types.AcpSessionModels | null
   ): ModelSelectorState | null
   ```
   - 优先使用 `configOptions` (稳定 API) - 查找 category 为 "model" 或 id 包含 "model" 的选项
   - 回退使用 `models` (不稳定 API) - 使用 `AcpSessionModels.current_model_id` 和 `available_models`

2. **数据获取流程** (lines 614-653)
   ```typescript
   useEffect(() => {
     // 从 localStorage 缓存读取
     const cachedConfig = readJsonStorage<Record<string, Types.SessionConfigOption[]>>(MODEL_CONFIG_CACHE_KEY)?.[activeAgentProfileId] ?? [];
     const cachedModels = readJsonStorage<Record<string, Types.AcpSessionModels | null>>(MODEL_MODELS_CACHE_KEY)?.[activeAgentProfileId] ?? null;
     setDraftConfigOptions(cachedConfig);
     setDraftModels(cachedModels);

     // 调用 API 获取最新配置
     void API.previewSessionConfig({
       workspace_id: activeWorkspace.id,
       agent_profile_id: activeAgentProfileId,
     })
       .then((result) => {
         setDraftConfigOptions(result.config_options);
         setDraftModels(result.models ?? null);
         // 更新缓存
         writeJsonStorage(MODEL_CONFIG_CACHE_KEY, nextConfigCache);
         writeJsonStorage(MODEL_MODELS_CACHE_KEY, nextModelsCache);
       })
   }, [activeConversationId, activeWorkspace, activeAgentProfileId]);
   ```

3. **模型切换处理** (lines 806-836)
   ```typescript
   const handleModelChange = async (value: string) => {
     if (!activeConversationId) {
       // 新对话：保存到 localStorage，创建对话时作为 sessionConfigOverrides 传递
       writeJsonStorage(MODEL_SELECTION_CACHE_KEY, nextSelections);
       return;
     }
     // 已有对话：调用 setSessionConfig API
     await setSessionConfig(modelSelector.option.id, value);
   }
   ```

### 后端实现

**关键文件：`src-tauri/src/runtime/mod.rs`**

1. **previewSessionConfig API** (lines 181-212)
   ```rust
   pub async fn preview_session_config(
       &self,
       input: PreviewSessionConfigInput,
   ) -> RuntimeResult<PreviewSessionConfigResult> {
       // 创建临时 session 获取配置
       let session = AcpLiveSession::start_new(&profile, &workspace.cwd, &mcp_servers).await?;
       let result = PreviewSessionConfigResult {
           config_options: session.handle.config_options.clone(),
           models: session.handle.models.clone(),
       };
       session.close();
       Ok(result)
   }
   ```

**关键文件：`src-tauri/src/agent_adapters/acp.rs`**

1. **配置解析函数** (lines 1654-1703)
   ```rust
   fn parse_config_options(result: Option<&Value>) -> Vec<SessionConfigOption> {
       result
           .and_then(|value| value.get("configOptions"))
           .and_then(Value::as_array)
           .map(|items| {
               items.iter().map(|item| SessionConfigOption {
                   id: item.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                   name: item.get("name").and_then(Value::as_str)...,
                   option_type: item.get("type").and_then(Value::as_str).unwrap_or("string").to_string(),
                   current_value: item.get("currentValue").cloned()...,
                   options: item.get("options").cloned()...,
                   raw: item.clone(),
               }).collect()
           })
           .unwrap_or_default()
   }
   ```

2. **模型解析函数** (lines 1706-1740)
   ```rust
   fn parse_models(result: Option<&Value>) -> Option<AcpSessionModels> {
       // 检查顶层 models
       let models = value.get("models");
       // 也检查 _meta.models (某些 agent 如 iFlow 使用)
       let meta_models = value.get("_meta").and_then(|m| m.get("models"));

       Some(AcpSessionModels {
           current_model_id: models_source.get("currentModelId")...,
           available_models: models_source.get("availableModels")...,
       })
   }
   ```

### 类型定义

**关键文件：`src/lib/backend/types.ts`**

```typescript
export interface AcpAvailableModel {
  id?: string;
  model_id?: string;
  name?: string;
}

export interface AcpSessionModels {
  current_model_id?: string;
  available_models?: AcpAvailableModel[];
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  option_type: string;
  current_value: any;
  options: any;
  raw: Record<string, any>;
}
```

## 问题根因分析

1. **previewSessionConfig 可能返回空数据**
   - 当前实现创建临时 session 后立即关闭，可能未等到完整响应
   - Claude Code ACP adapter 可能需要认证后才能返回模型列表

2. **缺少实时更新机制**
   - 当前只在初始加载时获取配置，不监听后续变化
   - 对话过程中模型切换后，UI 不会自动更新

3. **模型选择器 UI 依赖 conversationId**
   - 新对话时使用 draftConfigOptions，可能为空
   - 没有独立的"获取模型列表"API（不依赖 workspace/conversation）

## 参考实现：AionUi

**关键文件：`/Users/smkl/mydevelop/GithubProjects/AionUi/src/renderer/components/agent/AcpModelSelector.tsx`**

### 核心设计模式

1. **三层 UI 状态** (lines 213-289)
   ```typescript
   // 状态1：无模型信息 - 显示禁用的 "Use CLI model" 按钮
   if (!modelInfo) {
     return <Tooltip content="模型切换不支持">
       <Button disabled>Use CLI model</Button>
     </Tooltip>;
   }

   // 状态2：有信息但不可切换 - 只读显示
   if (!modelInfo.canSwitch) {
     return <Tooltip content={displayLabel}>
       <Button style={{ cursor: 'default' }}>{displayLabel}</Button>
     </Tooltip>;
   }

   // 状态3：可切换 - 下拉选择器
   return <Dropdown droplist={<Menu>...</Menu>}>
     <Button>{displayLabel}</Button>
   </Dropdown>;
   ```

2. **实时事件监听** (lines 132-171)
   ```typescript
   useEffect(() => {
     const handler = (message: IResponseMessage) => {
       if (message.type === 'acp_model_info' && message.data) {
         setModelInfo(message.data as AcpModelInfo);
       } else if (message.type === 'codex_model_info' && message.data) {
         // Codex 模型信息：始终只读
         setModelInfo({ source: 'models', canSwitch: false, ... });
       }
     };
     return ipcBridge.acpConversation.responseStream.on(handler);
   }, [conversationId]);
   ```

3. **缓存机制** (lines 108-129)
   ```typescript
   async function loadCachedModelInfo(backendKey: string) {
     const cached = await ConfigStorage.get('acp.cachedModels');
     const cachedInfo = cached?.[backendKey];
     if (cachedInfo?.availableModels?.length > 0) {
       setModelInfo(cachedInfo);
     }
   }
   ```

4. **模型健康状态显示** (lines 203-210)
   ```typescript
   const currentModelHealth = React.useMemo(() => {
     const providerConfig = modelConfig?.find((p) => p.platform?.includes(backend));
     const healthStatus = providerConfig?.modelHealth?.[modelInfo.currentModelId]?.status;
     const healthColor = healthStatus === 'healthy' ? 'bg-green-500' :
                         healthStatus === 'unhealthy' ? 'bg-red-500' : 'bg-gray-400';
     return { status: healthStatus, color: healthColor };
   }, [modelInfo?.currentModelId, modelConfig, backend]);
   ```

## 实施方案

### Phase 1：增加模型信息的实时事件监听

**修改文件：**
- `src-tauri/src/runtime/mod.rs`
- `src-tauri/src/backend/events.ts` (新增事件类型)
- `src/lib/backend/events.ts`

**步骤：**
1. 在 `AcpLiveSession` 的 live actor 循环中，监听 `session/update` 事件
2. 当收到包含模型信息的 update 时，emit `acp_model_info` 事件到前端
3. 前端新增 `onModelInfoUpdated` 事件处理器

### Phase 2：增强 previewSessionConfig 可靠性

**修改文件：**
- `src-tauri/src/runtime/mod.rs`

**步骤：**
1. 增加 timeout 等待 session/new 完整响应
2. 处理认证失败场景，返回友好错误
3. 在 session 创建失败时，尝试使用缓存的模型列表

### Phase 3：改进 UI 交互

**修改文件：**
- `src/App.tsx`

**步骤：**
1. 模型选择器增加三种 UI 状态区分
2. 显示模型加载状态（loading indicator）
3. 增加模型健康状态指示（需要后端支持）

### Phase 4：增加独立的模型列表 API

**修改文件：**
- `src-tauri/src/channel_api/mod.rs`
- `src-tauri/src/runtime/mod.rs`
- `src/lib/backend/commands.ts`

**步骤：**
1. 新增 `getAgentModels(agent_profile_id)` API
2. 不依赖 workspace/conversation，直接 probe agent 获取模型列表
3. 可用于 Agent 选择界面展示可用模型

## 验证方案

1. 选择 Claude Code Agent，观察模型选择器是否显示可用模型
2. 切换模型后，确认对话使用新模型
3. 新对话场景，确认模型选择被正确保存和应用
4. 检查缓存机制是否正常工作（重启应用后模型列表仍可用）