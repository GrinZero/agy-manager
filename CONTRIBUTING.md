# 开发与验证

[返回 README](README.md)

## 本地运行

需要 Node.js 22.12+（推荐 24 LTS）。

```sh
npm ci
npm run dev
```

首次运行使用公开的 `wrangler.jsonc`。`npm run dev` 启动前会自动检查本地密钥并补齐数据库迁移；已有密钥、成员和调用记录会保留。已有本机部署配置 `wrangler.json` 时，Wrangler 会优先使用该文件。

打开 http://127.0.0.1:8787。在 `.dev.vars` 配置 `ADMIN_GOOGLE_EMAIL=母账号邮箱` 后，可直接点击「使用 Google 账号登录」。也可在备用入口使用 `.dev.vars` 自动生成的 `ADMIN_TOKEN`，连接一次母账号后自动绑定其管理员身份。Google 登录使用 HttpOnly Cookie 保留 7 天，刷新页面无需重新登录；退出会撤销当前会话。`.dev.vars` 已加入 `.gitignore`。

页面可添加成员、通过比例滑条速算或单独微调双池百分比限额、暂停使用、删除成员、重置成员令牌、查看流水，以及调整家庭百分比预算、安全缓冲留白、模型相对权重与自动区间校准开关。成员令牌只显示一次；数据库仅保存 SHA-256 哈希。

## 验证

```sh
npm run check
```

使用真实 workerd / Miniflare D1 测试鉴权、Google 管理员绑定、OAuth 浏览器绑定与重放、Cookie 会话过期和退出、同源写保护、自动回调、双池权重、个人与家庭并发预留、官方 reset 与备用固定账期边界、动态比例采样与并发折算、超额阻断、预留释放、迟到补记、幂等和令牌轮换。Google 上游在测试中模拟，真实 Google 授权仍需各账号在浏览器完成。客户端测试覆盖隐私字段过滤、6.5 秒慢连接、16 秒共享重试预算、慢网络离线补记、配置合并、备份、权限和卸载。

修改「手册」页时，`tests/manual.test.mjs` 会校验页面 ID、路由、复制按钮目标和跨平台命令写法；`npm run check` 已包含这些检查。

可选 UI 验收（需先启动本地服务）：

```sh
uv run --with playwright python tests/ui-smoke.py
uv run --with playwright python tests/ui-auth-smoke.py
uv run --with playwright python tests/ui-member-smoke.py
```

需已有 Playwright Chromium；可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定可执行文件。`ui-smoke.py` 使用浏览器内的确定性 API 夹具，覆盖成员增改、比例滑条与键盘速算、删除确认与失败重试、暂停、令牌重置、记录筛选、设置保存与还原、额度异常及响应式布局，不修改本地或生产数据库；`ui-auth-smoke.py` 模拟 Google 登录结果，验证 Cookie 登录、刷新与退出界面。新版 UI 验收截图保存在 `output/ui-refinement-2026-11-11/`，登录验收截图保存在 `test-results/`。`ui-member-smoke.py` 验证成员 Google 登录、权限导航、教程、令牌确认和 320/390px 布局，截图保存在 `output/playwright/member-onboarding/`。三项验收都应针对本地服务运行。

本机已安装 `agy` 时可运行 `node tests/native-smoke.mjs`：使用临时工作区 Hook 和零额度成员，验证原生 CLI 显示配额错误并以非零状态退出，不修改全局 Hook。会创建一个本地 `验收-原生拦截` 测试成员。
