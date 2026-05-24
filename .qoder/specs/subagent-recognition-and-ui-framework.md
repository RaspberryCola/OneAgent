# 子 Agent 识别与 UI 折叠面板框架

## Context

**问题**: Claude Code、OpenCode 等 Agent 在执行任务时会创建子 Agent（如 Task Agent、Dispatch Agent）来处理探索、搜索等子任务。当前 OneAgent 将子 Agent 的执行过程与主 Agent 混在一起显示，导致：
1. 工具链路 UI 不清晰，子 Agent 和主 Agent 的工具调用混在一起
2. OpenCode 子 Agent 运行过程不可见，用户只能看到"正在调用"，完成后才能看到结果，容易误以为卡住了

**目标**: 设计可配置、可扩展的子 Agent 识别和渲染框架，实现：
- 通过配置规则识别不同 Agent 的子 Agent 调用
- 子 Agent 作为折叠面板独立显示，内部展示详细运行过程
- 运行时显示"正在运行..."状态，解决用户等待焦虑

---

## 核心设计思路

采用"配置驱动 + 运行时识别"架构：
- **配置层**: 通过数据库配置定义识别规则，支持不同 Agent 的差异
- **识别层**: 后端运行时根据规则匹配 ToolCall，识别子 Agent 调用
- **渲染层**: 前端使用专门的 `SubAgentDisplay` 组件渲染折叠面板

**关键设计决策**:
- 不新增 `ToolKind` enum 值，通过 `content_json.subagent_meta.is_subagent` 标识
- 不新增 `TimelineItem` 类型，通过判断字段切换渲染组件
- 使用 `SettingsRepository` 存储规则配置，支持动态更新

---

## 数据结构

### 1. 子 Agent 识别规则配置

存储在 `system_settings` 表，key 为 `subagent_rules:{agent_profile_id}`：

```json
{
  "rules": [
    {
      "rule_id": "claude_task_agent",
      "match_criteria": {
        "title_pattern": "^Task.*",
        "kind": "execute",
        "input_fields": { "prompt": { "required": true } }
      },
      "display_config": {
        "icon": "agent",
        "display_name": "Task Agent",
        "show_nested_timeline": true
      },
      "content_extraction": {
        "message_path": "result.messages",
        "tool_calls_path": "result.tool_calls",
        "summary_path": "result.summary"
      }
    }
  ]
}
```

### 2. ToolCallProjection 扩展

利用现有 `content_json` 字段存储子 Agent 元数据：

```json
{
  "content_items": [...],
  "subagent_meta": {
    "is_subagent": true,
    "agent_type": "claude_task_agent",
    "rule_id": "claude_task_agent",
    "nested_timeline": {
      "messages": [...],
      "tool_calls": [...],
      "status": "running",
      "result_summary": "..."
    }
  }
}
```

---

## 实现步骤

### Phase 1: 后端规则与识别

**Step 1.1**: 创建 `src-tauri/src/runtime/subagent_rules.rs`
- 定义 `SubagentRuleConfig`, `SubagentMatchCriteria`, `SubagentMeta` 结构
- 实现 `load_subagent_rules(profile_id)` 从 SettingsRepository 加载
- 实现 `match_tool_call_to_subagent()` 规则匹配函数
- 提供 `DEFAULT_SUBAGENT_RULES` 常量（Claude Code/OpenCode 默认规则）

**Step 1.2**: 修改 `src-tauri/src/runtime/projector/tool_call.rs`
- 在 `project_tool_call()` 中调用 `match_subagent_call()`
- 构建 `content_json.subagent_meta` 结构
- 实现 `extract_nested_timeline_from_output()` 从 `raw_output_json` 提取内容

**Step 1.3**: 修改 `src-tauri/src/runtime/mod.rs`
- Runtime 结构新增 `subagent_rules_cache: HashMap<String, SubagentRuleConfig>`
- 初始化时加载规则

### Phase 2: 前端渲染组件

**Step 2.1**: 创建 `src/components/chat/SubAgentDisplay.tsx`
- 复用 `ToolCallDisplay` 的折叠面板结构
- Props: `{ toolCall, terminals, permissionDecision }`
- 状态指示器使用 `StatusDot` 脉冲动画
- 展开后显示 Input / Nested Timeline / Output

**Step 2.2**: 创建 `src/components/chat/NestedTimelineRenderer.tsx`
- 简化版 timeline 渲染（text/thinking 消息 + tool_call）
- 支持递归子子 Agent（限制 2 层）

**Step 2.3**: 修改 `src/screens/conversation/ConversationScreen.tsx`
- 在 tool_call 渲染分支添加判断：
  ```tsx
  if (toolCall.content_json?.subagent_meta?.is_subagent) {
    return <SubAgentDisplay ... />;
  }
  return <ToolCallDisplay ... />;
  ```

### Phase 3: 配置管理（可选）

**Step 3.1**: 提供默认规则
- Claude Code Task Agent 识别规则
- OpenCode dispatch_agent 识别规则

**Step 3.2**: 设置界面（可选，后续迭代）
- 规则配置编辑 UI
- 支持添加/编辑/删除规则

---

## 关键文件修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/runtime/subagent_rules.rs` | **新建** | 规则定义、加载、匹配核心模块 |
| `src-tauri/src/runtime/projector/tool_call.rs` | **修改** | 集成子 Agent 识别，填充 content_json |
| `src-tauri/src/runtime/mod.rs` | **修改** | Runtime 添加规则缓存 |
| `src/components/chat/SubAgentDisplay.tsx` | **新建** | 子 Agent 折叠面板组件 |
| `src/components/chat/NestedTimelineRenderer.tsx` | **新建** | 嵌套 timeline 渲染组件 |
| `src/screens/conversation/ConversationScreen.tsx` | **修改** | 渲染判断逻辑 |
| `src/lib/backend/types.ts` | **修改** | 添加 SubagentMeta 类型定义（可选） |

---

## Agent 适配示例

### Claude Code Task Agent
```json
{
  "rule_id": "claude_task_agent",
  "match_criteria": {
    "title_pattern": "^Task.*"
  },
  "content_extraction": {
    "message_path": "result.messages",
    "tool_calls_path": "result.tool_calls"
  }
}
```

### OpenCode dispatch_agent
```json
{
  "rule_id": "opencode_dispatch_agent",
  "match_criteria": {
    "title_pattern": "^(dispatch_agent|Dispatch Agent).*"
  },
  "content_extraction": {
    "message_path": "output.messages"
  }
}
```

添加新 Agent 只需：
1. 分析 tool_call 输出格式
2. 编写识别规则配置
3. 测试验证

---

## Verification

### 测试步骤
1. 运行 Claude Code Agent，执行包含 Task Agent 的任务
2. 验证子 Agent tool_call 正确识别（content_json.subagent_meta.is_subagent = true）
3. 验证前端渲染 SubAgentDisplay 而非 ToolCallDisplay
4. 验证运行时显示 "Running..." 状态
5. 完成后验证 nested_timeline 正确提取和渲染

### 测试命令
```bash
# 后端单元测试
cd src-tauri && cargo test subagent

# 前端组件测试
npm run test -- src/components/chat/__tests__/SubAgentDisplay.test.tsx

# 集成验证
npm run tauri dev
# 使用 Claude Code Agent 执行复杂任务
```

---

## 后续扩展

- 多层子 Agent 支持（限制 2 层递归）
- 子 Agent 性能指标（token 使用、耗时）
- 子 Agent 权限独立处理