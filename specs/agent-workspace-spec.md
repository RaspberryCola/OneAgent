# IM Settings Session Routing & Pairing 组件复用与 i18n

## Context

在设置页面的消息渠道（IM Channels）中，微信和飞书两个 Bot 渠道都配置了 Session Routing 和 Pairing Requests 区域。当前这两个区域是完全重复的代码，存在以下问题：

1. **代码重复**：相同的 UI 结构复制了两份，分别用于微信和飞书
2. **不一致性**：微信标题是 "Session Routing"，飞书是 "Session Routing Configuration"
3. **未 i18n**：所有文案都是硬编码英文，未进行国际化
4. **维护成本高**：新增渠道时需要再次复制代码

本次重构提取两个可复用组件，统一 UI 表现，并添加基本的 i18n 支持。

## 修改文件

### 新建文件
- `src/components/settings/ChannelSessionRouting.tsx` - 通用 Session Routing 面板组件
- `src/components/settings/ChannelPairingRequests.tsx` - 通用 Pairing Requests 面板组件

### 修改文件
- `src/components/settings/ImSettingsPane.tsx` - 使用新组件替换重复代码
- `src/locales/en/settings.json` - 添加 Session Routing 和 Pairing 相关英文文案
- `src/locales/zh-CN/settings.json` - 添加 Session Routing 和 Pairing 相关中文文案

## 实现方案

### 1. ChannelSessionRouting 组件

**Props 接口：**
```typescript
interface ChannelSessionRoutingProps {
  workspaceId: string;
  agentProfileId: string;
  modelId: string;
  availableModels: Types.AcpAvailableModel[];
  workspaces: Types.Workspace[];
  agents: Types.AgentProfile[];
  onUpdateConfig: (wsId: string, agentId: string, modelId: string) => Promise<void>;
}
```

**UI 结构：**
- 标题：使用 i18n `t('sessionRouting.title')` → "Session Routing"
- 三列网格布局：
  - Workspace 下拉框：
    - Label：使用 i18n `t('sessionRouting.workspace')` → 英文 "Workspace" / 中文 "工作区"
    - 默认选项：硬编码 "Default Workspace (First Available)"（不翻译）
  - Agent 下拉框：
    - Label：使用 i18n `t('sessionRouting.agent')` → "Agent"（不翻译，中英文都用）
    - 默认选项：硬编码 "Default Agent (First Enabled)"（不翻译）
  - Model 搜索下拉框：
    - Label：使用 "Model"（不翻译）
    - 默认选项：硬编码 "Default Model (Agent Default)"（不翻译）
    - 搜索框占位符：硬编码 "Search models..."（不翻译）

**注意**：用户明确要求只翻译 WORKSPACE，AGENT 和 MODEL 不翻译。

### 2. ChannelPairingRequests 组件

**Props 接口：**
```typescript
interface ChannelPairingRequestsProps {
  platform: string;
  pendingPairings: events.ImPairingRequestedPayload[];
  onApprove: (code: string) => Promise<void>;
  onClear: (platform: string) => Promise<void>;
  pairingCodeInput: string;
  onInputChange: (value: string) => void;
  pairingMessage: string | null;
  pairingMessageType: 'success' | 'error' | null;
}
```

**UI 结构：**
- 标题：使用 i18n `t('pairingRequests.title')` → 英文 "Pairing Requests" / 中文 "配对请求"
- 手动输入框占位符：使用 i18n `t('pairingRequests.enterCode')` → 英文 "Enter 6-digit code" / 中文 "输入6位验证码"
- Approve 按钮：使用 i18n `t('pairingRequests.approve')` → 英文 "Approve" / 中文 "批准"
- Pending Requests 计数：使用 i18n `t('pairingRequests.pending')` → 英文 "Pending Requests" / 中文 "待处理请求"
- Clear 按钮：使用 i18n `t('pairingRequests.clear')` → 英文 "Clear" / 中文 "清除"

### 3. i18n 文案设计

#### 英文 (en/settings.json)
```json
{
  "sessionRouting": {
    "title": "Session Routing",
    "workspace": "Workspace"
  },
  "pairingRequests": {
    "title": "Pairing Requests",
    "enterCode": "Enter 6-digit code",
    "approve": "Approve",
    "pending": "Pending Requests",
    "clear": "Clear"
  }
}
```

#### 中文 (zh-CN/settings.json)
```json
{
  "sessionRouting": {
    "title": "Session Routing",
    "workspace": "工作区"
  },
  "pairingRequests": {
    "title": "配对请求",
    "enterCode": "输入6位验证码",
    "approve": "批准",
    "pending": "待处理请求",
    "clear": "清除"
  }
}
```

### 4. ImSettingsPane.tsx 重构

**当前结构（约 80 行重复代码 × 2 渠道）：**
```tsx
// 微信 Session Routing (789-824行)
<div className="border ...">
  <span>Session Routing</span>
  <div className="grid grid-cols-3 gap-4">
    <SettingSelect ... wxWorkspaceId ... />
    <SettingSelect ... wxAgentProfileId ... />
    <SettingSelectWithSearch ... wxModelId ... />
  </div>
</div>

// 飞书 Session Routing (1022-1059行) - 重复代码
<div className="border ...">
  <span>Session Routing Configuration</span>
  <div className="grid grid-cols-3 gap-4">
    <SettingSelect ... larkWorkspaceId ... />
    <SettingSelect ... larkAgentProfileId ... />
    <SettingSelectWithSearch ... larkModelId ... />
  </div>
</div>
```

**重构后结构：**
```tsx
// 微信 Session Routing
<ChannelSessionRouting
  workspaceId={wxWorkspaceId}
  agentProfileId={wxAgentProfileId}
  modelId={wxModelId}
  availableModels={wxAvailableModels}
  workspaces={workspaces}
  agents={agents}
  onUpdateConfig={handleUpdateWeixinConfig}
/>

// 飞书 Session Routing
<ChannelSessionRouting
  workspaceId={larkWorkspaceId}
  agentProfileId={larkAgentProfileId}
  modelId={larkModelId}
  availableModels={larkAvailableModels}
  workspaces={workspaces}
  agents={agents}
  onUpdateConfig={handleUpdateLarkConfig}
/>
```

Pairing Requests 同理重构。

## 实现步骤

### Step 1: 创建 ChannelSessionRouting 组件
- 新建 `src/components/settings/ChannelSessionRouting.tsx`
- 实现 Props 接口
- 使用 `useTranslation('settings')` 获取翻译函数
- 渲染标题和三个下拉框
- 标题使用 `t('sessionRouting.title')`
- Workspace label 使用 `t('sessionRouting.workspace')`
- Agent 和 Model label 硬编码 "Agent" 和 "Model"

### Step 2: 创建 ChannelPairingRequests 组件
- 新建 `src/components/settings/ChannelPairingRequests.tsx`
- 实现 Props 接口
- 使用 `useTranslation('settings')` 获取翻译函数
- 渲染标题、输入框、按钮和待处理列表
- 所有文案使用 i18n key

### Step 3: 更新 i18n 文件
- 在 `src/locales/en/settings.json` 添加 `sessionRouting` 和 `pairingRequests` 节点
- 在 `src/locales/zh-CN/settings.json` 添加对应中文翻译

### Step 4: 重构 ImSettingsPane.tsx
- 导入新组件
- 删除微信 Session Routing 区域代码（788-824行）
- 删除飞书 Session Routing 区域代码（1021-1060行）
- 替换为 `<ChannelSessionRouting />` 组件调用
- 删除微信 Pairing Requests 区域代码（826-907行）
- 删除飞书 Pairing Requests 区域代码（1062-1143行）
- 替换为 `<ChannelPairingRequests />` 组件调用

## 验证方案

1. **编译检查**：运行 `npm run build` 确保 TypeScript 类型检查通过
2. **UI 验证**：
   - 打开设置页面 → 消息渠道 → WeChat Bot
   - 确认 Session Routing 区域显示正常，标题为 "Session Routing"，Workspace label 根据语言显示
   - 确认 Pairing Requests 区域在有数据时显示正常
   - 切换到 Lark Bot 标签，确认显示一致
3. **i18n 验证**：
   - 切换语言到中文，确认 "Workspace" → "工作区"，"Pairing Requests" → "配对请求"
   - 切换语言到英文，确认显示英文文案
4. **功能验证**：
   - 修改 Session Routing 配置，确认能正常保存到后端
   - 修改 Agent 时能正确加载对应的 Model 列表
