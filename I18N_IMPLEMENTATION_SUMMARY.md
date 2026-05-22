# OneAgent 多语言支持 (i18n) 实现总结

## 已完成的工作

### 1. 核心基础设施 ✅

#### 依赖安装
- ✅ `i18next` - 核心 i18n 引擎
- ✅ `react-i18next` - React 绑定
- ✅ `i18next-browser-languagedetector` - 浏览器语言检测

#### 配置文件
- ✅ `src/i18n/index.ts` - i18n 配置和初始化
  - 支持英文(en)和中文(zh)
  - 默认语言: 英文
  - 自动检测浏览器语言
  - 语言偏好持久化到 localStorage

#### 翻译文件结构
```
src/locales/
├── en/ (9个文件)
│   ├── common.json      - 共享字符串 (~40 keys)
│   ├── login.json       - 登录界面 (~8 keys)
│   ├── sidebar.json     - 侧边栏 (~15 keys)
│   ├── settings.json    - 设置面板 (~35 keys)
│   ├── composer.json    - 消息输入 (~20 keys)
│   ├── search.json      - 搜索覆盖层 (~12 keys)
│   ├── chat.json        - 聊天组件 (~45 keys)
│   ├── workspace.json   - 工作区面板 (~15 keys)
│   └── timeline.json    - 时间线消息 (~10 keys)
└── zh-CN/ (9个文件, 与 en 相同结构)
```

**总计**: 约 200 个翻译键 (中英文各一套)

#### 初始化
- ✅ `src/main.tsx` - 添加 i18n 初始化导入

### 2. 已迁移的组件 ✅

#### 登录界面
- ✅ `src/screens/LoginScreen.tsx`
  - 所有文本使用 `useTranslation('login')`
  - 包括错误消息、按钮文本、占位符等

#### 设置对话框
- ✅ `src/components/settings/SettingsDialog.tsx`
  - 标题和标签页名称已翻译
  - 关闭按钮已翻译

#### 常规设置面板 (含语言切换器)
- ✅ `src/components/settings/GeneralSettingsPane.tsx`
  - 添加了语言切换 UI (English / 中文 按钮)
  - 切换语言自动保存偏好设置
  - 显示设置已翻译

#### 首页 (HomeScreen)
- ✅ `src/screens/home/HomeScreen.tsx`
  - 代理不可用提示已翻译

#### 消息输入框 (Composer)
- ✅ `src/components/composer/Composer.tsx`
  - 占位符文本: "Message..." / "Message Agent..."
  - 拖放提示: "Drop files to attach"
  - 附件按钮和工具提示
  - 图片模式切换: "Read Images" / "As Files"
  - 图片处理说明和提示

### 3. 验证 ✅
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 检查通过
- ✅ Vite 生产构建完成

## 尚未迁移的组件

以下组件仍需要迁移以使用翻译 (约 25+ 个文件):

### 优先级高 (用户最常看到)
1. `src/App.tsx` - 主应用组件 (~30个字符串)
2. `src/components/sidebar/WorkspaceSidebar.tsx` - 侧边栏
3. `src/components/search/SearchOverlay.tsx` - 搜索
4. `src/components/chat/PermissionDisplay.tsx` - 权限显示
5. `src/components/chat/ToolCallDisplay.tsx` - 工具调用显示
6. `src/components/timeline/MessageBubble.tsx` - 消息气泡

### 优先级中
8. `src/components/sidebar/WorkspaceConversationGroup.tsx`
9. `src/components/settings/AgentSettingsPane.tsx`
10. `src/components/settings/McpSettingsPane.tsx`
11. `src/components/settings/ImSettingsPane.tsx` (41.8KB, 大文件)
12. `src/components/composer/ModelSelectorMenu.tsx`
13. `src/components/composer/ModeSelectorMenu.tsx`
14. `src/components/workspace/WorkspacePanel.tsx`
15. `src/components/terminal/TerminalPanel.tsx`

### 优先级低
16. `src/components/workspace/WorkspaceDropdown.tsx`
17. `src/components/workspace/DiffPanel.tsx`
18. `src/components/ui/CollapsibleContent.tsx`
19. `src/screens/home/HomeScreen.tsx`
20. `src/screens/conversation/ConversationScreen.tsx`
21. `src/screens/app/AppShell.tsx`
22. 其他小组件...

## 迁移模式

每个组件的迁移遵循以下模式:

```typescript
// 1. 添加导入
import { useTranslation } from 'react-i18next';

// 2. 在组件中使用
function MyComponent() {
  const { t } = useTranslation('namespace');

  return (
    <div>
      {/* 3. 替换硬编码字符串 */}
      <h1>{t('settings.title')}</h1>
      <button>{t('common.close')}</button>

      {/* 4. 动态字符串使用插值 */}
      <span>{t('common.terminal', { number: 2 })}</span>

      {/* 5. 复数化 */}
      <span>{t('search.resultsCount', { count: 5 })}</span>
    </div>
  );
}
```

## 语言切换功能

### 位置
设置 > 常规 (`src/components/settings/GeneralSettingsPane.tsx`)

### 使用方式
1. 打开设置对话框
2. 选择"常规"标签页
3. 点击 "English" 或 "中文" 按钮切换语言
4. 偏好自动保存到 localStorage

### 持久化
- 语言偏好保存在 `localStorage` 的 `oneagent:language` 键中
- 应用启动时自动读取并应用
- 默认为英文 (如果未设置)

## 下一步工作

### 方案 1: 逐个手动迁移
按照上面的优先级列表,逐个组件迁移并测试。

### 方案 2: 使用脚本辅助
可以编写脚本:
1. 扫描所有 `.tsx` 文件中的硬编码字符串
2. 生成翻译键映射
3. 自动替换为 `t()` 调用

### 验证测试
迁移完成后需要:
1. 运行 `npm run test:run` 确保测试通过
2. 手动测试两种语言的完整功能
3. 验证语言切换和持久化
4. 检查所有动态字符串(插值、复数化)

## 技术细节

### i18n 配置亮点
- 不使用 Suspense (避免加载闪烁)
- 支持插值 (`{{variable}}`)
- 支持复数化 (`_one`, `_other`)
- 手动控制 localStorage 持久化
- 语言变化时自动保存

### 翻译文件组织
- 按功能模块分 namespace
- 使用点分层级命名 (`settings.tabs.general`)
- 共享字符串放在 `common.json`
- 避免重复翻译键

## 当前状态

**核心框架已就绪,主要组件已迁移,构建通过,可以开始使用。**

用户可以:
1. 启动应用,查看英文界面
2. 进入设置 > 常规,切换为中文
3. 刷新页面,验证语言偏好持久化
4. 查看已迁移组件的中英文翻译:
   - 登录界面
   - 设置对话框
   - 常规设置(含语言切换器)
   - 首页(代理不可用提示)
   - 消息输入框(占位符、拖放提示、图片模式等)

**剩余约 15 个组件需要迁移以完成全部界面的多语言支持。**
