# 接口参考

[返回 README](../README.md)

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
| `GET /api/member/token` | Google 登录 Cookie | 查看绑定到当前 Google 账号的安装令牌。旧令牌尚未保存原文时返回 `{"token":null}` |
| `POST /api/member/token` | Google 登录 Cookie + 同源 | 验证并保存自己的原有令牌，请求体为 `{"token":"…"}` |
| `POST /api/member/rotate-token` | Google 登录 Cookie + 同源 | 重置绑定到当前 Google 账号的安装令牌，旧令牌立即失效 |
| `POST /api/admin/members` | 管理员 Cookie 或 Bearer | 创建成员（必填 name、email），返回初始安装令牌 |
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
