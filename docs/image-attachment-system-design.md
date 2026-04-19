# OneAgent 图片与附件系统设计

## 1. 文档目的

本文档定义 OneAgent 图片与附件系统的产品语义、前后端数据结构、发送策略和实施顺序。

目标不是一次性解决所有文档理解和多模态问题，而是先建立一套稳定、可扩展、可降级的附件基础设施，满足以下需求：

- 支持图片、音频和通用文件上传
- 支持拖拽、粘贴、文件选择三种输入方式
- 能根据 Agent / 模型能力选择合适的投递方式
- 能表达“图片是给模型看”与“图片只是一个文件资源”这两种不同意图
- 对 PDF、PPTX、DOCX、XLSX 等二进制文件提供统一且稳定的处理方式
- 为未来的 OCR、文档解析、索引检索、预处理流水线保留接口

本文档是阶段性设计文档，不替代长期后端架构规范。

## 2. 当前实现现状

当前代码库已经具备附件系统的基础形态，不是从零开始：

- 前端已支持文件选择、拖拽、粘贴三种接入方式
- 前端会根据 `prompt_capabilities` 计算附件的发送模式
- 后端 ACP prompt codec 已支持 `image`、`audio`、`resource`、`resource_link` 四种结构化投递
- 用户消息时间线已能展示附件元信息

现有关键实现：

- `src/hooks/useAttachmentHandler.ts`
- `src/hooks/useConversationComposer.ts`
- `src/components/composer/Composer.tsx`
- `src-tauri/src/agent_adapters/acp/prompt_codec.rs`
- `src-tauri/src/agent_adapters/acp/parser.rs`

当前能力判断大致如下：

- 图片 + Agent 支持 `image` => 作为图片发送
- 音频 + Agent 支持 `audio` => 作为音频发送
- 文本类小文件 + Agent 支持 `embedded_context` => 作为嵌入文本发送
- 其他情况如果支持 `resource_link` => 作为文件引用发送
- 都不支持 => 阻止发送

这套逻辑解决了“如何按 capability 分发”，但还没有解决“图片到底是视觉输入还是普通附件资源”这一层语义问题。

## 3. 核心问题定义

### 3.1 图片存在两种不同语义

图片附件至少有两类语义：

- `vision input`
  - 用户希望 Agent / 模型直接读取图片内容
  - 例如：识别截图报错、描述 UI、OCR、分析图表、比较两张图
- `file resource`
  - 用户只是把图片作为一个文件资源交给 Agent
  - 例如：裁切图片、压缩图片、改格式、移动到某个目录、提交到仓库

这两类语义不能只靠 MIME type 推断。

“这是 image/png” 只能说明文件类型，不能说明用户是要模型“看图”，还是要工具“操作文件”。

### 3.2 当前系统把“图片类型”和“使用意图”混在了一起

如果仅根据 `attachment.kind === image` 和 Agent 是否支持 `image` 决定发送方式，会出现以下问题：

- 用户上传图片只是为了让 Agent 调工具裁切，但系统误把它当成视觉输入
- 不支持视觉的 Agent 可能本来仍然可以通过路径或资源引用很好地完成文件操作，但系统把它视为能力不足
- 前端无法向用户解释“为什么同样是图片，这次走视觉输入，那次走文件引用”

### 3.3 二进制文件不适合直接走嵌入文本

PDF、PPTX、DOCX、XLSX 等附件具有以下特征：

- 常为二进制格式
- 文件体积通常较大
- 读取往往依赖工具链，不适合直接塞进 prompt
- 即便模型支持附件，真正可执行的工作通常仍依赖外部工具

因此它们在 v1 中应优先被视为“文件资源”，而不是“可嵌入上下文”。

## 4. 设计原则

### 4.1 类型与意图分离

附件系统必须同时表达两个维度：

- 文件类型：`image | audio | file`
- 使用意图：`auto | vision_input | file_resource`

禁止把“图片文件”直接等价为“视觉输入”。

### 4.2 最终投递方式晚绑定

前端和后端不应在附件进入系统的瞬间就把它永久定死为某一种协议形态。

更合理的流程是：

1. 用户上传附件
2. 系统记录附件元数据和使用意图
3. 发送前结合 Agent capability 计算最终 delivery plan
4. adapter / runtime 负责把 plan 编码成协议块

### 4.3 优先使用结构化附件，不污染正文

只要协议或 adapter 支持结构化附件，应优先使用结构化内容块：

- `image`
- `audio`
- `resource`
- `resource_link`

不建议默认把路径字符串直接拼进用户输入文本，原因如下：

- 增加噪声
- 让正文语义不纯
- 同一附件信息在结构化块和正文里重复
- 后续难以扩展为 richer metadata

只有在某些非结构化 adapter 的兼容模式下，才允许回退到“路径提示文本”。

### 4.4 二进制附件优先视为资源引用

PDF、PPTX、DOCX、XLSX、ZIP、图片文件在 `file_resource` 场景下，默认优先走 `resource_link`。

这既符合工具调用场景，也更稳定。

### 4.5 降级必须可解释

当 Agent 不支持视觉输入、音频输入或嵌入上下文时，系统必须能清晰解释降级原因：

- “Agent 不支持图片视觉输入，已改为文件引用”
- “该文件不是文本类文件，无法作为 embedded context，已改为文件引用”
- “当前 Agent 不支持任何兼容附件模式，因此本次附件不可发送”

## 5. 推荐方案

### 5.1 总体结论

推荐方案不是简单采用“总是粘路径”或“支持图片就发图片”。

推荐采用：

- 区分 capability
- 区分附件使用意图
- 默认走结构化附件
- 对不支持的能力做稳定降级
- 仅在兼容场景下回退为文本路径提示

这本质上是“按意图 + 按能力决定投递方式”的方案。

### 5.2 不推荐的方案

#### 方案 A：不区分能力，统一粘贴路径

不推荐。

问题：

- 丢失多模态 Agent 的价值
- 图片理解、音频理解、文本小文件嵌入都失效
- 系统对 ACP 已支持的结构化附件能力利用不足

#### 方案 B：区分是否支持图片，支持就发图片，不支持就粘路径

方向基本正确，但不完整。

问题：

- 没有表达“图片只是文件资源”的场景
- 把“图片类型”和“视觉输入意图”耦合了

#### 方案 C：区分是否支持图片，但始终再附一个路径

不作为默认策略。

问题：

- 信息重复
- 增加 prompt 噪声
- ACP `image` block 本身已经可携带 `uri`
- 将来如果支持 richer attachment metadata，这种正文注入方式会越来越难维护

## 6. 数据模型设计

### 6.1 前端本地附件状态

建议在现有 `LocalAttachment` 基础上新增使用意图和解析结果：

```ts
type AttachmentUsageIntent = 'auto' | 'vision_input' | 'file_resource';

type LocalAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: 'image' | 'audio' | 'file';
  size: number;
  source: 'picker' | 'drag' | 'paste';
  previewUrl?: string;
  usageIntent: AttachmentUsageIntent;
};
```

### 6.2 发送到后端的附件输入

建议扩展后端 `AttachmentInput`：

```ts
type AttachmentDeliveryPreference =
  | 'auto'
  | 'embedded'
  | 'resource_link';

type AttachmentUsageIntent =
  | 'auto'
  | 'vision_input'
  | 'file_resource';

type AttachmentInput = {
  id: string;
  name: string;
  path: string;
  mime_type?: string | null;
  kind: 'image' | 'audio' | 'file';
  usage_intent: AttachmentUsageIntent;
  delivery_preference: AttachmentDeliveryPreference;
};
```

其中：

- `usage_intent` 表达用户语义
- `delivery_preference` 表达当前解析后的首选传输方式

二者不能互相替代。

### 6.3 解析结果模型

建议前端内部维护一个更明确的 resolution：

```ts
type AttachmentResolutionMode =
  | 'image'
  | 'audio'
  | 'resource'
  | 'resource_link'
  | 'fallback_text_path'
  | 'blocked'
  | 'probing';
```

其中 `fallback_text_path` 不是常规模式，只为后续兼容型 adapter 预留。

## 7. 发送策略设计

### 7.1 图片附件

#### `usage_intent = vision_input`

- Agent 支持 `image`
  - 优先发送 `image` block
- Agent 不支持 `image`，但支持 `resource_link`
  - 降级为 `resource_link`
- 两者都不支持
  - 阻止发送

#### `usage_intent = file_resource`

- 优先发送 `resource_link`
- 即使 Agent 支持 `image`，也不默认发送视觉输入
- 如果不支持 `resource_link`
  - 阻止发送或进入兼容回退路径

#### `usage_intent = auto`

v1 建议规则：

- 图片默认解析为：
  - 如果 Agent 支持 `image` => 优先 `image`
  - 否则如果支持 `resource_link` => `resource_link`
  - 否则 blocked

同时 UI 允许用户手动切换为“仅作为附件”。

说明：

- `auto` 是便捷模式，不应掩盖用户显式选择
- 未来可根据消息文本和工具上下文优化 `auto` 推断，但不应在 v1 引入隐式黑箱逻辑

### 7.2 音频附件

规则与图片类似：

- `usage_intent = auto`
  - 支持 `audio` => `audio`
  - 否则支持 `resource_link` => `resource_link`
- `usage_intent = file_resource`
  - 始终优先 `resource_link`

### 7.3 文本类文件

对于：

- `text/*`
- `json`
- `yaml`
- `xml`
- `js/ts`
- `sh`

规则如下：

- 支持 `embedded_context` 且体积在阈值内 => `resource`
- 否则支持 `resource_link` => `resource_link`
- 否则 blocked

### 7.4 二进制文件

对于：

- `pdf`
- `pptx`
- `docx`
- `xlsx`
- `zip`
- 非文本类二进制

v1 规则：

- 始终优先 `resource_link`
- 不尝试 embedded context

未来如果引入专门的预处理流水线，再通过额外 capability 或 preprocessing step 决定是否生成结构化摘要。

## 8. UI / 交互设计

### 8.1 输入方式

系统需要稳定支持三种上传入口：

- 文件选择
- 拖拽上传
- 粘贴上传

当前已具备基础实现，但需要补齐体验层：

- 拖拽悬浮高亮态
- 上传中状态
- 单文件失败提示
- 文件体积超限提示
- 重复文件去重
- 支持 `accept` 过滤

### 8.2 图片附件的意图切换

对于图片附件，建议在预览卡片上提供轻量切换：

- `让 Agent 看图`
- `仅作为附件`

也可以用更中性的文案：

- `读取图片内容`
- `作为文件处理`

默认：

- 图片为 `auto`
- 用户切换后转为显式意图

### 8.3 附件-only 发送

系统必须允许“无正文，仅附件”发送。

当前前后端都要求 `text.trim()` 非空，这会阻断如下场景：

- “帮我裁切这张图”
- “请读取这个 PDF”
- “分析这个日志文件”

改造建议：

- 前端发送条件改为：
  - `input.trim().length > 0 || attachments.length > 0`
- 后端校验改为：
  - 文本和附件不能同时为空

### 8.4 提示文案

附件预览区应能向用户明确展示最终行为，例如：

- `将作为图片发送`
- `将作为文件引用发送`
- `Agent 不支持读图，已降级为文件引用`
- `当前 Agent 不支持兼容附件模式`

## 9. Runtime / Adapter 设计

### 9.1 Frontend 负责意图表达，Adapter 负责协议编码

职责边界建议如下：

- 前端
  - 收集文件
  - 记录附件元数据
  - 记录用户使用意图
  - 基于 capability 做初步 resolution 和文案提示
- runtime / adapter
  - 依据 `kind + usage_intent + delivery_preference + capability` 生成最终协议块
  - 在必要时执行安全降级

### 9.2 ACP adapter 的目标行为

ACP 路径下优先输出：

- `type = "image"`
- `type = "audio"`
- `type = "resource"`
- `type = "resource_link"`

不主动向用户正文注入文件路径。

### 9.3 Compat adapter 预留策略

对于未来非 ACP、但只支持纯文本 prompt 的 adapter，允许定义兼容型回退：

- 把附件路径以受控模板拼接到正文尾部
- 模板应统一，不允许前端自由拼接

例如：

```text
[Attached file]
name: report.pdf
path: /abs/path/report.pdf
mime_type: application/pdf
```

该逻辑应封装在 adapter 内，而不是 UI 层。

## 10. Capability 策略

### 10.1 Probe 时机

当前前端在未拿到 capability 时会阻止添加附件，这个策略过硬。

建议调整为：

- 允许先添加附件
- capability 未就绪时显示 `probing`
- 在发送前强制 resolve

这样用户不会因为 Agent 还没 probe 完就被阻断上传操作。

### 10.2 默认能力回退

当 capability 缺失时，不应盲目假设支持视觉或音频。

建议默认回退：

- `text = true`
- `resource_link = true`
- `embedded_context = false`
- `image = false`
- `audio = false`

这与当前 runtime fallback 行为一致，能保证保守且可解释。

## 11. 实施顺序

### Phase 1：语义补全

目标：

- 补齐“图片既可能是视觉输入，也可能是文件资源”的语义

改动：

- 前端 `LocalAttachment` 增加 `usageIntent`
- 前后端 `AttachmentInput` 增加 `usage_intent`
- 调整 resolution 逻辑
- 附件预览展示更明确的状态文案

### Phase 2：交互补全

目标：

- 补齐上传体验和附件-only 发送

改动：

- 支持附件-only 发送
- 增加拖拽高亮、失败提示、去重、体积校验
- 图片附件增加意图切换 UI

### Phase 3：兼容与降级

目标：

- 为未来非 ACP adapter 做好兼容

改动：

- 引入 `fallback_text_path` 兼容路径
- 明确 adapter 侧路径注入模板
- 为 richer document preprocessing 预留入口

## 12. 非目标

以下内容不属于本阶段目标：

- 自动解析 PDF 全文
- 自动把 PPTX / DOCX 转 markdown
- 自动 OCR 图片并生成文本摘要
- 语义级附件检索系统
- 向量索引和文档问答流水线
- 远程对象存储上传

这些能力后续可以建立在本设计之上，但不应混入 v1 附件基础协议。

## 13. 最终决策

本阶段采用以下决策：

- 保留 capability-aware 的附件解析策略
- 为图片和音频引入“使用意图”语义层
- 图片不默认等同于视觉输入
- PDF / PPTX / DOCX / XLSX 等二进制文件默认走 `resource_link`
- 默认优先结构化附件，不把路径拼进用户正文
- 允许附件-only 发送
- 上传入口统一支持文件选择、拖拽、粘贴
- capability 未完成 probe 时允许先上传，发送前再 resolve

这套方案能同时覆盖：

- 多模态理解
- 文件操作
- 稳定降级
- 未来扩展

并且与当前 ACP 结构化附件实现方向保持一致。
