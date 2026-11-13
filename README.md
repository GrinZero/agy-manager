# AGY 家庭配额

基于 Antigravity 原生 Lifecycle Hooks、Cloudflare Workers 与 D1 的家庭额度管理器。管理页面、接口和数据库共用一个 Cloudflare 项目，不需要常驻服务器。

自行部署后使用自己的 Worker 地址。生产管理员令牌的本机副本为 `.production.vars`，不要提交或分享给成员。

## 本地运行

需要 Node.js 20.19+（推荐 24 LTS）。

```sh
npm ci
cp wrangler.example.json wrangler.json # 首次 fork 后执行；已有部署不要覆盖
npm run setup:local
npm run dev
```

`npm run dev` 启动前会自动检查本地密钥并补齐数据库迁移；已有密钥、成员和调用记录会保留。

打开 http://127.0.0.1:8787。在 `.dev.vars` 配置 `ADMIN_GOOGLE_EMAIL=母账号邮箱` 后，可直接点击「使用 Google 账号登录」。也可在备用入口使用 `.dev.vars` 自动生成的 `ADMIN_TOKEN`，连接一次母账号后自动绑定其管理员身份。Google 登录使用 HttpOnly Cookie 保留 7 天，刷新页面无需重新登录；退出会撤销当前会话。`.dev.vars` 已加入 `.gitignore`。

页面可添加成员、通过比例滑条速算或单独微调双池百分比限额、暂停使用、删除成员、重置成员令牌、查看流水，以及调整家庭百分比预算、安全缓冲留白、模型相对权重与自动区间校准开关。成员令牌只显示一次；数据库仅保存 SHA-256 哈希。

## 部署到 Cloudflare

```sh
npx wrangler login
npm run setup:cloud
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_GOOGLE_EMAIL
node scripts/setup-account-key.mjs --production
npm run deploy
```

`setup:cloud` 创建 `agy-family-quota` D1 数据库（位置提示为亚太）并更新 `wrangler.json`。`ADMIN_GOOGLE_EMAIL` 填母账号邮箱，设置后只有该邮箱能以管理员身份登录或连接母账号；首次登录还会绑定 Google 固定账号 ID。已有母账号的部署会通过迁移保留其管理员邮箱，无需重新配置。未配置邮箱、也未绑定过母账号时，公开 Google 登录入口不会允许首位访客认领后台。

`ADMIN_TOKEN` 保留为可选的管理 API 与备用登录凭据，日常 Google 登录不需要填写或配置它。管理员令牌请用密码管理器生成至少 32 字符的随机字符串，与成员令牌分开保存。不要把 `.dev.vars` 的本地测试令牌用于生产。

如果账号已有同名数据库，用 `npx wrangler d1 list` 找到 ID，手动写入 `wrangler.json` 后再部署。不要反复创建数据库。多账号时在 Wrangler 配置中设置 `account_id`。

`npm run deploy` 先执行远程迁移，再部署 Worker 与静态管理页。首次部署后打开输出的 `workers.dev` 地址；`GET /health` 可检查数据库连接。

也可用 `node scripts/setup-admin.mjs` 生成随机生产管理员令牌并通过 stdin 配置 Cloudflare Secret，本机副本为 `.production.vars`（`0600`，已忽略）。重复运行会使用原令牌，不会意外轮换；需要轮换时先更新该文件。该脚本首次运行可能先创建一个待部署的空 Worker。

## 云端母账号与真实额度对账

在登录页点击「使用 Google 账号登录」，选择母账号并授权，即可同时登录后台与连接额度查询。已登录后台也可重新连接母账号。默认使用安装型 OAuth client：授权后会跳转到 `http://localhost:50987/oauth-callback`，无需本地服务器；复制跳转后的完整地址回后台完成连接，不要分享该地址。授权会话 10 分钟过期，一次性使用，并校验 state、PKCE、发起浏览器与用途。

默认沿用已验证可查额度的桌面 OAuth 客户端。若改为自己的 Web OAuth client，必须先验证该客户端有额度接口访问资格；新注册客户端加上 scope 并不保证能查额度。仅对已验证可用的 Web client，使用 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 覆盖身份，将 `GOOGLE_REDIRECT_URI` 设置为 `https://你的后台域名/api/auth/google/callback`，并在 Google Cloud Console 登记完全相同的 Authorized redirect URI。桌面 client 不能直接改用公网回调，仍需手动粘贴。

后台会话仅保存随机令牌的哈希，Cookie 设置 HttpOnly、SameSite=Lax，HTTPS 下启用 Secure 与 `__Host-` 前缀；通过 Cookie 进行管理写操作时校验同源 Origin。母账号断开连接后保留管理员身份，仍可通过 Google 登录恢复连接。更换母账号会使旧账号会话失效；若配置了 `ADMIN_GOOGLE_EMAIL`，需先更新该配置才能更换。

母账号 access/refresh token 使用 `ACCOUNT_ENCRYPTION_KEY` 加密存入 D1，不返回浏览器或成员。密钥生成脚本只通过 stdin 配置 Cloudflare Secret，重复执行保留原密钥；请备份 `.production.vars`。本地 `setup:local` 自动创建独立开发密钥。

Cloudflare Cron 每分钟直接查询母账号分组额度，并支持 `daily-cloudcode-pa` → `daily-cloudcode-pa.sandbox` → `cloudcode-pa` 三端点自动容灾与 `cloudaicompanionProject` 传递；管理页每 30 秒查询，点击「刷新」也会立即触发查询。保留上游所有分组、窗口和重置时间，不把空结果当作 0% 或 100%。查询失败保留上次成功快照并显示状态。云端查询采用非公开额度接口；用户已选择该方案，接口变化需要后续维护。协议依据见 `docs/research/antigravity-quota-sync.md`。

成员始终走 `/check`、`/commit`、`/release` 与我们的云端百分比账本，不转发模型请求。调用预检在单条原子 SQL 中同时校验个人百分比份额、家庭百分比上限与母账号真实可用余额（扣除进行中预留与 `buffer_percent` 安全留白），避免并发超分配。母账号未连接、`status === 'auth_required'`（授权失效）、快照超过 **15 分钟（900 秒）**未更新，或官方余额不足时将立即暂停新调用；短暂上游查询超时在 15 分钟容错宽限期内结合最近有效快照与保守转换率上界继续正常放行。接入前的历史官方消耗不会折算进成员个人用量，但官方剩余百分比会作为池级真实硬顶把关。

已安装成员可通过一次手动升级启用自动更新与最新能力（后续服务端更新 `agy-quota.mjs` 时，本地守门员会在调用输出完成后通过 `X-Agy-Client-Sha256` 校验并静默原子自更新，下一次调用即刻生效，不增加预检延迟）：

```sh
node public/client/install.mjs --upgrade
```

更新会复用本机原成员令牌，保留其他 Hook 与配置。后台「更新本地守门员」提供远程安装命令。

## 手动添加成员

管理员进入「成员」页，点击「添加成员」，手动填写称呼、Google 账号邮箱和个人额度。成员使用绑定的邮箱登录后，可查看自己的额度与用量并生成安装令牌。修改邮箱会撤销该成员已有的登录会话；重复邮箱不能绑定其他成员。

本站不自动获取或同步 Google 家庭成员，也不申请家庭组读取权限。Google 家庭组邀请和本站成员添加分别完成。升级时，迁移 `0010_remove_family_connection.sql` 会移除旧的家庭组授权、待完成授权和候选成员快照；已有成员、邮箱、预算、用量及配额连接保留。

## GitHub 与 fork 的公开配置

配额桌面客户端的 ID 和配套 secret 可随源码分发，默认身份在 `src/mother-account.ts`。这是公开应用身份，不是任何人的账号 token；每个使用者仍要自行授权。代码使用 PKCE、随机 state、独立浏览器绑定和一次性回调。共用身份的客户端限制或停用可能影响所有使用者，API 准入也不能靠 fork 获得。[Google 桌面客户端说明](https://developers.google.com/identity/protocols/oauth2/native-app)

fork 后复制 `wrangler.example.json` 为本机的 `wrangler.json`，再按上方步骤建立自己的 Cloudflare D1、管理员身份和随机密钥。当前工作目录里的 `wrangler.json` 是部署专用配置，已忽略；示例不含原部署的账号或数据库 ID。各部署的 Google token 只存各自数据库，不发回原项目。

如需替换配额客户端，设置 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`；此替换不会自动获得上游配额接口准入。Web 类型客户端的 secret 必须保密，不能按桌面类型处理。[Google Web 客户端说明](https://developers.google.com/identity/protocols/oauth2/web-server)

不要提交 `.oauth/`、`.dev.vars`、`.production.vars`、`.env`、`.wrangler/`、数据库、账号 access/refresh token、后台令牌、加密密钥或授权截图。`.gitignore` 已排除这些本地目录、配置及 `output/`；忽略规则不会移除已跟踪文件，发布前仍需检查实际提交内容。

提交前可使用 Gitleaks 8.30+ 执行 `gitleaks git --staged --redact`，提交后执行 `gitleaks git --redact` 检查历史。`.gitleaks.toml` 继承默认规则，仅按源码路径和完整值同时匹配，允许已公开的桌面 OAuth 应用身份；个人账号令牌、自建 Web OAuth secret 和部署密钥不在豁免范围。

公开应用介绍、隐私政策和使用条款分别位于 `/about.html`、`/privacy.html`、`/terms.html`，无需登录即可访问。Google OAuth 发布配置应使用实际可访问的页面，并登记对应授权域名；自行部署时需将这些页面中的实例支持联系方式及数据处理说明改为自己的实际情况。切换 OAuth 的发布状态与服务接口准入是独立步骤。

## 给成员安装

在管理页添加成员，复制一次性展示的成员令牌和安装命令。电脑需有 Node.js，支持 macOS / Linux / Windows。安装 / 更新命令按成员电脑的系统分两套（页面上有选择器）：macOS / Linux 用 `curl` + `/tmp` + 单引号，Windows 用 `curl.exe` + 相对文件名 + 不带引号的 URL；Windows PowerShell 5.1 把 `curl` 别名成了 `Invoke-WebRequest`，所以必须显式用 `curl.exe`，且两行命令不用 `&&` 连接。

Windows 下安装器会在守门员目录写入 `run.cmd` 启动器（用 `%~dp0` 自定位脚本、Node 路径失效时回退到 PATH 中的 `node`），`hooks.json` 用它作为相对路径命令，避免 `cmd /c` 解析带空格的绝对路径时静默失败。安装结束前会用目标 shell 实际试跑一次 Hook 并校验输出是合法 JSON，只有打印「Hook 自检通过」才算成功；自检失败不会写入 `hooks.json`。从旧版安装升级时请重新运行安装器（或「更新本地守门员」）并重启客户端，否则 Hooks 不会执行、管理页「记录」也不会有流水。

也可在本仓库运行：

```sh
node public/client/install.mjs --url https://YOUR-WORKER.workers.dev
```

安装器会提示粘贴成员令牌，输入隐藏。无人值守安装用 `--token-file /absolute/path/to/token`，不要把令牌放进命令行或 URL。

管理页 `/#manual` 是面向成员的「守门员使用手册」，按成员电脑的系统生成安装、更新、带代理更新、取消代理和 `/health` 测速五条命令，并附参数速查与常见问题。改动 UI 时注意 `tests/manual.test.mjs` 会校验手册页的 id 连线与命令写法。

如果这台电脑的 Node 无法稳定直连配额服务（例如 TLS 握手反复超时），可在安装命令追加 `--proxy http://127.0.0.1:7897`。代理只用于配额门禁进程，不修改系统代理；支持无认证的 HTTP 代理，也支持 `http://user:pass@host:port` 形式。配置写入 `~/.gemini/config/agy-family-quota/credentials.json` 的 `proxy` 字段，目标为 localhost / 127.0.0.1 时自动绕过代理。`--upgrade` 会保留原代理，`--upgrade --no-proxy` 可移除。管理页「安装 / 更新」的安装弹窗也提供可选代理输入，只用于生成命令并保存在当前浏览器，不会上传服务器。

从本地仓库安装时示例：

```sh
node public/client/install.mjs --url https://YOUR-WORKER.workers.dev --proxy http://127.0.0.1:7897
```

安装器将：

- 合并 `~/.gemini/config/hooks.json`，保留其他 Hooks；注册 `PreInvocation`、`PostInvocation`、`Stop`。
- 将依赖为零的 Node Hook 和权限为 `0600` 的凭据写到 `~/.gemini/config/agy-family-quota/`。
- 合并 `~/.gemini/antigravity-cli/settings.json` 并设置 `useG1Credits: false`。
- Windows 下额外写入 `run.cmd` 启动器；安装完成前用目标 shell 试跑一次 Hook 并校验 JSON 输出（不发起网络请求、不写流水），自检失败即报错且不更新 `hooks.json`。
- 可选 `--proxy` 为配额请求配置本机 HTTP 代理；升级默认保留，`--no-proxy` 显式移除。
- 修改前备份原文件，后缀 `.backup-时间戳`；遇到无效 JSON 时停止，不覆盖原配置。

重启原生客户端。桌面端 / IDE 的 **AI Credit Overages → Never** 需要手动设置。全局 Hook 覆盖支持此协议的 App、CLI、IDE，但仍应分别做一次拦截验收。

卸载：

```sh
node public/client/install.mjs --uninstall
```

只移除 `family-quota-guard`；保留其他 Hooks、备份、待补记流水和关闭超额点数的设置。测试安装可用 `--home /tmp/isolated-home`，不会修改真实 HOME。

## 成员登录与安装教程

导航「教程」默认折叠前 3 步准备事项，突出第 4 步「复制安装提示词给我的 AI」。成员生成令牌后自动填入，也可粘贴已有令牌；提示词会带上当前服务地址与成员令牌，让能执行本机命令的 AI 助手完成环境检查、安装和静态配置验证。令牌只留在当前页面，刷新后清空；终端手动安装保留在折叠项中。

准备事项包含：母账号通过 Google 家庭组邀请最多 5 个子账号，成员接受邀请后，管理员在本站添加成员并绑定对应 Google 邮箱。Google 家庭组与本站成员需要分别添加，不会自动同步。

新增成员必须填写 `email`，大小写和首尾空白会归一化，同一邮箱不能重复绑定未删除成员。旧成员保留原令牌、限额与用量，在编辑中补绑邮箱即可启用 Google 登录。支持 Gmail 或其他已注册为 Google 账号的邮箱；不自动合并 Gmail 点号或 `+` 别名。母账号也可以添加自己的额度记录，用对应令牌安装，Google 登录仍保留管理员权限。

已绑定且启用的成员通过同一个 Google 登录入口进入，只有自己的额度、流水与安装令牌权限，不能管理其他成员、家庭策略或母账号。首次登录会固定 Google 身份 ID；修改绑定邮箱会清除该身份并撤销旧登录，暂停或删除后登录失效。成员授权不会替换或保存为母账号凭据。

成员在「教程」生成 / 重置自己的安装令牌（只显示一次），再复制安装命令。重置会让旧令牌立即失效，需要在使用此成员令牌的所有电脑上重新安装，操作前先等在途调用完成。

迁移 `0008_member_login.sql` 添加成员邮箱、Google 身份与成员会话表；部署时先应用迁移（`npm run deploy` 已包含此步骤）。本地开发运行 `npm run setup:local` 应用迁移。

## 配额模型与一致性

以百分比（`0`–`100%`）统一记账，不再使用虚拟积分。模型相对权重决定每次调用的**标准消耗当量** $u$：Gemini Flash 默认 1 倍，其他 Gemini 3 倍（Carbon ×0.75、Argon ×1.15）；Claude / GPT 3 倍（Haiku / Mini ×0.4），Claude Opus 8 倍；同时区分思考档位（Low ×0.6 / Medium ×1.0 / High ×1.5）。未知模型返回 422，客户端会暂停新调用并向 stderr 提示，需要在 `src/quota.ts` 更新分类。

两个模型池默认各有 **5 小时 100%、每周 100%** 的家庭配额上限，默认安全缓冲留白 `buffer_percent = 0%`。管理员可按百分比（如 A 50%、B 25%、C 25%）为成员分配份额；比例滑条支持 0–100% 按扣除缓冲后的家庭上限速算，也可对每个池与时间窗口单独微调百分比。给成员设置上限不会提前预扣家庭池额度。

### 请求前上下文感知预留与线性 Token 结算

- **请求前高分位预留（`/check`）**：结合本机转录或数据库上一轮已知会话上下文 Token 数 `contextTokens` 动态放大合理高分位预留当量（超过约 70k 上下文后平滑上浮），乘以当前窗口转换率的安全上界 $k_{\text{upper}}$ 冻结百分比。剩余配额不足以覆盖高消耗模型预留时直接拒绝，不再提供“最后一滴透支豁免”，但仍允许切换至预留装得下的轻量模型。
- **完成后线性无封顶结算（`/commit`）**：按真实 `input_tokens + 0.1 × cache_read_tokens + 5 × output_tokens + 500` 折算有效 Token（以 50k 有效 Token 为 1 倍基准），严格线性结算真实消耗当量，不设 `2.5x` 人工封顶，保证账本与真实 Token 消耗守恒对齐。

### 周期累积不等式区间校准

默认开启自动校准，两个模型池 × 两个时间窗口各自独立估计每标准当量消耗的官方比例区间 $[k_{\text{lower}}, k_{\text{est}}, k_{\text{upper}}]$，并以保守上界 $k_{\text{upper}}$ 参与准入和用量展示。没有有效样本时，1 当量初始保守上界对应 **5 小时额度的 0.1%**、**周额度的 0.025%**，且在等待官方首次批量跳变期间也会随安全累计当量自动向下收紧上界。

校准采用**周期累积守恒模型**：不再因分钟级 Cron 采样与进行中调用（`reserved`）重叠而丢弃锚点，而是持续累积周期起点以来的已完成当量 `done`，对在途预留 `pending` 与跨越边界调用 `span` 显式放宽区间不确定度，并对最近 20 秒内刚提交的记录施加延迟保护，防止上游百分比尚未刷新时低估 $k_{\text{upper}}$。遇到未记账突降、离线补记或额度回升时，先将已确认周期证据折入跨周期历史记忆（`hist_units` / `hist_fraction`），再重新锚定当前周期起点。

### 账期跟随官方 reset 与母账号门禁

每池的 5 小时和周用量分别跟随上游对应窗口的 `resetTime` 清零，保留历史流水、幂等身份和跨周期校准记忆。查询确认余额提前恢复到 100% 时也开启新账期；普通余额回升或单纯修改 reset 时间不会误清零。进行中的调用继续占用预留，完成后计入完成时所在的新账期。

母账号在 15 分钟容错宽限期内若跨越了已知的官方 `resetTime`，系统自动按重置后满额过渡，直至下一次成功同步。若母账号未连接、授权失效或连续超过 15 分钟无法同步，所有新调用暂停。迁移 `0012_percentage_quota.sql` 将旧版 250 / 2000 积分平滑换算为 0–100% 百分比份额，保留母账号加密凭据、管理员与成员登录会话及成员令牌哈希，并重置早期积分制计数表。

`/check` 在单条 `INSERT … SELECT` SQL 中汇总个人与家庭用量并原子预留，避免并发检查一起放行。预留计入两个窗口，默认 15 分钟有效。`/commit` 通过成员、会话、调用序号的联合唯一约束将预留转为实扣，重复发送不重复计费；实扣时间取**服务端收到完成记录的时间**，修改权重不会改变已有预留或历史账单。

`Stop` 仅在 `fullyIdle: true` 时释放同一会话尚未完成的预留，避免后台任务仍运行时提前释放。崩溃未触发 Stop 的预留自动过期。超时后才返回的调用仍会补记实际用量，可能导致预算短时超出；可在管理页将预留有效期调整至最长 1 小时。

客户端每次主请求网络超时为 5 秒；临时网络错误、HTTP 408 / 429 / 5xx 最多重试 2 次（总共最多 3 次尝试），重试使用同一调用标识和请求体，避免重复预留或扣分。退避等待为 200 / 400 毫秒，各加最多 99 毫秒随机抖动；遵守服务端 `Retry-After`，如果等待后无法在预算内完成下一次尝试则停止重试。鉴权失败、参数错误、额度不足和无效成功响应不重试。脚本硬截止为 16.5 秒，外层 Hook `timeout` 为 18 秒，避免外层提前杀死进程。安装提示词同时要求检查重试策略和这些时限。预检异常输出 `terminationBehavior: "terminate"` 暂停新调用；完成、释放异常仍输出 `{}`。完成记录在发送前写入本机待补记目录；后续 Hook 成功连接时最多尝试补记 10 条，每条补记只尝试一次、最多等待 700 毫秒，失败留待下次 Hook 补记，并受脚本总时限约束。只发送模型名、会话 ID、调用序号以及明确失败标志，**不会发送提示词、工作目录、转录路径或内容**。改变成员令牌或服务地址后，旧目标的待补记记录不会归到新目标，需在改变凭据前尽量完成同步。

响应的 `Server-Timing` 中，`app` 为 Worker 处理耗时（包括等待 D1），`/health` 额外提供 `sql` 数据库执行耗时，便于与客户端 DNS、TCP、TLS、首字节时间对照。可按自己的 D1 主库位置配置 Worker Placement，减少预检两轮数据库访问的跨洲往返；示例配置不固定地区。

## 能力边界

- 这是互信成员的客户端软限制，删除或修改 Hook 可以绕过，不是 Google 官方配额隔离或计费网关。
- 官方 `PostInvocation` 当前只定义“调用完成”，没有明确的 `success` / `error` 结果字段。因此当前实现按收到 PostInvocation 记账，不能承诺所有错误和取消都不扣分；若将来客户端提供明确失败标志，当前接口已支持释放预留。Stop 不会反向冲销已记账记录。
- 预留过期、丢失 PostInvocation、令牌更换前未同步都会限制统计的完整性。待补记文件丢失无法恢复；无人再次调用 Hook 时，也不会后台主动补记。
- 自定义积分权重无法精确反映上下文长短、思考档位、缓存命中等实际消耗，无法保证官方池永不触发限流。
- 删除成员会从成员列表移除并拒绝新预检，历史流水与已用家庭额度保留，进行中调用仍可完成记账或释放。迁移 `0006_member_deletion.sql` 添加删除标记。
- 暂停成员会拒绝新预检；已经发起的调用仍能提交和释放。重置令牌会让旧令牌立即失效，先确保在途调用完成。
- 账本保留历史记录以保证长期幂等，目前不自动删除；仅活跃窗口参与限额。长期使用应观察 D1 存储和查询配额。

## 验证

```sh
npm run check
```

使用真实 workerd / Miniflare D1 测试鉴权、Google 管理员绑定、OAuth 浏览器绑定与重放、Cookie 会话过期和退出、同源写保护、自动回调、双池权重、个人与家庭并发预留、官方 reset 与备用固定账期边界、动态比例采样与并发折算、超额阻断、预留释放、迟到补记、幂等和令牌轮换。Google 上游在测试中模拟，真实 Google 授权仍需各账号在浏览器完成。客户端测试覆盖隐私字段过滤、3 秒容错、离线补记、配置合并、备份、权限和卸载。

可选 UI 验收（需先启动本地服务）：

```sh
uv run --with playwright python tests/ui-smoke.py
uv run --with playwright python tests/ui-auth-smoke.py
uv run --with playwright python tests/ui-member-smoke.py
```

需已有 Playwright Chromium；可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定可执行文件。`ui-smoke.py` 使用浏览器内的确定性 API 夹具，覆盖成员增改、比例滑条与键盘速算、删除确认与失败重试、暂停、令牌重置、记录筛选、设置保存与还原、额度异常及响应式布局，不修改本地或生产数据库；`ui-auth-smoke.py` 模拟 Google 登录结果，验证 Cookie 登录、刷新与退出界面。新版 UI 验收截图保存在 `output/ui-refinement-2026-11-11/`，登录验收截图保存在 `test-results/`。`ui-member-smoke.py` 验证成员 Google 登录、权限导航、教程、令牌确认和 320/390px 布局，截图保存在 `output/playwright/member-onboarding/`。三项验收都应针对本地服务运行。

本机已安装 `agy` 时可运行 `node tests/native-smoke.mjs`：使用临时工作区 Hook 和零额度成员，验证原生 CLI 显示配额错误并以非零状态退出，不修改全局 Hook。会创建一个本地 `验收-原生拦截` 测试成员。

## 接口

| 方法与路径 | 认证 | 用途 |
| --- | --- | --- |
| `GET /health` | 无 | 服务与数据库连通性 |
| `POST /check` | 成员 Bearer | 校验并预留；返回原生 Hook 输出 |
| `POST /commit` | 成员 Bearer | 幂等实扣；明确失败则释放 |
| `POST /release` | 成员 Bearer | 释放闲置会话或指定调用的预留 |
| `GET /api/auth/status` | 无 | Google 登录可用性与当前会话状态 |
| `POST /api/auth/google/start` | 同源 | 创建绑定当前浏览器的 Google 授权会话（母账号或已绑定成员） |
| `POST /api/auth/google/finish` | 同源 + OAuth Cookie | 提交完整回调地址并建立后台会话 |
| `GET /api/auth/google/callback` | OAuth state + Cookie | 自有 Web client 自动回调，完成后跳转首页 |
| `POST /api/auth/logout` | 同源 | 撤销当前后台会话及待完成授权 |
| `GET /api/admin/overview` | 管理员 Cookie 或 Bearer | 策略、成员用量、最近 80 条流水 |
| `GET /api/member/overview` | 成员 Cookie | 家庭额度概况、自己的限额与最近 80 条个人流水 |
| `POST /api/member/rotate-token` | 成员 Cookie + 同源 | 重置自己的安装令牌，旧令牌立即失效 |
| `POST /api/admin/members` | 管理员 Cookie 或 Bearer | 创建成员（必填 name、email），返回一次性明文令牌 |
| `PATCH /api/admin/members/:id` | 管理员 Cookie 或 Bearer | 改名、绑定邮箱、限额、启停 |
| `DELETE /api/admin/members/:id` | 管理员 Cookie 或 Bearer | 删除成员，保留历史用量与在途结算 |
| `POST /api/admin/members/:id/rotate-token` | 管理员 Cookie 或 Bearer | 轮换成员令牌 |
| `PATCH /api/admin/policy` | 管理员 Cookie 或 Bearer | 家庭百分比上限、安全缓冲、模型相对权重、自动校准 |
| `POST /api/admin/mother/login` | 管理员 Cookie 或 Bearer | 创建一次性 Google 授权会话 |
| `POST /api/admin/mother/callback` | 管理员 Cookie 或 Bearer | 完成母账号授权并查询额度 |
| `POST /api/admin/mother/refresh` | 管理员 Cookie 或 Bearer | 立即查询真实额度并对账 |
| `DELETE /api/admin/mother` | 管理员 Cookie 或 Bearer | 删除云端母账号凭据 |

Hook 请求最小体：`{"modelName":"gemini-flash","conversationId":"a-stable-id","invocationNum":0}`。缺失幂等字段会拒绝记账，不会用空会话或第 0 轮兜底。HTTP 鉴权或服务错误仍由本地脚本暂停新调用；正常配额不足用 HTTP 200 返回 `terminationBehavior: "terminate"`。

## 官方依据（2026-11-11 核对）

- [Hooks 协议与全局路径](https://antigravity.google/docs/hooks/)
- [配置文件与 Hooks 加载规则](https://antigravity.google/docs/settings/)
- [模型组与 5h / 周配额](https://antigravity.google/docs/cli/commands/usage/)
- [CLI 点数设置](https://antigravity.google/docs/cli/credits/)
- [D1 数据库 API 与批处理](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 免费档与用量计费](https://developers.cloudflare.com/d1/platform/pricing/)
