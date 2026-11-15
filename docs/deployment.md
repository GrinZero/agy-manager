# 部署与账号配置

[返回 README](../README.md)

## 按钮部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FGrinZero%2Fagy-manager)

首次部署推荐使用按钮，按 [README 的快速开始](../README.md#快速开始)填写管理员邮箱和加密密钥。Cloudflare 从公开的 `wrangler.jsonc` 识别并创建 D1，再执行 `npm run deploy` 应用迁移和发布服务。数据库迁移使用绑定名 `DB`，允许在向导中自定义数据库名。

部署后继续使用向导更新过的 `wrangler.jsonc`。不要用原始示例覆盖已绑定的数据库 ID，也不要重新生成加密密钥。按钮部署时填写的密钥由你自行备份，不会自动生成本机 `.production.vars`。

## 部署到 Cloudflare

命令行方式适用于自行管理部署的用户，需要 Node.js 22.12+（推荐 24 LTS）和 Cloudflare 账号。首次克隆：

```sh
git clone https://github.com/GrinZero/agy-manager.git
cd agy-manager
npm ci
cp wrangler.example.json wrangler.json
npx wrangler login
npm run setup:cloud
npx wrangler secret put ADMIN_GOOGLE_EMAIL
node scripts/setup-account-key.mjs --production
npm run deploy
```

`setup:cloud` 创建 `agy-family-quota` D1 数据库（位置提示为亚太）并更新 `wrangler.json`。`ADMIN_GOOGLE_EMAIL` 填母账号邮箱，设置后只有该邮箱能以管理员身份登录或连接母账号；首次登录还会绑定 Google 固定账号 ID。已有母账号的部署会通过迁移保留其管理员邮箱，无需重新配置。未配置邮箱、也未绑定过母账号时，公开 Google 登录入口不会允许首位访客认领后台。

`ADMIN_TOKEN` 保留为可选的管理 API 与备用登录凭据，日常 Google 登录不需要填写或配置它。管理员令牌请用密码管理器生成至少 32 字符的随机字符串，与成员令牌分开保存。不要把 `.dev.vars` 的本地测试令牌用于生产。

如果账号已有同名数据库，用 `npx wrangler d1 list` 找到 ID，手动写入 `wrangler.json` 后再部署。不要反复创建数据库。多账号时在 Wrangler 配置中设置 `account_id`。

`npm run deploy` 先执行远程迁移，再部署 Worker 与静态管理页。首次部署后打开输出的 `workers.dev` 地址；`GET /health` 可检查数据库连接。

需要备用令牌时，用密码管理器生成至少 32 字符的随机字符串，再通过 `npx wrangler secret put ADMIN_TOKEN` 设置。日常 Google 登录无需设置它。

## 云端母账号与真实额度对账

在登录页点击「使用 Google 账号登录」，选择母账号并授权，即可同时登录后台与连接额度查询。已登录后台也可重新连接母账号。默认使用安装型 OAuth client：授权后会跳转到 `http://localhost:50987/oauth-callback`，无需本地服务器；复制跳转后的完整地址回后台完成连接，不要分享该地址。授权会话 10 分钟过期，一次性使用，并校验 state、PKCE、发起浏览器与用途。

默认沿用已验证可查额度的桌面 OAuth 客户端。若改为自己的 Web OAuth client，必须先验证该客户端有额度接口访问资格；新注册客户端加上 scope 并不保证能查额度。仅对已验证可用的 Web client，使用 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 覆盖身份，将 `GOOGLE_REDIRECT_URI` 设置为 `https://你的后台域名/api/auth/google/callback`，并在 Google Cloud Console 登记完全相同的 Authorized redirect URI。桌面 client 不能直接改用公网回调，仍需手动粘贴。

后台会话仅保存随机令牌的哈希，Cookie 设置 HttpOnly、SameSite=Lax，HTTPS 下启用 Secure 与 `__Host-` 前缀；通过 Cookie 进行管理写操作时校验同源 Origin。母账号断开连接后保留管理员身份，仍可通过 Google 登录恢复连接。更换母账号会使旧账号会话失效；若配置了 `ADMIN_GOOGLE_EMAIL`，需先更新该配置才能更换。

母账号 access/refresh token 使用 `ACCOUNT_ENCRYPTION_KEY` 加密存入 D1，不返回浏览器或成员。密钥生成脚本只通过 stdin 配置 Cloudflare Secret，重复执行保留原密钥；请备份 `.production.vars`。本地 `setup:local` 自动创建独立开发密钥。

Cloudflare Cron 每分钟检查同步条件：近 5 分钟有调用或仍有有效预留时，每分钟同步官方余额；无调用且无预留时，每 5 分钟同步。页面显示「空闲中 · 每 5 分钟同步」。空闲后的首次调用若官方快照超过 90 秒，会先尝试同步，整个上游查询最多等待 8 秒；失败时继续按原有 15 分钟容错门禁处理，授权失效仍立即阻断。手动刷新保留 55 秒去重与失败退避。

官方查询仅使用 `daily-cloudcode-pa`，避免其他端点的独立额度账本带来假跳变，并传递 `cloudaicompanionProject`。管理页可见时每 30 秒读取保存的快照；点击「刷新」请求官方查询。保留上游所有分组、窗口和重置时间，不把空结果当作 0% 或 100%。查询失败保留上次成功快照并显示状态。云端查询采用非公开额度接口，接口变化需要后续维护。协议依据见[额度同步调研](research/antigravity-quota-sync.md)。

成员始终走 `/check`、`/commit`、`/release` 与我们的云端百分比账本，不转发模型请求。调用预检在单条原子 SQL 中同时校验个人百分比份额、家庭百分比上限与母账号真实可用余额（扣除进行中预留与 `buffer_percent` 安全留白），避免并发超分配。母账号未连接、`status === 'auth_required'`（授权失效）、快照超过 **15 分钟（900 秒）**未更新，或官方余额不足时将立即暂停新调用；短暂上游查询超时在 15 分钟容错宽限期内结合最近有效快照与保守转换率上界继续正常放行。接入前的历史官方消耗不会折算进成员个人用量，但官方剩余百分比会作为池级真实硬顶把关。

已安装成员可通过一次手动升级启用自动更新与最新能力（后续服务端更新 `agy-quota.mjs` 时，本地守门员会在调用输出完成后通过 `X-Agy-Client-Sha256` 校验并静默原子自更新，下一次调用即刻生效，不增加预检延迟）：

```sh
node public/client/install.mjs --upgrade
```

更新会复用本机原成员令牌，保留其他 Hook 与配置。后台「更新本地守门员」提供远程安装命令。

## GitHub 与 fork 的公开配置

配额桌面客户端的 ID 和配套 secret 可随源码分发，默认身份在 [`src/mother-account.ts`](../src/mother-account.ts)。这是公开应用身份，不是任何人的账号 token；每个使用者仍要自行授权。代码使用 PKCE、随机 state、独立浏览器绑定和一次性回调。共用身份的客户端限制或停用可能影响所有使用者，API 准入也不能靠 fork 获得。[Google 桌面客户端说明](https://developers.google.com/identity/protocols/oauth2/native-app)

公开的 `wrangler.jsonc` 用于按钮部署和首次本地运行，`wrangler.example.json` 提供命令行部署的配置模板，两者都不含原部署的账号或数据库 ID。需要独立管理本机部署配置时，将示例复制为已忽略的 `wrangler.json`；Wrangler 会优先使用它。各部署的 Google token 只存各自数据库，不发回原项目。通过按钮创建的仓库应保留向导写入 `wrangler.jsonc` 的资源信息。

更新项目时保留自己的数据库绑定、Secrets 与母账号加密密钥，运行 `npm ci` 后执行 `npm run deploy`，自动先应用新增迁移。按钮部署的密钥若要改用本机脚本管理，先将原值存入 `.production.vars` 的 `ACCOUNT_ENCRYPTION_KEY`，避免脚本为已有凭据生成不同密钥。

如需替换配额客户端，设置 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`；此替换不会自动获得上游配额接口准入。Web 类型客户端的 secret 必须保密，不能按桌面类型处理。[Google Web 客户端说明](https://developers.google.com/identity/protocols/oauth2/web-server)

不要提交 `.oauth/`、`.dev.vars`、`.production.vars`、`.env`、`.wrangler/`、数据库、账号 access/refresh token、后台令牌、加密密钥或授权截图。`.gitignore` 已排除这些本地目录、配置及 `output/`；忽略规则不会移除已跟踪文件，发布前仍需检查实际提交内容。

提交前可使用 Gitleaks 8.30+ 执行 `gitleaks git --staged --redact`，提交后执行 `gitleaks git --redact` 检查历史。`.gitleaks.toml` 继承默认规则，仅按源码路径和完整值同时匹配，允许已公开的桌面 OAuth 应用身份；个人账号令牌、自建 Web OAuth secret 和部署密钥不在豁免范围。

公开应用介绍、隐私政策和使用条款分别位于 `/about.html`、`/privacy.html`、`/terms.html`，无需登录即可访问。Google OAuth 发布配置应使用实际可访问的页面，并登记对应授权域名；自行部署时需将这些页面中的实例支持联系方式及数据处理说明改为自己的实际情况。切换 OAuth 的发布状态与服务接口准入是独立步骤。
