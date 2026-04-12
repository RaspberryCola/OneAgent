# 问题3：依赖开箱即用

## 问题描述

当前 Claude Code 的依赖是启动之后用到的时候才去装。用户认为这样不好，这个能力应该是开箱即用的。

## 当前状态分析

### 依赖加载机制

**关键文件：`src-tauri/src/capability_services/agent_launch.rs`**

1. **依赖加载策略** (lines 56-70)
   ```rust
   pub fn claude_bridge_availability() -> BridgeAvailability {
       // 1. 尝试 bundled adapter runtime（优先）
       if let Ok((_runtime, _adapter_entry, _working_dir)) = resolve_bundled_adapter_runtime() {
           return BridgeAvailability::Ready;
       }

       // 2. 回退到系统 bun/node
       if command_exists("bunx") || command_exists("bun") || command_exists("npx") {
           return BridgeAvailability::Degraded(
               "Bundled Claude adapter is unavailable; OneAgent will fall back to system bun/node."
           );
       }

       // 3. 完全不可用
       BridgeAvailability::Unavailable(
           "Claude Code requires the bundled adapter resources or a system bun/node runtime."
       )
   }
   ```

2. **NPM Adapter 启动流程** (lines 72-144)
   ```rust
   fn resolve_npm_adapter_launch(profile: &AgentProfile) -> LaunchResolutionResult<ResolvedLaunch> {
       // 优先使用 bundled 资源
       if let Ok((runtime_path, adapter_entry, working_dir)) = resolve_bundled_adapter_runtime() {
           return Ok(ResolvedLaunch {
               command: runtime_path,
               args: vec![adapter_entry],
               cwd: Some(working_dir),
           });
       }

       // 回退到 bunx
       if command_exists("bunx") {
           return Ok(ResolvedLaunch {
               command: "bunx",
               args: vec!["--yes", format!("{package_name}@{package_version}")],
           });
       }

       // 回退到 bun x
       if command_exists("bun") {
           return Ok(ResolvedLaunch {
               command: "bun",
               args: vec!["x", "--yes", format!("{package_name}@{package_version}")],
           });
       }

       // 回退到 npx
       if command_exists("npx") {
           return Ok(ResolvedLaunch {
               command: "npx",
               args: vec!["--yes", format!("{package_name}@{package_version}")],
           });
       }

       // 失败
       Err(LaunchResolutionError::RuntimeNotFound(...))
   }
   ```

3. **Bundled 资源路径解析** (lines 146-205)
   ```rust
   fn resolve_bundled_adapter_runtime() -> LaunchResolutionResult<(PathBuf, PathBuf, PathBuf)> {
       // Bun runtime 路径
       let runtime_path = bundled_bun_path()?;
       // Adapter 包目录
       let package_dir = adapter_root
           .join("claude-code-acp")
           .join(CLAUDE_CODE_ACP_VERSION)  // "0.1.6"
           .join("node_modules")
           .join("@zed-industries")
           .join("claude-code-acp");
       // 检查 package.json 和 bin entry
       ...
   }

   fn bundled_bun_path() -> Option<PathBuf> {
       // resources/bundled-bun/{platform}/bun
       let platform_key = bundled_runtime_key();  // "darwin-arm64", "darwin-x64", etc.
       let base = bundled_resources_base()?;
       Some(base.join("bundled-bun").join(platform_key).join(executable_name))
   }
   ```

4. **版本常量** (lines 9-13)
   ```rust
   pub const CLAUDE_CODE_ACP_PACKAGE: &str = "@zed-industries/claude-code-acp";
   pub const CLAUDE_CODE_ACP_VERSION: &str = "0.1.6";
   pub const CLAUDE_CODE_PRESET_ID: &str = "preset-claude-code-acp";
   ```

### 当前资源目录状态

```
/Users/smkl/mydevelop/OneAgent/src-tauri/resources/
├── bundled-bun/
│   └── {platform}/       ← 空目录，只有 .gitkeep
├── external_agents/
│   └── claude-code-acp/
│       └── {version}/    ← 空目录，只有 .gitkeep
└── README.md
```

**问题：** Bundled 资源目录只有 `.gitkeep`，实际依赖未打包！

### 问题根因分析

1. **构建流程缺失**
   - 没有 CI/CD 流程预下载依赖
   - `resources/` 目录被 git ignore 或未包含实际文件

2. **首次使用时在线下载**
   - Bundled 资源不存在时，回退到 `bunx`/`npx`
   - 需要网络连接，首次启动慢

3. **用户体验不佳**
   - 用户期望开箱即用
   - 懒加载导致首次使用时等待下载

## 参考实现：AionUi

### 依赖管理策略

**关键文件：`/Users/smkl/mydevelop/GithubProjects/AionUi/package.json`**

AionUi 使用 Electron + Vite，前端依赖在构建时安装：
- 使用 Bun 作为包管理器
- 所有依赖在 `bun install` 时安装
- 不存在运行时懒加载

**关键配置：`electron-builder.yml`**

```yaml
# 打包时包含必要资源
files:
  - "**/*"
  - "!**/*.map"
extraResources:
  - ./resources/**/*
```

### 构建脚本

AionUi 使用 `justfile` 管理构建流程：
```just
build:
  bun install
  bun run build
  electron-builder
```

## 实施方案

### Phase 1：创建依赖打包脚本

**新增文件：`scripts/pack-dependencies.sh`**

```bash
#!/bin/bash

# 1. 下载 Bun runtime
TARGET_DIR="src-tauri/resources/bundled-bun"
VERSION="1.2.x"  # Bun 版本

for PLATFORM in "darwin-arm64" "darwin-x64" "linux-x64" "win32-x64"; do
  mkdir -p "$TARGET_DIR/$PLATFORM"
  # 下载 Bun binary
  curl -L "https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/bun-$PLATFORM.zip" -o temp.zip
  unzip temp.zip -d "$TARGET_DIR/$PLATFORM"
  mv "$TARGET_DIR/$PLATFORM/bun-$PLATFORM/bun" "$TARGET_DIR/$PLATFORM/"
  rm -rf "$TARGET_DIR/$PLATFORM/bun-$PLATFORM" temp.zip
done

# 2. 下载 Claude Code ACP adapter
ADAPTER_DIR="src-tauri/resources/external_agents/claude-code-acp"
VERSION="0.1.6"

mkdir -p "$ADAPTER_DIR/$VERSION"
cd "$ADAPTER_DIR/$VERSION"

# 使用 npm pack 获取包内容
npm pack "@zed-industries/claude-code-acp@$VERSION"
tar -xzf *.tgz
rm *.tgz

# 重新组织目录结构
mv package/node_modules node_modules
rm -rf package
```

### Phase 2：集成到构建流程

**修改文件：`package.json`**

```json
{
  "scripts": {
    "prebuild": "scripts/pack-dependencies.sh",
    "build": "npm run prebuild && vite build && cd src-tauri && cargo build --release"
  }
}
```

**修改文件：`src-tauri/tauri.conf.json`**

```json
{
  "bundle": {
    "externalBin": [
      "resources/bundled-bun/*"
    ],
    "resources": [
      "resources/**/*"
    ]
  }
}
```

### Phase 3：启动时依赖检查

**修改文件：`src-tauri/src/lib.rs`**

```rust
fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // 启动时检查依赖可用性
    let availability = claude_bridge_availability();

    match availability {
        BridgeAvailability::Ready => {
            log::info!("Claude Code adapter ready (bundled resources available)");
        }
        BridgeAvailability::Degraded(reason) => {
            log::warn!("Claude Code adapter degraded: {}", reason);
            // 可选：向用户显示警告
        }
        BridgeAvailability::Unavailable(reason) => {
            log::error!("Claude Code adapter unavailable: {}", reason);
            // 向用户显示错误，引导安装 bun/node
        }
    }

    // ...
}
```

### Phase 4：用户友好的依赖安装引导

**修改文件：`src/App.tsx`**

```tsx
// 启动时显示依赖状态
useEffect(() => {
    if (agentDiscoveryStatus.some(s => s.availability === 'unavailable')) {
        setComposerNotice("Some agents require additional dependencies. Install bun or node to enable full functionality.");
    }
}, [agentDiscoveryStatus]);
```

**新增组件：`src/components/DependencyStatus.tsx`**

显示各 Agent 的依赖状态，提供安装引导。

### Phase 5：优化 CI/CD 流程

**新增文件：`.github/workflows/build.yml`**

```yaml
name: Build

on: [push, pull_request]

jobs:
  build:
    steps:
      - uses: actions/checkout@v4

      - name: Pack dependencies
        run: ./scripts/pack-dependencies.sh

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        with:
          tagName: v__VERSION__
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 验证方案

1. **构建验证**
   - 运行 `npm run build`
   - 检查 `src-tauri/resources/bundled-bun/{platform}/bun` 是否存在
   - 检查 `src-tauri/resources/external_agents/claude-code-acp/0.1.6/` 目录结构

2. **运行验证**
   - 启动应用，检查 `claude_bridge_availability()` 返回 `Ready`
   - 选择 Claude Code Agent，确认不触发在线下载
   - 首次发送消息时，响应快速（无下载延迟）

3. **离线验证**
   - 断开网络连接
   - 启动应用，Claude Code Agent 应仍可用
   - 发送消息成功

## 涉及的关键文件

| 文件 | 修改内容 |
|------|----------|
| `scripts/pack-dependencies.sh` | 新增：依赖打包脚本 |
| `package.json` | 增加 prebuild 脚本 |
| `src-tauri/tauri.conf.json` | 配置资源打包 |
| `src-tauri/src/lib.rs` | 启动时依赖检查 |
| `src/App.tsx` | 显示依赖状态警告 |
| `.github/workflows/build.yml` | 新增：CI 构建 workflow |

## 需要下载的资源

| 资源 | 来源 | 版本 |
|------|------|------|
| Bun Runtime | https://github.com/oven-sh/bun/releases | 1.2.x |
| Claude Code ACP | npm: @zed-industries/claude-code-acp | 0.1.6 |

## 目录结构预期

打包后的 `resources/` 目录结构：

```
resources/
├── bundled-bun/
│   ├── darwin-arm64/
│   │   └── bun              # macOS ARM64 Bun binary
│   ├── darwin-x64/
│   │   └── bun              # macOS x64 Bun binary
│   ├── linux-x64/
│   │   └── bun              # Linux x64 Bun binary
│   └── win32-x64/
│       └── bun.exe          # Windows x64 Bun binary
├── external_agents/
│   └── claude-code-acp/
│       └── 0.1.6/
│           ├── node_modules/
│           │   └── @zed-industries/
│           │       └── claude-code-acp/
│           │           ├── package.json
│           │           ├── bin/
│           │           │   └── claude-code-acp
│           │           └── ...
│           └── ...
└── README.md
```