# WebUI LAN 认证问题排查文档

## 问题描述

通过 `http://127.0.0.1:19520/?token=xxx` 访问 WebUI 可以正常自动登录，但通过局域网 IP `http://10.x.x.x:19520/?token=xxx` 访问时，API 请求返回 401 Unauthorized，跳转到登录页。

## 已确认的事实

1. **Token 传输正确** — 服务端日志确认收到的 token 前缀与 Settings 中显示的一致，token_len=123
2. **JWT 验证失败** — `jsonwebtoken::decode` 返回 `InvalidSignature`
3. **Secret 长度正确** — 服务端日志显示 `secret (len=64)`
4. **同一个 token** — 在浏览器地址栏复制的 token 和服务端收到的完全一致
5. **localhost 正常** — 同一个 token 通过 127.0.0.1 访问时验证成功
6. **LAN IP 失败** — 同一个 token 通过局域网 IP 访问时验证失败

## 核心矛盾

同一个 JWT token、同一个服务进程、同一个 secret，仅因请求来源不同（localhost vs LAN IP）导致签名验证结果不同。这在 JWT 验证逻辑上不应该发生。

## 当前认证流程

### Token 创建（`get_webui_info` 命令）
```
set_webui_enabled
  → AuthService::ensure_initialized_at()  // 创建 web_auth.json（含 password + jwt_secret）
  → AuthService::new()                     // 加载 secret 到内存，迁移旧配置
  → WebUiManager::start()                  // spawn server task
  → server task: AuthService::new()        // 加载 secret
```

```
get_webui_info
  → AuthService::create_token()
    → AuthService::new_with_path()         // 重新读取 web_auth.json
    → create_jwt()                         // 用 secret 签名 JWT
```

### Token 验证（请求到达时）
```
auth_middleware
  → 从 Authorization header / Cookie / query param 提取 token
  → AuthService::verify_jwt(token)         // 用内存中的 secret 验证签名
```

### 相关文件
- `src-tauri/src/channel_api/web/auth.rs` — AuthService, JWT 创建/验证
- `src-tauri/src/channel_api/web/middleware.rs` — auth_middleware
- `src-tauri/src/channel_api/web/mod.rs` — axum 路由、WebState 构造
- `src-tauri/src/channel_api/mod.rs` — get_webui_info, set_webui_enabled
- `src/lib/backend/transport.ts` — 前端 invoke 函数，token 传输

## 已尝试的方案

1. ~~Token 改为 camelCase 序列化~~ — 与本问题无关
2. ~~unwrap_params 解包单 key 参数~~ — 已修复其他问题，与本问题无关
3. **Auth middleware 支持三种 token 来源** — header / cookie / query param，已实现但仍失败
4. **前端同时在 header 和 query param 发送 token** — 已实现但仍失败
5. **统一 secret 来源** — `create_token` 和 server 都通过 `AuthService::new()` 加载 config，已实现

## 可能的排查方向

### 1. 验证 secret 是否真的一致
在 `auth.rs` 的 `verify_jwt` 中打印 secret 的前几个字节（hex），在 `create_token` 中也打印，对比是否一致。

```rust
// 在 verify_jwt 和 create_token 中都加上：
tracing::info!("Auth: secret_hex={}", hex::encode(&self.jwt_secret[..8]));
```

### 2. 检查是否有中间代理
局域网环境下可能有 HTTP 代理、负载均衡器、防火墙等修改了请求。可以用 `curl` 直接测试：

```bash
# 在另一台机器上执行
curl -v -H "Authorization: Bearer <token>" http://10.x.x.x:19520/api/invoke/list_workspaces -X POST -H "Content-Type: application/json" -d '{}'
```

如果 curl 也返回 401，说明不是浏览器问题。

### 3. 检查 `jsonwebtoken` 库的行为
`jsonwebtoken` 的 `Validation::default()` 会检查 exp、iss、aud 等。尝试放宽验证：

```rust
let mut validation = Validation::default();
validation.validate_exp = true;
validation.required_spec_claims.clear();  // 不检查 iss, aud, sub
```

### 4. 尝试完全绕过 JWT
如果排查困难，可以改为 session-based 认证：
- `/api/login` 成功后在服务端内存生成 session_id
- 将 session_id 存入 HttpOnly cookie
- middleware 从 cookie 读取 session_id 并在内存中验证

### 5. 添加 trace 级别日志
在 Cargo.toml 中启用 `tracing` 的最大日志级别，看 `jsonwebtoken` 内部的验证细节。

## 当前代码状态

- 分支：`switch-to-acp-rust-sdk`
- 最后修改：auth middleware 支持三种 token 来源 + 前端 query param fallback
- `npm run build` + `cargo build` 均已通过
- localhost 自动登录正常工作
