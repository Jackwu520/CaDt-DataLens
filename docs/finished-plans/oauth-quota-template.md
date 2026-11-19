# 通用 OAuth 额度模板（Token Plan 需控制台登录的服务商）——方案与实施记录

> 状态：**已实施（2026-11-19）**。为额度外显（`ai-quota-display.md`）补第七种预设模板「OAuth」：
> 服务商的额度接口用的是**控制台登录 token**（不是 `sk-` API Key，且会过期需要续期），
> 用脚本模板的单请求管线查不了。本方案把 OAuth 登录/续期做成**通用 Go 引擎，配置驱动**，
> SenseNova Token Plan 是第一条配置（照 dsh 插件 `dsh-connect-sensenova-token-plan` 实现）。

## 1. 背景与为什么单独做

`ai-quota-display.md` 的 6 种模板里：官方走白名单引擎、通用/NewAPI/Sub2API/Token Plan/自定义
都是「账号 API Key → 一次 HTTP → extractor」。但 SenseNova 这类 Token Plan 查额度要的是
**OIDC 控制台 JWT**：

- API Key（`sk-`）只能调推理接口（`/v1/models`、`/chat/completions`），**查不到套餐额度**；
- 额度接口 `GET /lite/console/v1/tokenplan/pool-usage` 要 `Authorization: Bearer <JWT>`；
- JWT 3 小时过期，靠 `refresh_token` 轮转续期（Hydra 每次续期返回新 refresh token，必须回写）。

这就是 cc-switch 文档里「自动查询（官方订阅）」那一类——数据源唯一但凭据体系是登录态，
需要单独的登录流程，塞不进单请求脚本模板。

## 2. 总体设计（通用引擎 + 配置驱动）

```
[前端配置弹窗]  OAuth 模板 → provider 选择（SenseNova）→ 账号/密码 → AIOAuthQuotaLogin
   ↓ 只传一次密码，不落盘
[Go internal/oauthquota]  Provider 配置表（端点/参数全在这里，引擎无厂商硬编码）
   ├─ 登录：OIDC authorize → login_challenge → IAM login（JWE 封密码）→ code → token
   ├─ 凭据：refresh token 存 <appdata>/oauth-<providerID>-credentials.json（DPAPI 加密）
   ├─ 续期：access token 过期/被拒 → refresh_token 换新（轮转回写）
   └─ 查询：带 Bearer 发 GET，原样回响应（URL 限在 provider ConsoleOrigin 下）
   ↓ FetchResult{status, body, ...}（与 aigen.HTTPResult 同形状）
[前端 ai-usage-quota]  把响应喂给模板脚本的 extractor（同一个 Worker 沙箱）→ UsageItem[]
   ↓
[余额行 / 明细弹层]  与另外 6 种模板完全一样的渲染
```

**关键取舍**：Go 引擎**不做响应解析**——额度字段各厂商不同，解析交给前端预设脚本的
extractor（已有的安全沙箱），这样新增 OAuth 服务商只加「一条 Go Provider 配置 + 一条
前端预设脚本」，不动引擎/管线/UI。

## 3. OIDC 登录链路（照 dsh 插件逐跳实现）

Provider 配置字段：`ConsoleOrigin / IAMOrigin / TokenURL / JWKSURL / ClientID / Scope /
EncKeyID / IAMLoginPath / UsagePath / RedirectURI / UserAgent`。SenseNova 的值见
`internal/oauthquota/auth.go` 的 `providers` 表。

1. `GET {ConsoleOrigin}/oauth2/auth?client_id=...&code_challenge=<S256>&state=<nonce>&...`
   → 手工跟跳转（跨主机 + CSRF cookie 要一个 jar），拿到 `login_challenge`；
2. `GET {JWKSURL}` 取加密公钥（缓存 10 分钟）→ 封密码成 5 段紧凑 JWE：
   `RSA-OAEP(SHA-1)` 包 AES-256 key + `A256GCM` 加密密码，AAD 是 protected header 的
   base64url 段（RFC 7516 §5.1 step 14，不是 JSON 原文）；
3. `POST {IAMOrigin}{IAMLoginPath}` `{username, password: <JWE>, challenge, is_encrypt:true}`
   （带 Origin/Referer/cookie）→ 回 `redirect`；
4. 跟 `redirect` 到 `code=`，**校验 state 与第 1 步 nonce 一致**（拒绝跨流程授权码）；
5. `POST {TokenURL}` `grant_type=authorization_code&code=...&code_verifier=...` → access/refresh token。

续期：`POST {TokenURL}` `grant_type=refresh_token&...`；`expires_in` 缺省按 10800 秒。
`isFresh` 判定留 120 秒余量；401/403 强制丢弃当前 access token 再续一次；
凭据文件按 providerID 隔离（`oauth-<id>-credentials.json`），密码永不落盘，只存 refresh token。

## 4. 前端接线

- `ai-usage-templates.js`：`USAGE_TEMPLATE_KEYS` 加 `oauth`（chips 第 7 个，和官方/通用/NewAPI/
  Sub2API/Token Plan/自定义并列）；`USAGE_OAUTH_PROVIDERS` 表（当前 SenseNova 一条，含预设脚本）；
  `usageTemplatePresetCode('oauth', id)` 取 `provider.script`。
- SenseNova 预设脚本：`GET pool-usage` 的 request + extractor——每池出 `window_5h` / `window_7d`
  两档（已用% = used/limit，remaining 数值重置时间 `reset_at` 秒转可读），`grant_balance` 返赠余额
  进 extra。用户要的 4 项信息（已用%、剩余数值、重置时间、返赠余额）全覆盖。
- `ai-usage-config-dialog.js`：OAuth 模板下显示 provider chips + 通用登录框（账号/密码/登录/
  登出/刷新状态），状态经 `AIOAuthQuotaStatus` 异步读；登录成功清密码框。
- `ai-usage-quota.js`：`runScriptQuery` 按模板选发送通道——`oauth` 走 `AIOAuthQuotaFetch(providerID,url)`，
  其他走 `AIUsageHTTPRequest`（aigen 哑通道）；两通道都把响应喂同一个 Worker 沙箱 extractor。

## 5. 安全

- 密码只在登录瞬间经绑定传入，Go 侧封成 JWE 后发出，不写日志、不落盘；登录成功前端清密码框。
- refresh token 存 DPAPI 加密文件（Windows，绑定当前用户与本机）；非 Windows 明文降级与
  envvars / aiconfig 一致；文件 0600。
- `AIOAuthQuotaFetch` 校验 URL 必须落在 provider 的 `ConsoleOrigin` 下，防止带着 token 打别的站点。
- OAuth provider 不开放给 AI（无 executeTool / app_control 入口），与额度外显其余模板一致。

## 6. 落地清单

- Go：`internal/oauthquota/`（auth.go / login.go / store.go / fetch.go + oauthquota_test.go）；
  `oauthquota_app.go` 五个通用绑定（Providers/Login/Status/Logout/Fetch）；wailsjs 三件手写同步。
- 前端：模板表加 OAuth + SenseNova 预设；配置弹窗登录 UI；查询管线分流；SenseNova 品牌图标。
- 测试：Go 表驱动（provider 表 / PKCE S256 / JWE 5 段自洽 / 凭据路径隔离 / URL 白名单）；
  前端模板测试覆盖 OAuth provider 表；改动面测试与 `go build`/`go test`、`vite build` 全绿。

## 7. 已知边界

- OIDC 登录是逐跳复刻 dsh 插件的厂商实现（含客户端脚本里的跳转扫描），平台改版可能需要跟端点。
- 真实账号的端到端登录/续期/查询需要用户的 SenseNova 账号密码，未做实机验证；Go 单测覆盖
  的是协议原语与配置约束，登录链路的逻辑来自对 dsh 插件源码的逐行移植。
- 新增 OAuth 服务商：Go `providers` 表加一条 + 前端 `USAGE_OAUTH_PROVIDERS` 加一条预设脚本即可。
