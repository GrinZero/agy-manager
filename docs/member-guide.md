# 成员接入与客户端安装

[返回 README](../README.md)

## 手动添加成员

管理员进入「成员」页，点击「添加成员」，手动填写称呼、Google 账号邮箱和个人额度。成员使用绑定的邮箱登录后，可查看自己的额度与用量并生成安装令牌。修改邮箱会撤销该成员已有的登录会话；重复邮箱不能绑定其他成员。

本站不自动获取或同步 Google 家庭成员，也不申请家庭组读取权限。Google 家庭组邀请和本站成员添加分别完成。升级时，迁移 `0010_remove_family_connection.sql` 会移除旧的家庭组授权、待完成授权和候选成员快照；已有成员、邮箱、预算、用量及配额连接保留。

## 给成员安装

在管理页添加成员，复制一次性展示的成员令牌和安装命令。电脑需有 Node.js，支持 macOS / Linux / Windows。安装 / 更新命令按成员电脑的系统分两套（页面上有选择器）：macOS / Linux 用 `curl` + `/tmp` + 单引号，Windows 用 `curl.exe` + 相对文件名 + 不带引号的 URL；Windows PowerShell 5.1 把 `curl` 别名成了 `Invoke-WebRequest`，所以必须显式用 `curl.exe`，且两行命令不用 `&&` 连接。

Windows 下安装器会在守门员目录写入 `run.cmd` 启动器（用 `%~dp0` 自定位脚本、Node 路径失效时回退到 PATH 中的 `node`），`hooks.json` 用它作为相对路径命令，避免 `cmd /c` 解析带空格的绝对路径时静默失败。安装结束前会用目标 shell 实际试跑一次 Hook 并校验输出是合法 JSON，只有打印「Hook 自检通过」才算成功；自检失败不会写入 `hooks.json`。从旧版安装升级时请重新运行安装器（或「更新本地守门员」）并重启客户端，否则 Hooks 不会执行、管理页「记录」也不会有流水。

也可在本仓库运行：

```sh
node public/client/install.mjs --url https://YOUR-WORKER.workers.dev
```

安装器会提示粘贴成员令牌，输入隐藏。无人值守安装用 `--token-file /absolute/path/to/token`，不要把令牌放进命令行或 URL。

管理页 `/#manual` 是面向成员的「守门员使用手册」，按成员电脑的系统生成安装、更新、带代理更新、取消代理和 `/health` 测速五条命令，并附参数速查与常见问题。

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
