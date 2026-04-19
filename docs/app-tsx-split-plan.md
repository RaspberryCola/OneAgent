# `src/App.tsx` 拆分实施方案

## 背景

当前 `src/App.tsx` 约 `2145` 行，已经同时承担以下职责：

- 应用壳层与三栏布局
- 会话页和首页的路由式切换
- 多个本地 UI 状态管理
- 与 `useAppStore`、`API.listPermissions`、多个 hooks 的业务编排
- 工作区侧边栏、文件树、设置弹窗、搜索弹层、消息流、输入区的渲染
- 若干工具函数与多个内联子组件

这不是单纯的“文件太长”问题，而是职责边界失真。继续在这个文件上叠加功能，会让以下工作越来越困难：

- 新功能插入时难以判断应该落在哪一层
- 小改动容易影响首页、会话页、设置、搜索等无关区域
- 组件测试粒度过粗，只能靠整页回归
- Tauri 前端与 Rust 后端的边界会继续被 UI 层稀释

## 现状诊断

按职责看，`App.tsx` 当前大致可分成 5 个区域：

1. 应用状态编排层：`src/App.tsx:265-632`
2. 左侧工作区与会话侧边栏：`src/App.tsx:714-894`
3. 主内容区：首页 / 会话页 / 输入区：`src/App.tsx:896-1174`
4. 右侧文件树与设置弹窗：`src/App.tsx:1176-1425`
5. 内联视图组件与渲染单元：`src/App.tsx:1430-2145`

其中最明显的问题不是长度，而是“编排逻辑”和“展示组件”混在一起：

- `Composer`、`SidebarItem`、`SearchOverlay`、`TimelineMessage`、`Message` 都是完整组件，但仍留在入口文件中
- `renderWorkspaceEntries` 是递归渲染逻辑，已经形成独立组件雏形
- `permissionDecisions` 拉取、`permissionRequestMeta` 推导、`handleSend` 组装发送 payload，属于会话编排，不应和布局 JSX 紧耦合
- `SearchOverlay` 内部再次直接读取 `useAppStore()`，说明数据依赖路径已经开始分叉

## 拆分目标

这次拆分的目标不是把 1 个文件切成 20 个文件，而是建立长期可维护的边界。

目标如下：

- `App.tsx` 只保留应用级壳层装配，不再承载大块业务 JSX
- 让“页面容器”和“展示组件”分层，形成稳定依赖方向
- 保持 Tauri 前端边界清晰：UI 不直接感知 `invoke` 细节，Tauri 交互继续收敛在 `lib/backend`、store、hooks
- 提高回归效率：每个子域可以单独测试、单独重构、单独演进
- 保持当前交互不变，不为拆分而重写业务

## 非目标

以下内容本次不建议同时进行：

- 不引入 React Router。当前只有首页 / 会话页切换，还不到需要路由层的复杂度
- 不把所有 `useState` 都迁移进 Zustand。局部 UI 状态继续本地化更合适
- 不改造现有 Tauri 命令层接口命名
- 不同步做视觉重设计
- 不拆成按单个 icon、单个按钮粒度的过度组件化

## 设计原则

### 1. React 侧分层原则

- `App.tsx` 只做壳层装配
- `screens/` 负责页面级容器和页面编排
- `components/` 负责可复用展示组件
- `hooks/` 负责可复用交互逻辑，不承担大面积页面编排
- `lib/` 保持纯函数、后端桥接、store、常量

### 2. Tauri 侧边界原则

前端拆分后，依赖方向必须保持：

`view -> screen/container -> hooks/store -> lib/backend -> Tauri invoke`

约束如下：

- 展示组件不要直接 `invoke`
- 展示组件不要感知 Tauri 特有输入输出类型细节，尽量由容器做适配
- 页面容器可以读 store，也可以组合 hooks
- 真正的桌面能力、文件系统能力、会话命令能力，继续留在 `src/lib/backend/*`

这符合 Tauri 桌面应用常见约束：前端负责用户意图和状态反馈，系统能力通过明确桥接层暴露，而不是散落在 UI 组件中。

### 3. 组件拆分阈值

满足任一条件就应拆出：

- 超过 150-200 行且仍在增长
- 同时依赖 3 组以上状态源
- 既处理数据推导，又承载大块 JSX
- 同一组件可在首页 / 会话页 / 弹层中复用
- 需要单独测试交互行为

### 4. 不过度拆分原则

以下情况暂时不要单独拆：

- 只被一处使用、且逻辑非常薄的纯样式片段
- 为了“每个文件不超过 100 行”而切出的无意义包装组件
- 不形成明确语义边界的 `Section` / `Wrapper` / `Block` 类组件

## 建议目标结构

建议在现有 `src/components`、`src/hooks` 基础上扩展，不另起一套新体系：

```text
src/
├── App.tsx
├── screens/
│   ├── app/
│   │   ├── AppShell.tsx
│   │   ├── AppHeader.tsx
│   │   └── AppNoticeToast.tsx
│   ├── home/
│   │   ├── HomeScreen.tsx
│   │   ├── AgentPicker.tsx
│   │   └── HomeComposerPanel.tsx
│   └── conversation/
│       ├── ConversationScreen.tsx
│       ├── ConversationTimeline.tsx
│       ├── PendingPermissionsBar.tsx
│       └── ConversationComposerDock.tsx
├── components/
│   ├── composer/
│   │   ├── Composer.tsx
│   │   ├── AttachmentPreviewList.tsx
│   │   ├── ModelSelectorMenu.tsx
│   │   └── ModeSelectorMenu.tsx
│   ├── sidebar/
│   │   ├── WorkspaceSidebar.tsx
│   │   ├── WorkspaceConversationGroup.tsx
│   │   └── SidebarConversationItem.tsx
│   ├── workspace/
│   │   ├── WorkspacePanel.tsx
│   │   ├── WorkspaceFileTree.tsx
│   │   └── WorkspaceFileTreeNode.tsx
│   ├── settings/
│   │   ├── SettingsDialog.tsx
│   │   ├── GeneralSettingsPane.tsx
│   │   ├── AgentSettingsPane.tsx
│   │   └── McpSettingsPane.tsx
│   ├── search/
│   │   └── SearchOverlay.tsx
│   └── timeline/
│       ├── TimelineMessage.tsx
│       ├── MessageBubble.tsx
│       ├── PlanMessage.tsx
│       ├── StatusMessage.tsx
│       └── ErrorMessage.tsx
├── hooks/
│   ├── useAppShellState.ts
│   ├── useConversationComposer.ts
│   └── ...
└── lib/
    └── ...
```

## 模块职责定义

### `App.tsx`

保留内容：

- 初始化顶层容器
- 连接 `useAppStore`
- 组装 `AppShell`
- 挂载全局覆盖层

不再保留：

- 大段内联 JSX
- 内联页面组件定义
- 复杂列表渲染函数

理想状态下，`App.tsx` 应收敛到 `150-300` 行。

### `screens/app/AppShell.tsx`

职责：

- 负责三栏布局和显示条件
- 接收左侧边栏、主内容区、右侧面板、弹层插槽
- 不处理业务数据来源

意义：

- 把“桌面应用壳层布局”从具体业务中解耦
- 便于未来适配更多桌面窗口态变化

### `screens/home/HomeScreen.tsx`

职责：

- 负责无 active conversation 时的首页视图
- 管理 agent 选择区、workspace dropdown、首页 composer 排布

不负责：

- 会话发送 payload 组装细节
- 搜索弹层与设置弹层状态

### `screens/conversation/ConversationScreen.tsx`

职责：

- 负责 active conversation 下的主会话页
- 组合时间线、待处理权限、吸底输入区、滚动按钮

这部分是后续增长最快的区域，应尽早独立，否则未来新功能还会继续堆回 `App.tsx`。

### `components/composer/*`

当前 `Composer` 已经是完整独立组件，但过重，建议再向下拆成：

- `Composer.tsx`：容器壳层
- `AttachmentPreviewList.tsx`：附件展示
- `ModelSelectorMenu.tsx`：模型选择
- `ModeSelectorMenu.tsx`：模式选择

原因：

- 当前 `Composer` 同时承担输入、菜单、附件、发送控制，职责过多
- 这块未来很可能继续演进，例如快捷指令、拖拽反馈、输入历史、草稿恢复

但不要把发送按钮、附件单项卡片拆成过细原子组件，保持语义级拆分即可。

### `components/sidebar/*`

建议把左侧区域拆成：

- `WorkspaceSidebar`
- `WorkspaceConversationGroup`
- `SidebarConversationItem`

这样可以把“多工作区 + 会话树”的逻辑与主内容区分离，后续若增加 workspace pin、排序、最近项、右键菜单，不会反向污染 `App.tsx`。

### `components/workspace/*`

当前右侧文件树的递归渲染逻辑已经足够独立，建议拆成：

- `WorkspacePanel`
- `WorkspaceFileTree`
- `WorkspaceFileTreeNode`

特别是 `renderWorkspaceEntries` 必须从 `App.tsx` 移出，否则递归节点交互会始终绑在入口文件里。

### `components/settings/*`

设置弹窗建议拆成 1 个对话框容器 + 3 个 tab pane：

- `SettingsDialog`
- `GeneralSettingsPane`
- `AgentSettingsPane`
- `McpSettingsPane`

原因：

- 设置项天然按领域增长
- 未来 MCP 配置落地后，这一块会继续扩展
- 每个 pane 适合拥有自己的测试和状态映射

### `components/search/SearchOverlay.tsx`

应从 `App.tsx` 移出，并调整为：

- 由父容器显式传入 `agentProfiles`
- 不在内部再次直接读取 `useAppStore`

这样可以避免组件同时依赖 props 和全局 store，降低复用成本与测试复杂度。

### `components/timeline/*`

建议拆成：

- `TimelineMessage`
- `MessageBubble`
- `PlanMessage`
- `StatusMessage`
- `ErrorMessage`

这里的价值不只是减行数，而是把“消息类型分发”和“消息具体渲染”分开。未来如果新增 artifact、引用、代码块工具栏、消息级操作，这个边界会非常重要。

## 建议新增容器 Hook

当前页面编排逻辑最适合补一个容器 hook，而不是继续堆在 `App.tsx`。

### `useAppShellState`

建议托管这些纯 UI 状态：

- `isMobileSidebarOpen`
- `isDesktopSidebarOpen`
- `isSettingsOpen`
- `settingsTab`
- `pendingDeleteConversationId`
- `expandedWorkspaces`

目的：

- 把壳层 UI 状态与会话业务状态分开
- 避免 `App.tsx` 同时处理 store 状态和大量局部 UI 状态

### `useConversationComposer`

建议托管这些编排逻辑：

- `input`
- `composerNotice`
- `isSending`
- `canSend`
- `handleSend`
- `handleStop`
- `handleKeyDown`
- `resetComposer`
- `sessionConfigOverrides` 组装

这部分是当前最重的业务交汇点，适合收敛成单独 hook。  
但附件处理、模型选择、模式选择本身已有独立 hooks，不建议重复造轮子，应由该 hook 负责组合。

## 分阶段实施顺序

建议分 6 个阶段推进，每个阶段都可独立合并，不做大爆炸重构。

### Phase 0：建立目录与约束

内容：

- 新建 `screens/`、`components/composer`、`components/sidebar`、`components/workspace`、`components/settings`、`components/search`、`components/timeline`
- 在文档和代码评审中明确依赖方向
- 落地基线文档：`docs/app-tsx-split-phase0.md`

验收标准：

- 团队对目录职责有统一认知
- 后续提 PR 时知道功能该落在哪里
- `npm run build` 和 `npm run test:run` 通过（确认 Phase 0 不改变行为）

### Phase 1：先迁出纯展示组件

优先迁出这些低风险块：

- `SidebarItem`
- `PlanMessage`
- `StatusMessage`
- `ErrorMessage`
- `SearchOverlay`

原因：

- 输入依赖清晰
- 风险低
- 迁出后立刻降低 `App.tsx` 噪音

验收标准：

- `App.tsx` 不再定义这些子组件
- 行数显著下降
- 行为零变化

### Phase 2：迁出时间线渲染域

迁出：

- `TimelineMessage`
- `Message`
- 与时间线渲染相关的类型适配函数

可选补充：

- 把 `<think>` / `<thinking>` 清洗逻辑提到 `src/lib/utils/conversation.ts`

验收标准：

- 会话主区域只组合时间线组件
- 消息渲染逻辑不再留在入口文件

### Phase 3：迁出 `Composer`

迁出并拆分：

- `Composer`
- `AttachmentPreviewList`
- `ModelSelectorMenu`
- `ModeSelectorMenu`

这一步建议同时新增 `useConversationComposer`，把发送编排从 `App.tsx` 取走。

验收标准：

- `App.tsx` 不再直接处理发送 payload 组装
- 首页和会话页共用同一个 composer 容器接口

### Phase 4：迁出侧边栏和文件树

迁出：

- 左侧 `WorkspaceSidebar`
- 右侧 `WorkspacePanel`
- `WorkspaceFileTree` / `WorkspaceFileTreeNode`

同时把 `renderWorkspaceEntries` 替换为组件递归。

验收标准：

- `App.tsx` 不再包含递归节点渲染
- 工作区和会话列表的修改不影响主内容区实现

### Phase 5：迁出设置弹窗与首页 / 会话页屏幕

迁出：

- `SettingsDialog` 与各 pane
- `HomeScreen`
- `ConversationScreen`
- `AppShell`

到这个阶段，`App.tsx` 应主要剩下：

- store / hook 装配
- 屏幕切换
- 全局弹层挂载

验收标准：

- `App.tsx` 收敛为应用入口而非应用实现
- 页面级改动可以在 `screens/*` 完成

## 推荐提交策略

建议按以下 PR 顺序实施：

1. `refactor(frontend): extract app inline presentational components`
2. `refactor(frontend): extract timeline rendering from App`
3. `refactor(frontend): split composer and add conversation composer hook`
4. `refactor(frontend): extract workspace sidebar and file tree panels`
5. `refactor(frontend): extract settings dialog and screens`

这样每个 PR 都可控、可 review、可回滚。

## 依赖约束

为避免拆完又重新耦合，建议明确以下规则：

- `screens/*` 可以依赖 `components/*`、`hooks/*`、`lib/*`
- `components/*` 不能反向依赖 `screens/*`
- `components/*` 尽量通过 props 接收数据，不直接读全局 store
- 只有页面容器和少数跨域组件允许直接使用 `useAppStore`
- `components/*` 不直接调用 `src/lib/backend/commands.ts`

其中最关键的是最后两条。否则只是把大文件拆成一堆隐式耦合的小文件。

## 测试与回归建议

拆分过程中建议补以下测试，而不是只做人工点点看：

- `Composer` 发送 / 停止 / 禁用态测试
- `SearchOverlay` ESC 关闭与结果选择测试
- `WorkspaceFileTree` 递归展开测试
- `TimelineMessage` 不同 `message.kind` 分发测试
- `MessageBubble` 的 `<think>` 清洗与 copy 按钮显示规则测试

已有测试目录结构已经存在，建议保持：

- `src/components/**/__tests__/*`
- `src/hooks/**/__tests__/*`
- `src/lib/utils/__tests__/*`

## 风险点

### 1. 发送链路回归

`handleSend` 目前耦合了：

- 输入文本
- 附件 resolution
- 新建会话时的 model override
- mode override
- busy 状态

这是最高风险点。拆分时必须保证行为完全一致。

### 2. 滚动与吸底行为回归

当前滚动逻辑涉及：

- 流式输出时自动吸底
- 用户上滑后停止强制吸底
- `ResizeObserver` 触发二次同步

任何时间线或会话页拆分，都要把这部分当成独立验收点。

### 3. 局部状态位置失衡

如果拆分后把所有状态都丢进 `useAppStore`，会引入另一种长期问题：全局状态过载。  
所以这次拆分应坚持：

- 业务跨页面状态进 store
- 局部 UI 状态留在 screen / container hook

## 建议保留不拆的部分

当前这些工具函数可以先保留在 `App.tsx` 或逐步迁入 `lib/utils`，但不必作为第一阶段目标：

- `getAgentLogo`
- `getWorkspaceLabel`
- `formatDiscoveryNotice`
- `humanFileSize`
- `statusMeta`
- `formatBytes`
- `getLatestPermissionDecision`

建议策略：

- 先拆组件和页面边界
- 再根据复用度决定是否下沉到 `lib/utils`

不要在第一轮同时做“组件拆分 + 工具函数归并 + 类型抽象”，否则会把 review 难度拉高。

## 完成态标准

拆分完成后，理想状态应满足：

- `App.tsx` 聚焦入口装配，不再包含长段 JSX 与内联组件定义
- 首页、会话页、设置、搜索、侧边栏、文件树、输入区、时间线拥有清晰目录归属
- 展示组件大多通过 props 驱动，不直接耦合 Tauri 命令层
- 新增 MCP 配置、设置面板、消息类型、文件树交互时，都有明确落点

## 结论

这次拆分应以“页面容器化 + 组件域分治 + Tauri 边界清晰化”为目标，而不是按行数平均切块。

最优先顺序是：

1. 先迁出内联展示组件
2. 再迁出时间线与输入区
3. 再拆侧边栏、文件树、设置弹窗
4. 最后让 `App.tsx` 收敛成真正的应用入口

这样能在保持现有交互稳定的前提下，把 `src/App.tsx` 从“所有事情都做”的文件，改造成长期可维护的桌面前端入口。
