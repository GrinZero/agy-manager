# Antigravity 家庭配额：现成项目比较

核查日期：2026-11-11。范围是保留 Antigravity 原生客户端，同时为家庭成员分配预算；以下只根据项目文档、许可证和源码核查，尚未安装或做真实账户联调。

## 结论

用户补充了不可接受账号封禁风险的约束，选型结论据此修正：**排除使用 Antigravity 消费者订阅凭据的第三方网关、反代与自动账号轮换；撤回优先验证 Sub2API 的建议。** 官方附加条款第 6 条明确将第三方工具使用 Antigravity OAuth 访问服务列为违约，并说明可暂停或终止 Antigravity／Gemini CLI 服务账号；官方公告也确认实际执行过封禁，重复违规可能永久封禁。见 [服务条款](https://antigravity.google/terms)、[官方 FAQ](https://antigravity.google/docs/faq/)、[封禁公告](https://discuss.ai.google.dev/t/update-on-antigravity-tos-ban/131424)。

在这个约束下，使用官方客户端和官方支持的 Hooks，仅向自建服务发送成员标识、模型与调用编号，执行自定义记账、提醒和阻断；不读取 Google OAuth 凭据，不调用内部配额接口。Hooks 是有文档的扩展机制，但这并不构成对具体实现“零封禁风险”的保证。没有找到符合这些边界、可直接替代家庭成员限额层的完整开源项目。见 [官方 Hooks 文档](https://antigravity.google/docs/hooks/)。

## 候选比较

| 项目 | 已核实能力 | 对本方案的价值与缺口 | 许可 |
| --- | --- | --- | --- |
| [antigravity-cli-check-usage-plugin](https://github.com/tanaikech/antigravity-cli-check-usage-plugin) | 原生 CLI 插件，使用 `PreInvocation`、`PostInvocation` 查询内部本地 RPC、低余额提醒 | 可参考 Hook 结构；不采用内部 RPC 配额查询，不能因其只读就认定获得官方授权；缺家庭成员账本 | README 声明 MIT；交付前还应核实独立 LICENSE 与依赖许可 |
| [OpenUsage](https://github.com/robinebers/openusage) | macOS 菜单栏用量监控，支持 Antigravity；当前使用独立 Google OAuth 授权 | 不列入本次低风险接入方案；没有找到监控用途的官方条款豁免，且不能执行成员限额 | [MIT](https://github.com/robinebers/openusage/blob/main/LICENSE) |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | 用户/API Key、用量计费、并发控制、管理后台；支持 Antigravity 上游和 Claude/Gemini 专用兼容端点 | 排除其 Antigravity 订阅转 API 路线；可单独评估连接正式授权 API 时的通用管理能力 | [LGPL-3.0-or-later](https://github.com/Wei-Shaw/sub2api/blob/main/LICENSE) |
| [Antigravity Tools / Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) | 账号额度看板、切换、额度保护、兼容 API 代理与账号调度 | 排除订阅反代、自动轮换；核查配置是单个 `api_key`，未找到每成员预算字段 | [CC BY-NC-SA 4.0](https://github.com/lbjlaq/Antigravity-Manager/blob/main/LICENSE)，有非商业限制 |

其他相关项目：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（[MIT](https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE)）提供兼容 API、认证和调度，不能仅因有 API Key 就认定有家庭成员预算。[LiteLLM 虚拟 Key](https://docs.litellm.ai/docs/proxy/virtual_keys)有 `max_budget` 与预算周期；[New API](https://github.com/QuantumNous/new-api)有用户、分组、额度和用量计费。本次未核实后两者能直接保留 Antigravity 原生 CLI 流量与登录方式，可能还需桥接层。许可分别是 [LiteLLM 核心 MIT、enterprise 单独许可](https://github.com/BerriAI/litellm/blob/main/LICENSE)与 [New API AGPL-3.0](https://github.com/QuantumNous/new-api/blob/main/LICENSE)。

## 需要保留的边界

- **真实配额与自定义积分分开。** 方案里的每次调用 1/3/8 分是本地政策，不是官方 token 消耗或订阅剩余额度。现成项目读取的实际额度，不能直接按这个比例换算。
- **网关模式改变调用路径。** Sub2API 文档提供 `/antigravity/v1/messages` 和 `/antigravity/v1beta/` 等兼容 API；这证明它支持 Antigravity 上游，不证明原生 agy 能通过修改地址继续完整使用。见 [Sub2API Antigravity 支持](https://github.com/Wei-Shaw/sub2api#antigravity-support)。
- **“额度限制”不必然严格防超额。** Sub2API 简化模式默认跳过计费；可选 Key 的 5 小时/日/7 日窗口默认未启用，文档明确它们属于请求完成后计算的软上限，并发中的请求可能超出最终金额。选型时必须验证所选运行模式和限制路径，不能把这项功能直接当作严格预留。见 [Simple Mode](https://github.com/Wei-Shaw/sub2api#simple-mode)。
- **部署架构不同。** Sub2API 使用 Go、PostgreSQL 和 Redis，不能把它原样当成现有 Workers + D1 项目部署。此处是另一个可选实现路线，而非换一个前端组件。见 [技术栈](https://github.com/Wei-Shaw/sub2api#tech-stack)。
- **开源与源码可见有差别。** Antigravity-Manager 的非商业许可应明确保留；若准备把家庭工具进一步商用或作为公开服务，不应当作 MIT 项目使用。[许可证原文](https://github.com/lbjlaq/Antigravity-Manager/blob/main/LICENSE)。

## 建议执行顺序

1. 官方客户端执行模型请求；官方 Hooks 调用自建 Cloudflare 服务做自定义积分预留、记账与阻断，服务无需 Google 凭据或 Antigravity 内部 API。
2. 用官方 `/usage` 查看真实配额，并关闭不需要的 AI Credit Overages。自定义账本与真实订阅消耗分别展示，不能保证二者严格对应。
3. 如果必须由服务端强制执行按成员的真实用量预算，另评估正式授权的 API／企业接入和通用网关；这会改变现有订阅与成本模型，不用家庭订阅 OAuth 反代。
4. 尚需实测确认家庭成员账户的真实配额关系、CLI Hooks 是否覆盖所有调用与失败场景；客户端 Hook 仍是可被本地用户移除的软限制。以上不是对官方家庭共享规则或请求成功扣费语义的独立确认。

源码核查补充：[OpenUsage 当前 provider 文档](https://github.com/robinebers/openusage/blob/main/docs/providers.md#antigravity)；[Antigravity-Manager ProxyConfig](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/src/proxy/config.rs)；[CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)；[LiteLLM 虚拟 Key 文档](https://docs.litellm.ai/docs/proxy/virtual_keys)；[New API README](https://github.com/QuantumNous/new-api/blob/main/README.md)。
