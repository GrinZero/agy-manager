# Antigravity 母账号云端授权与真实额度查询

核查日期：2026-11-11（Asia/Taipei）。当前采用用户补充的方案：管理员在云端管理页面连接母账号，服务端保存授权并直接查询真实额度；成员继续使用原生客户端与现有家庭预算 Hook，不新增统一推理网关。用户已接受第三方 OAuth 与非公开额度接口可能带来的账号风险。此前 statusLine 客户端快照方案仅保留为备用。

## 当前结论

开源 Antigravity-Manager 已实现 Web/Docker 授权、粘贴 loopback 回调、刷新 token、查询 `loadCodeAssist` 与 `retrieveUserQuotaSummary`。这些能提供实现参照，但非 Google 对第三方额度产品的支持承诺。未在此研究中触碰用户凭据、实际调用内部接口或执行模型请求。

主源为当前默认分支：

- [OAuth 实现](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/oauth.rs)；读取内容 SHA `7b8d9f3885d07f6a3e2cca9b676b8f2db492aa62`。
- [OAuth 流程与手动提交](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/oauth_server.rs)；SHA `a70b9d546014e2e01d83f8bb607f512ba6ad9a5c`。
- [Web 回调与 redirect 选择](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/proxy/server.rs)；SHA `56f1622ae14c3c19b674cb660c50f351e714b1c1`。
- [额度查询与分组](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/quota.rs)；SHA `1b04aed28e7c51165307b4cbc5b83fbe6ae9d197`。
- [额度模型](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/models/quota.rs)；SHA `e2c5d2ecce6e5264afaa217087f4d9b79030c4bf`。

SHA 是文件内容标识，不是 Git commit；引用链接指向可变默认分支，实施时应保留本次核查的语义与回归测试。

## OAuth：loopback 与手动粘贴

默认标准 OAuth client 的公开 ID 为 `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`。本报告不输出 client secret。当前 Manager 的 Web `resolve_oauth_redirect_uri` 明确对内置 client 只允许 loopback 地址，公网 `ABV_PUBLIC_URL` 会被忽略，回退到 `http://localhost:<port>/auth/callback`。桌面端则在 loopback 随机端口使用 `/oauth-callback`。不能把内置 client 的 redirect 随意改成 Workers 公网域名。[Web 源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/proxy/server.rs#L4175)、[桌面源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/oauth_server.rs#L129)

可行的云端流程是：

1. 已通过管理员令牌认证的后台创建短时、单次 OAuth 会话，保存 state、redirect URI、client 标识与 PKCE verifier。
2. 生成 Google 授权 URL，在用户的系统浏览器打开。
3. 用户授权后，Google 跳转到例如 `http://localhost:8045/auth/callback?code=...&state=...`。用户机器没有监听时显示连接失败；用户把完整地址粘贴回当前云端后台。
4. 服务端仅解析地址并严格验证 scheme、host、port、path、state、会话有效期与管理员归属；不要 fetch 粘贴的地址。
5. 使用发起授权时保存的同一 redirect URI 交换 code，完成后消费会话。OAuth code、完整回调 URL、token 不写日志，也不放入后续页面 URL。

这与 Manager 的 `prepare_oauth_flow_manually` / `submit_oauth_code` 模式一致。它是 loopback 回调地址的手工转交，不是已废弃的 `urn:ietf:wg:oauth:2.0:oob` 授权方式。[手工流程源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/oauth_server.rs#L482)

内置 client 的实际 Google Cloud Console 配置无法通过公开源码读取；源码和已有项目证明该项目依赖 loopback，但不能证明任意公网回调被允许。

## OAuth 请求字段与 PKCE

Manager 的授权端点为 `https://accounts.google.com/o/oauth2/v2/auth`，token 端点为 `https://oauth2.googleapis.com/token`，userinfo 为 `https://www.googleapis.com/oauth2/v2/userinfo`。

授权 URL 字段：

```text
client_id=<configured client>
redirect_uri=<stored exact URI>
response_type=code
scope=<space-delimited scopes>
access_type=offline
prompt=consent
include_granted_scopes=true
state=<random single-use state>
```

Manager 当前 scope 列表为 `openid`、`https://www.googleapis.com/auth/cloud-platform`、`https://www.googleapis.com/auth/userinfo.email`、`https://www.googleapis.com/auth/userinfo.profile`、`https://www.googleapis.com/auth/cclog`、`https://www.googleapis.com/auth/experimentsandconfigs`。这是该参考项目的请求，不代表 Google 为本产品承诺最小 scope 集合或可授权性。[OAuth 源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/oauth.rs#L367)

交换 code 使用 `application/x-www-form-urlencoded`：

```text
client_id=<configured client>
client_secret=<server-side configured value, if required>
code=<authorization code>
redirect_uri=<stored exact URI>
grant_type=authorization_code
code_verifier=<stored verifier when PKCE is enabled>
```

刷新 token 同样 POST token 端点，form 字段为 `client_id`、`client_secret`（按 client 配置）、`refresh_token`、`grant_type=refresh_token`。userinfo 使用 Bearer access token。

**PKCE 区分：** 本次读取的 Manager `oauth.rs` 没有 `code_challenge` 或 `code_verifier`；其参考实现未使用 PKCE。Google 官方桌面 OAuth 文档则明确支持并推荐 S256：授权请求增加 `code_challenge=BASE64URL(SHA256(verifier))` 与 `code_challenge_method=S256`，token 请求提供原 verifier。verifier 长 43–128 字符。可在本项目实施，但内置 client 的真实授权交换仍需端到端验收。[Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

Google 官方桌面流程要求本地 redirect，支持 loopback 随机端口；client secret 在桌面应用中无法保持机密。云端服务应把所用配置与 token 均限制在服务端，公开 client ID 不等于公开用户凭据。

## Project 与套餐查询

先 POST 以下任一 host 的 `/v1internal:loadCodeAssist`：

1. `https://daily-cloudcode-pa.googleapis.com`
2. `https://daily-cloudcode-pa.sandbox.googleapis.com`
3. `https://cloudcode-pa.googleapis.com`

请求 body：

```json
{"metadata":{"ideType":"ANTIGRAVITY"}}
```

headers：`Authorization: Bearer <access_token>`、`Content-Type: application/json`、出站 `User-Agent`。Manager 当前使用动态 Hub UA，见下节。源码响应结构读取 `cloudaicompanionProject`、`currentTier`、`paidTier`、`allowedTiers`；套餐优先 paidTier，其次 currentTier。应保留原 tier 标识，不凭模型列表推断付费套餐。[loadCodeAssist 源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/quota.rs#L166)

## 真实额度 Summary 请求与响应

POST 同三个 host 的 `/v1internal:retrieveUserQuotaSummary`，默认顺序 daily → daily sandbox → production。Manager 单次超时 15 秒，会尝试后续端点。

headers：

```text
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: <configured hub identity>
```

body 为 `{"project":"<cloudaicompanionProject>"}`；project 不存在时参考项目发送 `{}`，但不应把失败或空响应解释为满额。旧 issue 曾报告缺 project 导致 403，故应优先解析 project 并明确显示错误。[请求源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/quota.rs#L838)、[项目内 issue #3426](https://github.com/lbjlaq/Antigravity-Manager/issues/3426)

当前 Manager 的 summary 使用 `current_egress_user_agent()`，不是旧 `NATIVE_OAUTH_USER_AGENT`。默认 Hub 形式为：

```text
antigravity/hub/2.28.0 (aidev_client; os_type=windows; arch=amd64; cl=1008300195)
```

版本与 CL 来自参考项目维护者的客户端观测，可变且非官方公共协议，宜可配置，不应宣称永久有效。[UA 源码](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/constants.rs#L218)

响应结构：

```ts
interface QuotaSummary {
  groups: Array<{
    displayName?: string;
    description?: string;
    buckets: Array<{
      bucketId?: string;
      window?: string;
      remainingFraction?: number;
      resetTime?: string;
      displayName?: string;
      description?: string;
    }>;
  }>;
}
```

`remainingFraction` 为 0 时表示耗尽；缺失时为未知，不能填 1。`resetTime` 是 RFC3339 恢复时间。服务端可另加 `observedAt` 作为本次查询接收时间，但不能把它当作上游数据生成时间。

## 桶、窗口与模型池

参考项目类型注释列出 `gemini-weekly`、`gemini-5h`、`3p-weekly`、`3p-5h`，窗口为 `weekly`、`5h`；相关逻辑也容忍 `7d` / `hour` 文本。源码另见 `gemini-argon-wtu-weekly`。这些不是完整、稳定的上游枚举，应原样保存未知 ID 和窗口。[类型](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/models/quota.rs#L3)、[分组逻辑](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/modules/quota.rs#L533)

当前 Manager 的映射规则：Argon 优先匹配 group 名称或 bucket ID/名称含 `argon` 的专属组；Claude/GPT 匹配 `claude` / `gpt` / `3p` 组；其余 Gemini 走通用 Gemini。Ultra 无独立 Argon 组时允许 Argon 继承通用 Gemini。非 Ultra 未命中专属 Argon 组时不假定可用。

Manager 的 2026-11-05 代码注释明确标为临时实验：Argon High 消耗通用 Gemini 5h/weekly 但仍受 Argon 门禁；Medium/Low 共享 Argon WTU 周桶，行为可能漂移。不能把“展示同池”当作“所有套餐都只有两个物理桶”。

2026-11-11 的另一个维护者一手发布记录已加入 Carbon Low/Medium/High，并在其当日 IDE 账号观测到 Carbon、Argon、Flash 同一个 Gemini 池，Claude/GPT 另池。它也明确当成员数据不一致时保留区间和明细。该记录是维护者对特定样本的观测，不能替代用户母账号真实 summary。[Context Window Monitor v1.16.20](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor/releases)

**本项目建议：** 后台完整渲染上游 groups/buckets；模型池标签只做辅助归类。不要求和/平均百分比，不把独立 Argon 周桶伪装成 Gemini 5h，也不把自定义 1/3/8 积分换算为官方消耗。Carbon 在当前 Manager 无专用额度映射；按 Gemini 通用归类仅是其现有 fallback。

## 产品与验收边界

云端显示母账号邮箱、套餐、各真实桶剩余值、恢复时间、最后成功查询时间、错误或过期状态。刷新失败保留最近成功快照并标记过期，不能回退为满额。刷新 token 撤销或 `invalid_grant` 应要求重新连接，不无限重试。

OAuth state 应绑定发起管理员、短期过期、单次消费；PKCE verifier 与 refresh token 需服务端加密保存，概览接口从不返回 token。粘贴 URL 属于凭据输入，提交后清空，不持久化完整 URL。

真实额度只能反映母账号剩余量；成员原生调用的预算归属仍依赖本地 Hook，不能通过母账号总余额自动精确还原每个成员的消耗。

自动测试可验证授权参数、state/PKCE/URI、token加密、summary解析、refresh错误与UI。没有真实登录交换和成功summary样本时，不能声称账号登录与真实额度已端到端验证。

## 备用：官方 CLI statusLine 快照

若用户以后选择不在云端托管 OAuth，可复用官方 CLI 的 `statusLine` stdin：它提供 `quota`、`email`、`plan_tier`、`version`。配置支持 `command`、`type`、`padding`、`enabled`、`stack_with_default`，agent 状态变化时运行，最多每 300ms 一次、5 秒超时。`/usage`（或 `/quota`）会主动刷新后端额度。该备用方式只在客户端有快照时同步，不是当前选择的云端直接查询。[Status line](https://antigravity.google/docs/cli/statusline/)、[/usage](https://antigravity.google/docs/cli/commands/usage/)

官方附加条款 §6 和 FAQ 对第三方访问消费者订阅有明确限制；本次用户接受相关风险不构成官方授权或零风险保证。[Terms](https://antigravity.google/terms)、[FAQ](https://antigravity.google/docs/faq/)
