# Google 家庭成员 API：OAuth 与服务准入调查

> 历史调查记录：家庭组自动获取功能已按用户要求移除，当前版本只支持手动填写成员称呼和邮箱。下文接口和认证实现不属于当前产品功能。

调查日期：2026-11-11（Asia/Taipei）。本文件只记录家庭成员名册的接口、OAuth scope 和 Google 服务准入；不把 Family Link 设备控制能力等同于家庭名册。

## 当前结论

`kid.family.readonly` 和 `kidsmanagement/v1/families/mine/members` 的组合有 Google Chromium 官方源码依据。因此本项目使用这个 scope 与路径并非凭空猜测。另一方面，用户同意这个 scope，并不会自动给应用所属 Cloud 项目开通一个受限制的服务。[Chromium 固定版本源码](https://chromium.googlesource.com/chromium/src/+/6c574153ce9d11c14ebcfb2ef139111a9fd7de63/chrome/browser/supervised_user/child_accounts/family_info_fetcher.cc)、[Google Service Usage 公有与私有服务说明](https://docs.cloud.google.com/service-usage/docs/public-vs-private?hl=en)。

主会话实测已确认：现有家庭授权刷新成功，令牌包含 `kid.family.readonly`，令牌所属客户端与应用配置一致；成员请求返回 `403 SERVICE_DISABLED`。使用项目 Owner 本人的 gcloud 身份执行服务启用，仍返回 `AUTH_PERMISSION_DENIED`，而查询 `serviceusage.googleapis.com` 本身成功、状态为 `ENABLED`。这些是本次项目的直接观察，不是 Google 对所有第三方客户端的永久政策声明。

**可支持的判断：当前应用被家庭服务的启用或访问资格挡住，尚无证据表明是漏配家庭 scope。尚不能支持的判断：任何第三方客户端都永远无法读取家庭名册。**

### 不要混淆两套客户端的失败

主会话回查最早实验记录后确认，旧 Antigravity OAuth 客户端与新建家庭客户端没有失败在同一步：

| 身份与实验 | 实际失败 | 证明范围 |
| --- | --- | --- |
| 旧 Antigravity 客户端的现存 token 请求成员 | `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | 该 token 缺少成员接口接受的 scope；没有证明该客户端的 Kids 服务准入状态 |
| 旧客户端新增请求 `kid.family.readonly` | 授权入口返回 `restricted_client`，提示请求中的 scope 未注册 | 旧客户端当前无法申请这个 scope；没有拿到有效家庭 token，不能据此下结论说 Kids 服务未开放 |
| 新建家庭客户端 | 已取得家庭 scope；实际成员请求为 `SERVICE_DISABLED` | OAuth 权限获取已通过，当前失败在后续服务启用或访问资格 |

因此“旧客户端和新客户端都查不到家庭成员”只是结果概括，不能被改写为“两者都已证明没有 Kids API 准入”。这也解释了为何沿用能查配额的旧身份，并不自动解决家庭成员查询。

## 为什么项目 Owner 仍可能不能启用

Google 明确区分两种权限：

1. 在消费者自己的 Cloud 项目上启用服务，需要 `serviceusage.services.enable`。Google 的角色表把该权限列在 Owner 等角色中。[Service Usage IAM 权限表](https://docs.cloud.google.com/iam/docs/roles-permissions/serviceusage)。
2. 对私有服务，消费者还须先被服务方授予发现和使用权限；启用操作还涉及 `servicemanagement.services.bind`。自己项目上的 Owner 身份不能替代服务方的授权。[公有与私有服务](https://docs.cloud.google.com/service-usage/docs/public-vs-private?hl=en)。

Cloud Endpoints 的消费者文档给出的正常流程，是由服务管理员先授权消费者启用；若服务不出现在消费者的可用服务列表中，表示尚未被授予启用权限。[启用 API 文档](https://docs.cloud.google.com/endpoints/docs/openapi/enable-api)。服务管理方的授权操作针对该服务资源，而不是让消费者给自己项目多加一个 IAM 角色。[服务访问授权文档](https://docs.cloud.google.com/endpoints/docs/openapi/control-api-access)。

这套一般机制能解释当前现象，但 Google 没有在上述通用文档中点名 Kids Management API。因此“Kids 服务具体采用哪种资格名单、能否申请”仍需该服务的具体证据，不能仅由通用机制推定。

## Google 官方实现与公开目录

Chromium 的固定版本 `family_info_fetcher.cc` 同时给出家庭资料与成员路径，并在请求中使用家庭只读 scope 与 Bearer token。它证明 Google 自己的客户端使用这组协议；它不证明开发者可以注册一个全新 OAuth 客户端后直接取得相同服务资格。[源码](https://chromium.googlesource.com/chromium/src/+/6c574153ce9d11c14ebcfb2ef139111a9fd7de63/chrome/browser/supervised_user/child_accounts/family_info_fetcher.cc)。

当前 Chromium `fetcher_config.cc` 的网络注释仍把家庭名册读取归于 `kidsmanagement-pa.googleapis.com`，并说明请求以 Google 账号 OAuth access token 认证。[当前源码](https://chromium.googlesource.com/chromium/src/+/main/components/supervised_user/core/browser/fetcher_config.cc)。

本次直接请求 Google API Discovery 目录，得到 530 个条目；在名称、标题和说明中搜索 `kidsmanagement`、`family link`、`family group`、`families`，没有匹配。这说明在这次公开目录快照中没有发现对应 API，不是“接口不存在”的证明。[Discovery 目录](https://www.googleapis.com/discovery/v1/apis)。

## 官方 Issue Tracker 线索及局限

Google Issue Tracker 中存在开发者请求 **Allow developer access to family link API**，编号 302210616。其公开 dependencies 页面搜索快照显示状态为 **Won't fix (Intended behavior)**。主 issue 正文在本次浏览中只返回登录入口，因此没有核对到维护者评论的完整原文。[Issue 302210616](https://issuetracker.google.com/issues/302210616)、[可见 metadata 页面](https://issuetracker.google.com/issues/302210616/dependencies)。

它是“开发者开放 Family Link API 尚非普通自助开通功能”的相关官方线索；但请求可能涉及设备管控或 Android 系统信号，不能直接用其状态证明成人 Google 家庭名册绝无第三方访问方案。

## 尚未解决、可以继续验证的问题

- **是否有正式准入申请**：本次未找到 Kids Management 服务专属的公开申请表、合作伙伴计划或开通指南。若 Google 提供服务准入后，同一客户端、同一家庭 scope 的成员查询能返回真实数据，就能证伪“当前客户端永远做不到”的强结论。
- **是否存在独立的公开名册 API**：不能把 Workspace Directory、Cloud Identity Groups 或 People 联系人当作个人 Google 家庭组。需要一份明确覆盖 consumer family membership 的官方 API 契约，或可复现成功的实现。
- **第三方成功案例使用什么身份**：需要核验其实际代码与成功响应，分清自建 OAuth、复用 Google 第一方客户端身份、浏览器会话 Cookie 三类。只有第一类满足“自行注册客户端、用户授权一次、云端长期读取”的原始目标。
- **不要继续扩大 scope 来试运气**：当前响应为服务启用错误。可把最小家庭 scope 保持不变；若后续服务资格解决后出现 scope 错误，再依据新的返回处理。Google 对服务未启用与令牌权限不足有不同错误定义。[ErrorReason 官方定义](https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.api.ErrorReason)。

## 开源实现的认证方式与请求对照

主会话核对了三个直接相关实现：

| 项目 | 代码中的认证方式 | 是否证明自建 OAuth 可用 |
| --- | --- | --- |
| `tducret/familylink` | 从浏览器 Cookie 读取 `SAPISID`，构造 `SAPISIDHASH`，携带 Cookie；`get_members` 请求 `kidsmanagement-pa.clients6.google.com` 上的家庭成员路径 | 否；它证明的是基于浏览器登录会话的另一条实现路径 |
| `noiwid/HAFamilyLink` | 使用 Google 会话 Cookie，借助独立 Playwright 登录服务取得会话 | 否；它也不是把自建 OAuth refresh token 用于家庭名册 |
| `ludufre/g-family-link` | TypeScript 的 `Authenticator` 接收 Cookie，生成 `SAPISIDHASH`，请求同时携带 `Cookie`；`getFamilyMembers` 请求同一成员路径 | 否；语言和封装不同，仍是浏览器会话认证 |

来源：[familylink/client.py](https://github.com/tducret/familylink/blob/main/src/familylink/client.py)、[HAFamilyLink 仓库](https://github.com/noiwid/HAFamilyLink)、[g-family-link 认证源码](https://github.com/ludufre/g-family-link/blob/60e914c621f1854d2e28ec6c0ec56b84e38ce2b9/src/authenticator.ts)、[g-family-link 成员请求源码](https://github.com/ludufre/g-family-link/blob/60e914c621f1854d2e28ec6c0ec56b84e38ce2b9/src/api.ts)。这些是维护者自己的代码和文档；看到实现不等于已在本项目复现成功。本次没有执行这些项目，也没有提取或上传 Google 浏览器 Cookie。

为了排除“只是主机不对、漏了前端 API key”，主会话在本次已有的家庭 OAuth 授权范围内做了只读对照：

| 请求条件 | 结果 |
| --- | --- |
| 刷新当前家庭 OAuth 授权 | HTTP 200，返回 scope 包含 `kid.family.readonly` |
| 相同 access token 请求 `clients6.google.com` 的对应成员路径，仅 Bearer OAuth | HTTP 403，`SERVICE_DISABLED` |
| 相同请求再加开源代码中的公开 Web API key；没有 Cookie，也没有伪造 Origin | HTTP 400，`CONSUMER_INVALID`；Google 表示该 API key 与认证凭据属于不同项目 |

因此，已经测试的换主机和加该前端 key 均没有解决当前自建 OAuth 的问题。第三个结果说明这次请求不能把其他项目的前端 key 与现有 OAuth 凭据混用；不能把它推广成所有 Google API 的统一规则。Cookie 认证路线与原来要求的纯云端 OAuth 路线不同，若采用应明确告知用户实际认证机制。

## 调查边界

本次背景研究未读取或复制个人 token，未更改 Google 配置，未联系 Google 或其他人。当前报告中的项目实测结果来自主会话记录。Google 第一方源码、通用服务权限机制及三种开源会话实现已找到；第三方自建 OAuth 成功读取的案例及 Kids 服务具体准入路径尚未证实。Hipohipo 背景捕获工具 `source.parse_background` 在本次工具清单中未提供，因此依技能规则跳过外部捕获，没有发起登录或上传。
