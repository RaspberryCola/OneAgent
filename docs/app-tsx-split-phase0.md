# `App.tsx` 拆分 Phase 0 落地基线

## 目标

Phase 0 只做“结构和约束”，不改业务行为。

交付物包含两类：

- 目录骨架：给后续 Phase 1-5 提供稳定落点
- 依赖约束：避免拆分后再次耦合回 `App.tsx`

## 目录骨架（已创建）

```text
src/
├── screens/
│   ├── app/
│   ├── home/
│   └── conversation/
└── components/
    ├── composer/
    ├── sidebar/
    ├── workspace/
    ├── settings/
    ├── search/
    └── timeline/
```

说明：当前目录内仅放 `.gitkeep` 占位文件，用于先建立边界与落点。

## 依赖方向约束

统一依赖方向：

`view/components -> screens/container -> hooks/store -> lib/backend -> Tauri invoke`

### 允许依赖

- `screens/*` 可以依赖 `components/*`、`hooks/*`、`lib/*`
- `hooks/*` 可以依赖 `lib/*`
- `components/*` 可以依赖 `hooks/*`（仅通用交互 hook）与 `lib/utils/*`

### 禁止依赖

- `components/*` 反向依赖 `screens/*`
- `components/*` 直接调用 `src/lib/backend/*`
- 展示组件直接调用 `invoke`
- 同一展示组件同时使用“父级 props + 全局 store”作为同一数据源

### Store 使用约束

- 页面容器（`screens/*`）可直接读取 `useAppStore`
- 展示组件默认通过 props 驱动
- 只有跨域复用且必要时，才允许组件直接读 store，且需在 PR 描述说明原因

## Phase 0 验收标准

满足以下条件才视为完成：

1. 目录骨架创建完成，后续拆分有明确落点
2. 约束文档可用于 code review，团队可据此判定依赖是否合法
3. 业务行为零变化（本阶段不改功能代码）
4. 前端基础回归通过：
   - `npm run build`
   - `npm run test:run`

## 后续 PR 统一检查项

后续 Phase 1-5 的每个 PR，至少包含以下信息：

1. 变更属于哪个 phase 与子目标
2. 新增/迁移文件是否符合本文件依赖约束
3. 手工回归点（最少）：
   - 首页与会话页切换
   - 发送/停止
   - 滚动吸底
   - 搜索弹层打开与 ESC 关闭
   - 设置弹窗打开/切换/关闭
4. 命令回归结果：
   - `npm run build`
   - `npm run test:run`
