---
description: "千手插件市场，Mac 和 Windows 共用；另含只读的社区组合包发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-plugin-catalog

[English](README.md) | 中文

## 概述

提供 PC 插件市场，并发现社区组合包的精确版本。市场安装走现有插件管理器，并记下该条目声明的能力。Mac 和 Windows 调用同一个 Remote。


## 目录

- [使用此包](#doc-section-1)
- [插件市场](#doc-section-2)
- [已审核发行暂存](#doc-section-3)
- [安装预检](#doc-section-4)
- [我的能力与发布可见性](#doc-section-5)
- [理解实现](#doc-section-6)
- [延伸阅读](#doc-section-7)
- [启用作者自己的技能](#doc-section-8)
- [专用有界文件运行能力](#doc-section-9)
- [模型体验](#doc-section-10)
- [已知限制与延后工作](#doc-section-11)
- [开发备注](#dev-note)

<a id="doc-section-1"></a>
## 使用此包

千手组合以 `qianshouPluginCatalog` 装配经过主人认证的 Remote。插件管理页由主人明确打开发现目录；普通启动和本机清单读取不查询注册表。搜索只发送提供的关键词和偏移量，不发送账号密钥、会话内容或工作区路径。

`search({ query, offset })` 按 `dsh-plugin` 关键词搜索，并读取每个候选的精确版本 manifest。只返回包名/版本匹配且声明非空 `dsh.bundle.patch` 的条目。来源、观察时间、排除候选和读取失败的 manifest 分别记录。声明不能证明兼容、安全或执行成功。安装仍由现有插件管理器负责，经过明确确认和脚本批准流程。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `registryUrl` | `https://registry.npmjs.org/` | 部署方选择的 HTTPS 来源，不含凭据、查询参数或片段；允许自有测试注册表使用回环 HTTP。 |
| `timeoutMs` | `15000` | 一次完整搜索或市场接口读取的时限。 |
| `connection` | `shipped` | `shipped` 读取内置目录。`api` 读取 `GET {apiBaseUrl}/plugins`，并独立预览同源的 `GET /qianshou-market/releases`。 |
| `apiBaseUrl` | 空 | HTTPS 目录基址；自有测试服务器可用回环 HTTP。`connection` 为 `api` 时必填。广州需填 `https://<广州域名>/qianshou-market/`，使 `GET {apiBaseUrl}/plugins` 对上现有目录路由。 |
| `ordinarySkillsApiOrigin` | `https://app.qianshousuanli.com` | 独立的普通 `SKILL.md` 目录／投稿地址，验证为 HTTPS 或自有回环 HTTP。显式空字符串关闭其网络操作，不改变原 adapter 目录的 `connection` 模式。 |
| `installHome` | 空 | `qianshou/market-installed.json` 所在的绝对目录。空则使用 `DSH_HOME`，未设置时用 `~/.deepseek-harness`。 |
| `publisherKeys` | `{}` | 发布者 id 到 base64 SPKI 公钥的映射。没有登记公钥的发布者，无法通过从网络读到的条目的签名检查。 |
| `operatorKeys` | `{}` | 广州审核员 id 到 base64 SPKI Ed25519 公钥的映射。预览非空发行目录前，必须配置与发布者不同的两组公钥。 |

<a id="doc-section-2"></a>
## 插件市场

`listings()`、`installed()`、`preflight({ id })`、`installListing({ id })` 和 `removeListing({ id })` 是两台 PC 客户端共用的市场接口。`connection` 选择目录来源。内置「文章」的 `packageSpec` 为空：添加后只保存一条能力声明，不下载插件包。内置「图片」仍不可添加。

本机私有安装与对外接单准入分别处理。API 条目若声明 `installable: true` 且指定固定版本注册表包，无论能力种类都可以进入安装预检；发布者签名和设备检查必须通过，管理器才会安装。空包声明只允许精确匹配的内置「文章」。带包条目即使已在 Host 加载，仍是本机草稿，不能通过 `publishCapability`。因此真实视频或图片包可以先在本机安装试跑，不会被误报成上海可派单能力。

`api` 模式下，`listings()` 另带独立只读的 `releases` 预览、接口来源和 `available`/`unavailable` 状态。每一条都会限额解析，重新核对发布者和审核员两层 Ed25519 签名、固定版本身份、资料字段及 `verificationScope: opaque-archive-bytes`。接口缺失、响应无效、重复版本或未知签名者只会使发行预览不可用，不影响原来的 `/plugins`。发行预览不会进入 `listings`，不会产生插件包安装参数、登记能力或开启接单。预览 GET 不下载制品，也不向客户端暴露签名绑定的包摘要。

独立的 `officialCsvSeedStatus()` Remote 只读核对固定的 `qianshou.csv-profile@1.0.0` 签名发行和当前账号状态，不领取许可。`ready` 只表示发行与固定 Host 执行器一致，不代表已取得买家权利。机主确认页面显示的发行身份和摘要后，`installOfficialCsvSeedForOwner()` 免费领取绑定账号的许可，核对双签名、精确安装包和包内样例，再保存私有回执。重复点击会重新核对已有回执和在线许可。其他发行仍只供预览；该操作不写 `market-installed.json`，也不开启上海接单。内置模式、缺少两组信任公钥、未登录或发行验签失败时，入口保持关闭。

另一个内置的离线 CSV 种子是通用私有创作试跑的一个具体适配器。种子确实安装后，Host 才将固定操作合同和包摘要登记到 compute-core，登记到期前重新核对，每次运行仍重验安装字节。创作助手保存的草稿不能改写 Host 合同。通用 `plugin_draft_try_sample` 返回有界的真实样例输出及本机私有纯数据压缩包；它不授予线上买家许可、不安装另一插件、不发布，也不开启上海接单。此适配器只是工具、模型和工作流共用合同的一个例子，不要求媒体后端。

可选的 `privatePluginActivations()` Remote 只读 compute-core 当前通用私有插件激活账本，返回显示名称、精确包与候选摘要、各操作适配器身份，以及 `active-private` 或 `unavailable-private` 状态。缺少 compute-core 接口与账本为空分别报告。这份清单不混入公开目录、购买、`market-installed.json`、发布向导或上海接单供给。

`submitPrivatePluginDeclaration` 和 `listMyPrivatePluginSubmissions` 是独立的 Host 内部函数，对接广州 `POST /qianshou-market/submissions` Bearer 路由。`previewPrivatePluginSubmission` 从当前私有启用重新生成脱敏 `qianshou.declaration.v1` ZIP，只把账号、操作、权限、Schema 摘要、包大小和 SHA-256 交给页面；机主确认后，`submitPrivatePluginSubmission` 再生成并比对精确包与账号，才把 Host 内存中的 ZIP 交给投稿函数。Host 复制并复算 ZIP 摘要，在获取令牌前后和请求后核对账号，只使用运营方配置的 HTTPS 地址（仅测试允许回环 HTTP），不发送浏览器 Cookie，也不跟随重定向。返回的只是限额、账号绑定的回执；ZIP、令牌和完整 manifest 都不经 Remote 或模型返回。POST 后没有可信回执时状态为 `unknown`：不能自动重投，应先在同一账号下查询 `mine` 并比对包摘要。`declaration-reviewed` 回执必须通过运营方公钥验签，且账号、资料包与 manifest 身份完全匹配；它仅证明资料审核，不授予安装、出售或派单资格。客户端的确认流程已接线于源码，但需要新桌面包、运营方配置和真实账号验收。

<a id="doc-section-3"></a>
## 已审核发行暂存

`stageReviewedPluginArchive` 仅供 Host 内部调用，不属于市场 Remote 或页面。它重新读取双签名元数据，再用部署方提供的 Bearer 令牌请求单件 `GET /qianshou-market/releases?artifact=<releaseId>`。暂存位置必须是现存的绝对路径私有目录（`0700`）；请求只接受 HTTPS 或回环 HTTP、固定同源地址且不跟随重定向。响应长度和 SHA-256 头必须与签名元数据一致；边下载边限制字节数并复算摘要。随机独占的 `0600` `.qspkg` 文件只有在 ZIP 结构、条目路径、文件类型、大小、解压和 CRC 检查全部通过后才保留；失败或中断会清理。该测试令牌不是买家授权；服务端未配置可选令牌时，取包接口关闭。

暂存不解包、不核对可执行 manifest 或 Schema、不安装或激活代码、不写 `market-installed.json`、不发布能力，也不开启接单。发行项仍为 `installable: false`。正式安装还需约定包格式、买家授权、本机条件检查、执行器试跑与机主同意。聚焦验证命令：`pnpm exec vitest run packages/host/qianshou-plugin-catalog/tests/reviewed-staging.spec.ts packages/host/qianshou-plugin-catalog/tests/release-preview.spec.ts` 和 `pnpm exec tsc -p packages/host/qianshou-plugin-catalog/tsconfig.json --noEmit`。

仅 Host 内部使用的 Comfy 私有审核只接受暂存包里的 `manifest.json` 与 `comfy/workflow-api.json` 两个文件；再次核验双签名、整包与条目摘要、操作和 Schema 身份、受限纯数据执行图及固定执行器版本。不可变身份由 `releaseId + operationId + packageSha256 + manifestSha256 + graphSha256 + executorVersion` 构成。内部激活还要求可信的买家许可核验、机主当次批准、Comfy 节点与模型的实时检查，以及与该图精确绑定的执行器加载器；现有市场尚未接入这些能力。内部成功时只写入 `0600` 私有回执，`installable` 和 `dispatchable` 仍为 false；重启后不能只凭回执认定执行器可用。任一环节失败不会留下新回执，已加载的执行器也会释放。

`installListing` 从该来源读取条目，然后跑安装预检。非空的 `packageSpec` 必须是 `@publisher/writer@1.2.3` 这类固定版本的注册表包；本地路径、网址、标签与版本范围不能通过市场添加。它调用 `pluginManager.installBundle`，只有管理器返回同名包的 `applied`，且当前 profile 回读到相同已安装版本及活动中的 Host 行，才保存能力声明。需要重启、已取消或包身份不符时不写声明。重启后主人可再次点击添加：系统重新核验签名目录和活动包，同版本已激活的包无需重复下载。文件是 harness 主目录下的 `qianshou/market-installed.json`。只有机主公开的精确内置 `qianshou.article@1` 声明可以进入下一次 hello 的 `provided_capabilities`；包型条目不能仅凭相同的 `text.transform` id 借用内置运行器。`image.generate` 仍会显示，但获取会被拒绝，上海不会被告知这台电脑能画图。

`installed()` 是本机保存的声明账本。`installationActivity()` 另行回读当前 Host 管理器，核对包身份、版本和活动行，为每条记录返回 `active`、`inactive` 或 `unknown`。卸载包不会暗中删掉机主的草稿：声明继续保留，但市场和「我的能力」会显示包未激活，不把它计入已安装或可发布。旧的「文章」记录即使没有 `packageSpec`，仍按内置声明识别并保留原来的可见性；其他旧记录在重新核验或安装前保持状态未知。未知不会被当作已激活。

社区 `search` 不登记能力。包成功安装后也只保存本机草稿：Host 加载成功不等于接单执行器已绑定，所以包型条目不标为可对外声明，暂时不能通过 `publishCapability`。包安装失败或尚未在 Host 生效时，不写入能力声明，也不自动开启接单。需重启的安装结果留在现有插件管理器中供主人管理。hello 刷新失败时，已保存的文件留给下一次连接发送。

`removeListing({ id })` 只移除指定的一条内置能力声明，然后要求节点刷新 hello；它不卸载插件包，也不改变机主的接单策略。插件包及在线目录条目会以 `remove-unavailable` 被拒。客户端在显示结果前重新读取 `installed()`；重复移除返回 `removed: false`，机主重新检查后仍可添加。

<a id="doc-section-4"></a>
## 安装预检

`preflight({ id })` 按顺序跑四项检查——签名、依赖、模型、资源——不写任何东西。一旦失败就停下：后面的步骤停在 `not-checked`，报告给出失败的那一步、稳定的原因码，以及这一步看到的事实（`name=zod min=4.0.0`、`free=… required=…`）。失败的报告附带 `fix`、`recheck`、`cancel`、`rollback` 四个选项。

对没有插件包的内置条目，目录摘要仍会校验，摘要不一致会失败；摘要有效时界面把这一步标为 `not-applicable`，不会称作插件包验签通过。空依赖和空模型通道也标为 `not-applicable`；如果条目确实声明了要求，仍会检查且可能失败。资源检查继续显示实测结果。因此，一次可添加的能力声明可能有三项「不适用」、一项资源「通过」。

| 步骤 | 检查读到的东西 | 原因码 |
| --- | --- | --- |
| `signature` | 内置条目：本目录对该条目声明字段算出的 SHA-256。接口条目：发布者对同一段字节的 Ed25519 分离签名，用 `publisherKeys` 验签。 | `SIGNATURE_MISSING`、`SIGNATURE_DIGEST_MISMATCH`、`SIGNATURE_PUBLISHER_REQUIRED`、`SIGNATURE_PUBLISHER_UNKNOWN`、`SIGNATURE_INVALID`、`SIGNATURE_MALFORMED` |
| `dependencies` | 每个声明依赖的模块在本机能否解析，版本是否达到 `minimumVersion`。 | `DEPENDENCY_MISSING`、`DEPENDENCY_VERSION_LOW` |
| `model` | 声明的模型通道是否已在本次进程的 LLM 服务里注册；条目不声明模型通道时，这一步按无需模型通过。 | `MODEL_PROVIDER_MISSING`、`MODEL_ROUTE_MISSING` |
| `resources` | 声明文件所在目录的可用空间，以及本机物理内存。 | `RESOURCE_DISK_LOW`、`RESOURCE_MEMORY_LOW` |

`installListing` 在自己的写入链里再跑同一组四项检查，任一步不过就以 `preflight-failed` 拒绝，因此只有本机检查通过的条目才会写下声明。浏览器先调 `preflight` 把检查过程显示出来；获取那一刻的失败按同一份报告呈现。

`repairListing({ id })` 针对失败的那一步尝试修复，回答 `repaired`、`unchanged` 或 `unavailable`，并附上新一次的报告：签名步重新从来源读取条目；依赖步用 `pluginManager.installBundle` 装上缺失的模块；模型步和资源步回答 `owner-model-route`、`owner-free-space`，因为只有主人能注册通道或腾出磁盘。`rollbackListing({ id })` 卸掉修复装上的包，并把声明文件恢复到这条条目本次安装开始时捕获的字节；没有改动可恢复时回答 `declaration-unchanged`，而这次安装开始时本来就没有声明文件时回答 `no-previous-declaration` 并保留它写下的文件，因为这个市场不会靠删声明来撤销一次安装。取消是客户端丢掉这份报告，本机状态不变。

内置条目的摘要以常量形式写在源码里，`tests/preflight.spec.ts` 会重算它们：改了条目却忘了记下新摘要，测试就会失败，而不是把一条本机会拒绝安装的条目发出去。`image.generate` 在跑任何检查之前就已经被可安装性挡掉。

<a id="doc-section-5"></a>
## 我的能力与发布可见性

`myCapabilities()` 另行读取一项已审查的 Mac 私有视频运行能力，不写市场声明：只有本次调用同时核对精确安装包、并列回执、活动 Loader 行、已安装文件、Host 工具和对应执行器，才返回 `privateLocalCapabilities`。它只可经机主授权在本机试用；卸载或核验失败后不再出现在实时列表中。它不进入 `market-installed.json`、公开向导或节点 hello，也不能接上海订单。

`myCapabilities()` 只读本机保存的内容，不联系任何邀请接口。每条已保存的记录都带一个 `visibility`：

| 可见性 | 谁能看到这条声明 | 是否并入 hello |
| --- | --- | --- |
| `draft` | 只有这台电脑。字段缺失或本版本不认识时都读作这个值。 | 否 |
| `private` | 只有这台电脑。 | 否 |
| `invite` | 只有这台电脑，连同它旁边保存的账号 id。 | 否 |
| `public` | 这台电脑主动公开的声明。 | 是，且只有本机确实能接这项能力时才会 |

`installListing` 存下的是 `draft`，也不邀请任何人。发布之前的三个步骤——能力身份、运行预检、接单策略——都走 `saveCapabilityDraft({ id, inviteAccountIds })`：不管页面要求什么，这个调用写下的都是 `draft`，邀请账号 id 只存在这台电脑上，没有任何邀请请求离开本进程。最后一步 `publishCapability({ id, visibility, confirmPublic })` 目前只对内置能力声明开放：没有把 `confirmPublic` 传成 `true` 时，`public` 以 `publish-unconfirmed` 被拒；本机接不了的能力或包型条目以 `not-advertisable` 被拒；内置条目的四项安装检查会再跑一次。对已公开的记录再存一次草稿会要求节点重新发一次 hello，这就是把它撤回的动作。

`visibility` 不属于条目的声明字段，因此既不改内置条目的摘要，也不改发布者签名。

页面上的三个数字是带原因的 `unknown`，永远不是 `0`：本服务不测成功率、不测耗时、也不探测加速器显存，而 `0` 会变成一个没人测过却被当作测得的说法。本机确实实测的是「能不能接这项能力」、声明目录的可用空间和物理内存。接单策略这一步从已加载的 `computeCore` 服务读取主人保存的策略；没有加载时如实报未知。

`setOwnerSupplyEnabled({ enabled })` 是独立的机主接单总开关。owner/node 匹配时，它保留已保存的逐项服务授权、费率和资源限制，经 Host 专用原子 `computeCore.updateOwnerSupply` 命令写入：开启为 `idle`（空闲时接单），关闭为 `off`；首次使用默认关闭。关闭时还立即加上节点进程内的接单否决，开启则在 Host 策略写入成功后解除这一层否决。贡献者每次 tick 读取保存策略，Edge 会话在下一次心跳里发送实际推导出的 `running` 或 `paused`。本机保存 `idle` 不能证明上海已确认心跳或执行器可用；没有任何逐项服务授权时，界面明确提示暂无可接服务。

总开关与 `node` 服务开关从不写入公开的有效策略投影。计算控制器在队列内恢复精确 owner/node，只把本次字段合并到真实提交策略，撤回上报后再核对身份。同账号、同节点时保留其他授权、费率和限制；撤销 `node` 只删除它的授权及费率。用户明确操作首次、旧无绑定或不同 owner/node 策略时，从空授权、空费率开始，保留资源限制，只授权本次动作；单项服务动作保持总开关关闭。身份未知或缺少原子 Host 端口时拒绝，不回退完整策略写入。开启服务仍须通过新鲜本机探测及执行器可运行检查；作者启用通过同一命令保留原账号与 worker 断言。

`orderSources()` 独立于市场声明，读取 profile 中机主安装且可移除的插件包、两个用户技能目录及内建词频执行器；内置 Cordis 包不混入用户清单。清单不会执行尚未选择的插件。没有 `word_count` 任务适配的 SKILL.md、旧字符统计包和普通插件仍可显示，但不可授权；已装包的来源或名称不决定资格。适配包先静态核对 manifest、安装树摘要和 Loader 激活态，`selectOrderSource({ sourceId })` 才运行词频输出自检并选择执行器，`setLocalServiceEnabled({ serviceId: 'node', enabled: true })` 随后再次自检并保存逐项授权。切换前须撤销 `node` 授权且没有进行中任务，选择不自动开启总开关或服务。当前只支持内联 `word_count`；文件、图像、视频任务缺少已验证的资源直达节点输入与输出适配。市场安装记录不等于本机 Loader 安装或购买权益；compute-core 的 `nodeRates` 只是机主本地偏好，不是上海报价。商业接单还需签名报价、买家权益及真实上海受理回执；本机隔离测试不代表已收到付费订单。

买家接单商品读取器接受已签名的六文件 `qianshou.bar-chart-package.v4` 清单，以及按路径排序、含 4–128 个普通源码文件的 `qianshou.source-package.v1` 清单。两者都必须有受信发行者回执，绑定作者清单、归档版本和摘要。ZIP 读取器拒绝多余成员、链接、压缩、路径穿越和字节变更。验证后的文件只存入私有隔离区；源码暂存不会安装依赖、激活插件、出现在对话中，也不会向上海报告本机安装成功。

`installOrderAdapterProductLocally` 把已审阅的 v5 源包从隔离区复制到买家私有运行树，再核对每个已签文件及商品的执行身份，并在 macOS 隔离环境中运行真实样例。V5 是自包含包，固定的空锁文件没有第三方依赖可安装。本机自检通过只记录运行摘要，`deviceInstalled` 和 `orderAvailable` 仍为假。上海只接受独立运维可信签发方签出的设备安装回执；客户端不持该私钥，本机自检也不会自动打开机主接单总开关或声称已结算。旧 v4 媒体商品不进入此通用买家安装器。

作者身份在 POSIX 使用私有 0700/0600 目录和 Ed25519 密钥。Windows 改用 `owner-<id>.dpapi.json` 保存绑定当前 Windows 用户及平台账号附加熵的 DPAPI 密文；Windows 文件模式不能实施 POSIX 的所有权权限。保护操作只执行固定的系统 PowerShell 代码，标准输入和输出有界，参数与环境不含私钥。记录损坏、账号不符、目录 junction 或 DPAPI 不可用时均拒绝；不回退读取明文 PEM。真正的保护、签名、并发密钥稳定性与 junction 拒绝须在 Windows 原生测试，Mac 测试不能证明这些结果。作者声明签名不产生验包、审查、定价或执行回执。

V1 原生 H3 源码使用单独的元数据绑定，调用已审查的 Windows 执行器。V1 源码读取器保留 `qianshou.native-binding-package.v1` 的恰好四个规范化适配文件；不能混入执行源码、模型、私有配置或依赖。公开输入是中文视频描述、固定五秒及可选随机种子。运行器固定摘要、私有配置摘要、实际执行配方 SHA 和模型字节 SHA 共同组成不可变绑定，不能以工作流界面文件或模型 stat 替代。`verifiedNativeH3OrderBindings(workerId)` 仅在 Host 内使用，只有当前账号、已确认的 worker 及单独登记的 `orderNativeH3AttestorKeys` 验证专用设备证明后，才接受对应投稿。作者任务定义文件 SHA 与上海锁定合同 SHA 保持独立。缺少执行身份、专用公钥、协议路由或独立证据时，不声明原生已发布提供者。源码和单元检查不能证明 Windows 执行、生产准入或 Mac 交付。

锁定源码上传后，作者明确发布才会在当前设备排队执行两个独立签名核验样例。节点将真实 MP4 字节直接上传到签名的不可变对象存储租约，并报告设备专用签名；本机试用、核验证据已提交、管理员批准始终是不同状态。`orderNativeH3ChallengeKeys`、`orderNativeH3AttestorKeys`、`orderNativeH3UploadIssuanceKeys` 为独立用途的公钥。缺少配置时，只能从已配置 HTTPS 调度站的独立认证 `native-proof-trust` 接口发现，不能把投稿或上传响应内附的公钥当作信任根。已批准且绑定未变时，通过 120 秒签名在线挑战和当前真实连接见证续发最多 300 秒的设备证明，不重复运行 GPU。每次重新核对源码、配置空间、账号、令牌、连接、实际配方和模型身份；绑定变化需要重新独立核验。每台机器的路径保留在私有作者配置中，不进入技能市场包。

<a id="doc-section-6"></a>
### V2 原生创作与逐设备启用

显式原生创作工具现在要求独立核验的 V2 机主 provider。[源码构造](src/native-h3-order-source.ts)生成五个作者文件：`SKILL.md` 及四个规范 JSON 清单文件。V2 task type 由当前作者和公开逻辑摘要决定。精确十三字段声明和六字段公开绑定不含私有路径或机主摘要，`package_digest` 明确等于逻辑绑定摘要。V1 源码解析、清单和已发布身份继续保留原语义。

[设备配置登记](src/native-h3-device-config-http.ts)先读取当前 head，再签署独立签发的二十一字段 CAS 挑战，在实际 ACK socket 上见证并登记精确的拟定修订号。登记本身不授予接单。明确投稿或启用设备操作，只有满足现有服务端权威“缺少本设备样例”条件才可运行首轮独立双样例；不确定、待处理及传输失败都不触发渲染或重启。缓存复用还要求相同设备、连接、私有摘要及权威修订号。

V2 pending/binding 读取显式请求 `binding_version=2`，默认读取仍为 V1。精确二十二字段 feed 包含服务端当前设备密钥及连接。库存只执行 GET，不登记配置、续签在线证明、选择运行时、执行样例或授予接单。明确启用在现有机主授权前重新核对源码、新鲜本机身份、当前 head、证明及当前 socket 适配器 ACK。普通 V2 租约与买方输入及本机源码元数据分开。H3 配置向导、新 Windows GPU 试片及生产 V2 准入不能由这些源码/夹具检查推定完成。

## 理解实现

`registry.ts` 校验外部请求和元数据。每页最多十二个候选，最多同时读取四个 manifest，每个响应上限为 1 MiB。服务最多接纳两个搜索，拒绝重定向，释放时取消并等待所属网络读取结束。不涉及搜索缓存、包代码、安装进程或账号服务。

浏览器在搜索期间必须保留查询归属，不能把刷新失败显示为新读取的空市场。公开文本按文本展示；发布者身份和许可证仍属于注册表声明。

<a id="doc-section-7"></a>
## 延伸阅读

- [插件管理器](../../boot/plugin-manager/README.zh.md) 负责包变更和回滚。
- [插件管理界面](../../client/ui-plugin-manager/README.zh.md) 负责市场页。获取调用本包，不另开一套安装器。

<a id="doc-section-8"></a>
## 启用作者自己的技能

`activateAuthorOrderSkill({ source, name })` 从受控本机技能匹配当前账号已审核、已归档、已上架的商品。在申请专用的零元作者权益前，重新核对商品与投稿、任务类型、源码摘要的精确绑定。已有权益保留原价格和原状态，包括 unknown 与 refunded；这两种状态不会启动安装或创建第二份权益。

作者使用原有的受信归档、真实本机样例、独立挑战、已认证节点观察和中央服务器提交的设备回执。精确已安装的运行时直接恢复，不重复挑战。只有当前设备回执与本机字节验证通过后，才保存原有总开关和 `node` 授权，owner/node 匹配时保留其他授权及资源限制。源码改变、缺少证明、登录过期或上报失败均如实返回失败。旧的仅凭作者审核通过就宣布运行时的接口返回空清单。重启恢复读取服务器权益和本机字节，不信任界面缓存标记。下述专用文件路径要求单独的已安装证明；授权不保证订单或收入。

作者启用操作捕获原账号及已认证 worker。Host 专用绑定写入在同一串行持久化操作内核对二者，撤回旧上报后重新读取 owner/node，且只写原 owner 绑定。提交前切换账号或 worker 时拒绝，不保存新账号的总开关或 `node` 授权。普通机主开关请求保持原样。

<a id="doc-section-9"></a>

固定原生 H3 作者使用同一明确启用动作，但取得 `runtimeKind: 'native-h3'`、`deviceVerified: true` 与实际配置的 `runtimeDigest`；不会虚构商品编号、购买权益或已安装程序。必须先取得当前签名设备证明并重新读取固定 provider 的实际身份，再保存普通绑定总开关及 node 授权。只有经过鉴权的在线续验响应明确返回 `NATIVE_H3_DEVICE_SAMPLE_MISSING`，确认该设备没有审核历史时，这次明确动作才能排队并等待首轮两个独立样例。网络失败、已有待完成或结果未知的运行、普通冲突，都不授予 GPU 执行权，也不会重启旧 nonce。刷新与 `orderSources()` 仅读取源码绑定的原生身份、当前物理连接与证明、已保存机主策略；不会选择运行器、渲染样例或写授权。源码、账号、token、profile、连接或证明变化都会阻止返回启用成功回执。这些编排与模拟 provider 测试不代表新的 Windows GPU 出片或 Mac 交付。

原生启用通过 `refreshNativeH3OrderAdapters()` 在当前 ACK 连接同步已核验声明，避免调用普通已购适配器的重连操作而使连接绑定的证明失效。最终启用回执要求同一连接的精确服务端应答，以及应答后的源码、provider 和设备证明复验。库存另用只读 GET 读取已签发证明，不登记设备或续签 nonce。

## 专用有界文件运行能力

候选 `qianshou.quickjs-files.v1` 路径在固定 QuickJS WASM 内接受一个声明附件及一个输出，各自最多 16 KiB。`activatePurchasedOrderAdapter` 只根据已安装的已审 v3 声明选择文件路径。独立签名 `/file/` challenge 绑定账户、已认证设备、不可变归档、已审源码/runtime、合同、完整 fileSchema 和输入/输出字节清单；认证 worker WS 必须见证执行，上海随后才提交安装回执。本机样例不能单独产生文件 Hello。

`verifiedPurchasedFileOrderRuntimes` 在每次 Hello 前重验当前服务器安装状态及本机所有字节；读取持久专用证明时拒绝符号链接。文件签名根只来自 `orderFileAttestorKeys`，与 `orderNonFilePurposeKeys` 复用时拒绝。`orderArchiveHostname`、`orderFileAttestorHostname` 和 `orderFileStorageHostname` 必须是 core 主机之外的精确主机。缺配置时此 provider 返回空；普通 inline provider 继续排除文件声明。

执行使用冻结的 `file_contract` 与持有当前租约的连接端口。上海仅接收元数据，附件读取与结果 PUT 直达固定版本存储。Guest 只收到声明字节与逻辑输入。结果仍需独立文件 verifier 与结算。本段是候选源码测试；运行中的原生客户端没有重建或重启加载，用途根尚未登记，生产文件设备/任务回执及普通授权文件交付仍待验收。

`orderSources()` 通过 `authorPublication` 分别报告精确本机来源的技能批准和商品上架状态。未上架、商品待审、商品驳回或卖家账本不可用，都不会把已批准技能改成待审。买断 `salePriceYuan` 只取显式投稿价格或对应卖家商品，不用按任务收取的服务价补齐。读取失败时清单标记为不完整；读取期间账号变化，会撤销本次作者批准和设备观察结果；已认证 worker 变化只使设备资格失效，保留同一账号的技能批准。

作者资格读取现有已验证的内联与文件运行器，并匹配当前已上架商品、任务和本机产物摘要。读取清单不会安装、自检、领取权益、改变批准或授权接单。用户明确启用作者接单时，仍须经过签名安装、独立设备验证和机主授权。

作者本机试用保留失败状态，并返回有界校验事实：源码检查、原因、包内位置、修复说明和 `platformContacted: false`。本地拒绝不证明平台限制技能名称；符合 ABI 的通用技能名和机器任务标识无需在本机预登记。内置模板列出真实运行能力，QuickJS 包不含依赖安装树和旧 Node 入口。Node/Sharp/Pillow/Swift 媒体执行器需要自己的运行 ABI，动画计划或本机路径不能替代 GIF/MP4 交付。

本机试用表单读取仅按受控来源与名称查找当前清单，返回源码摘要与有界输入声明 JSON，不执行、不规范化源码，也不联系平台。用户明确执行与表单绑定的试用时，Host 重读源码，摘要变化即在执行前拒绝。文件合同明确报告尚无本机文件试用通道，不转成文字执行器运行。

写完技能后，`qianshou_skill_complete` 重新读取当前受控本机清单与实际普通文件，记录 SHA-256 并生成已保存技能操作元数据。存在通用运行声明只开放试用入口，不表示执行成功；`qianshou_try_local_skill` 成功元数据记录实际执行器源码摘要。两类回执分别表示本机文件或本机执行，与平台审核、上架及接单授权分开。缺失文件与失败试用不生成成功操作回执。

<a id="doc-section-10"></a>

## 模型体验

### 主人主动发现插件

#### 模型看到什么

`qianshouPluginCatalog.search` Remote 服务于主人的插件页面，不注册模型工具、提示词章节或会话消息。选择搜索结果只打开安装审查；后续安装的插件自行负责其面向模型的行为。

#### Token 影响

注册表查询与元数据校验不调用模型，不增加提示词 token。

#### KV 缓存影响

发现目录不重写会话历史，也不改变模型请求前缀。安装后的插件可能通过现有插件生命周期改变可用工具。

## 已知限制与延后工作

<a id="doc-section-11"></a>

- 私有投稿的审核状态必须使用预置的广州审核员公钥，对精确账号和插件包验签后才可信。驳回回执也须验签；未签名或被篡改的驳回不会作为事实展示，而会报告不可用。
- 来源是公开社区目录，不是千手审核市场。仅在 Git 发布或未带发现关键词的包可能无法检索。
- 只核验返回的当前页；注册表总数不是已验证可安装插件数量。元数据核验不执行插件功能，也不证明权限隔离。
- 搜索沿用注册表的相关性语义，可能返回相关候选，不保证关键词精确过滤；不能只过滤当前页便断言整个目录没有匹配项。
- 市场目前只把 `text.transform` 声明为可用。其余列出的能力仍然可见，在本机能够接单之前不会放进 hello。
- `myCapabilities()` 的加速器显存报未知：本包不跑 GPU 探测。那项测量归 [compute-core](../compute-core/README.zh.md) 的供给探测所有，这里不读它的结果。
- 安装预检只证明那一刻四项检查观察到的东西：模块能解析、模型通道已注册、磁盘和内存达到声明下限、签名与配置的公钥吻合。它不审查包代码、权限，也不保证安装后的行为。
- 注册表安装仍采用当前环境的包管理器配置，可能被包管理器自己的预检拒绝；那与上面四项检查是两回事。

<a id="dev-note"></a>
### 开发备注

无。

作者发布记录管理通过真实账号、精确投稿与服务器 revision 执行撤回、下架、归档和恢复。生命周期权限由上海返回；没有匹配本机源的云历史仅在明确的管理读取中可见，不授予本机执行器。归档保留合同、权益与账本，恢复只恢复列表显示。

`conversationPlugins()` 只从本机已安装可移除包及 Loader 行读取完整激活的插件，优先返回包管理器读取的中文展示名。它不读取投稿、商品、购买权益或设备记录，也不发单、不授权接单。对话选择时再次读取此清单；`orderSources()` 仍用于完整接单资格检查，并沿用同一展示名。

作者模板和本机拒绝后的修复指引区分机器字段名与表单名称：`properties` 和 `required` 使用 `text`、`result` 等 ASCII 标识，受支持的 `title` 可以显示中文名称。执行函数和样例使用同一机器字段名。字段规则中的 `description` 等未支持关键字仍会被拒绝；中文需求不会放宽 JSON 校验，也不要求用户手写 JSON。

旧市场技能的输入展示只通过现有账号授权的商品签名清单和锁定版本的 COS 对象校验读取源码，商品、任务、版本与制品身份必须精确匹配。内联 JSON 声明缺少字段规则时，至少两份结构一致的平面样例可以提供一个可填写文字字段与固定基本类型值；复杂或含糊样例不提供自动表单。这是展示元数据，不替换签名声明，也不保证任意专业参数可变。原有 JSON 大小校验与明确报价确认仍须保留。该读取只在 PC 内存中持有包字节，不安装、执行或恢复技能。

## 显式 canonical H3 目录分支

原生制作模板读取当前已配置的 provider，在准备前按真实 ABI 选择分支。canonical 软件使用 `qianshou.order-runtime.native-h3.canonical.v1` 及独立锁定的 API/runner 身份；canonical 准备失败不会回退到 Python V2 运行器。四文件源码清单、公共六字段绑定、V2 配置 revision、签名证据用途及租约合同保持原义，未知 ABI 或摘要仍拒绝。

签名绑定列表、样例编排及库存恢复按不可变声明的 ABI 分流。库存需要对应 provider 的新鲜身份、当前连接绑定的证据和真实适配器 ACK，不要求 V2 或 canonical 安装伪造一份 V1 身份。canonical 配置接口读取当前机主与 profile，检查本机 PNG 和回环服务，保存独立修订，并分别启动两次明确请求的本机试片。只有两次新鲜、独立核验的试片都通过，才能经共用导入器建立本机草稿。读取不会启动 GPU，也不授予设备登记、审核、市场发布或接单权限。Windows GPU 执行和 Mac 收片仍需当前设备回执。

## 普通 SKILL.md 投稿

机主 Remote 提供 `ordinarySkillChoices`、`ordinarySkillCatalog`、`ordinarySkillMine` 和 `submitOrdinarySkill`。`ordinarySkillsApiOrigin` 独立默认指向 `https://app.qianshousuanli.com`，显式空配置关闭网络；adapter 目录可继续使用 `connection: shipped`。未传此新字段的直接 constructor 调用保留已有 API 地址；没有 API 配置时使用普通技能官方地址。普通技能路由固定为 `/qianshou-market/skills`。发布只选择本机清单中的用户根技能，明确输入名称、简介和人民币小数售价；空价格不会变成零。不要求 adapter 声明，也不执行脚本。Host 捕获根目录含 `SKILL.md` 的普通文件 ZIP 快照，最多 128 文件、512 目录项、单文件 512 KiB、整体 2 MiB。隐藏文件、凭据及密钥文件不打包；符号链接、硬链接、路径碰撞和捕获期间变化会拒绝投稿。一次认证 POST 前，私有保存原机主、UUID、文本、售价和摘要，再向已配置的广州 `/qianshou-market/skills` 同源接口提交。技能包字节、本机路径和账号凭据不进入界面或持久意图。

响应不明、重复调用与 Loader 重启只查询原账号范围的 `mine` request UUID；服务端未找到也不会授权再次提交。广州工作人员拉取并人工测试不可变技能包后决定上架；Host 用固定员工 Ed25519 公钥验证上架或拒绝回执，将文件摘要、文本和售价逐项绑定。普通目录读取真实服务端列表与权威官方／用户作者分类。消费账本接通前明确不可购买、不可安装。Loader、HTTP、界面与真实广州源码互通夹具证明候选行为，不证明生产人工审核、付款、Windows 原生验收或发布。
