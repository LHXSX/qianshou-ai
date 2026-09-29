---
description: "查询千手算力能力、保存规划草稿，并以经过核验的文件运行本地任务插件。"
kind: "package-reference"
---

# 千手算力核心

[English](README.md) | 中文

## 概述

查询经过鉴权的算力目录，保存有上限的本地方案，向上海请求开发者最终任务报价，并查看任务进度和用户可见的内联结果。通过精确版本的本地插件执行已准入任务，核验输入和输出文件。取消会等待执行结束再移除临时文件。本机已登记执行器仍须启动前核对设备状态与权限；上海在线声明没有正式报价或等待时间，不能下单。目录条目不能证明节点在线、价格有效、正式报价或收益已结算。

## 目录

- [使用方式](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

已鉴权本地连接提供 `GET /api/qianshou/compute/plugin-drafts/comfy-trials` 查看最近状态，并可向 `POST /api/qianshou/compute/plugin-drafts/comfy-trials/reconcile` 提交不透明试跑 ID。恢复时只查询账本中原有的 Comfy `prompt_id`，从该结果取回并校验一张 PNG；不会再次调用 `/prompt` 或复用机主审批。查无结果时保持待对账并继续阻止该端口新试跑；明确执行失败才记为拒绝。旧账本若缺输出节点 ID，仍保持待人工复核。本机机主标记尚非账号身份，这两个入口不授权安装或公开接单。

-----

<a id="use-this-package"></a>
## 使用方式

对话模型接收完整历史，可通过只读工具分别查看本机已注册执行器、上海共享能力目录和算力池当前观察。它可以在原对话讨论任务、插件想法或分布式方案，不再先由单句关键词分类器选路。能力记录只用于规划，不授予执行权限；精确验包、机主确认、报价确认和上海任务准入仍由 Host 把关。

在提供已鉴权 Connection 服务的 Host 组合中挂载 `@deepseek-ai/dsh-compute-core`。如果智能体需要查询能力和保存本地方案，另外挂载 `@deepseek-ai/dsh-compute-core/tools`。核心不会自动添加这些工具，也不会另启智能体循环。 只检查状态的预设可在工具条目设置 `observationOnly: true`：保留能力和已有回执读取，隐藏 `compute_dispatch_chain`、`compute_plan_draft` 和 `compute_submit`。默认仍呈现这些由 Host 管理的规划工具；付费确认继续由机主单独操作。真实 Loader 组合测试覆盖挂载、本地路由、持久化、原生能力插件注册和结果消费。

`POST /api/qianshou/compute/plans/confirm` 仅把机主的 `approved` 或 `declined` 决定写进本机草稿，不能扣费。`POST /api/qianshou/compute/plans/quote` 预览上海最终任务、金额、余额是否足够、定价依据及有效期；返回值不含票据和最终规格，票据仅存于 Host 内存。旧 `plans/publish` 路由和模型工具首次提交均返回 `COMPUTE_QUOTE_CONFIRMATION_REQUIRED`。千手对话卡先展示草稿，再由机主同意方案，然后显示实时报价、完整文字输入、确切金额及有效期。只有独立的金额确认按钮会向已鉴权本地路由 `POST /api/qianshou/compute/plans/confirm-quoted` 提交 `{ id, quoteId, amount }`；模型工具没有此动作。Host 继续复核私有报价票据、当前机主、金额、时限、余额和持久提交账本。POST 结果不明时卡片不再提供重试，Host 也阻止为同草稿换键重发。`GET /api/qianshou/compute/workload?id=` 与结果路由仍仅用于读取。没有 `authorization` 或 `workloadId` 的旧文件分别按 `pending` 和 `null` 读取。

配置由[插件入口](src/index.ts)负责。目录读取优先使用已登录的 `accountSession` access token；`tokenEnv` 仍是无账号插件时的显式覆盖。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 空 | 核心 HTTPS 来源；空值禁用远端查询。 |
| `tokenEnv` | `QIANSHOU_CORE_TOKEN` | 可选的 access token 环境变量覆盖。已登录的 `accountSession` 令牌优先。 |
| `statePath` | `$DSH_HOME/qianshou/compute-plans.json` | 私有方案路径；任务尝试使用 `.tasks`、插件包装草稿使用 `.plugin-drafts` 同级文件。 |
| `timeoutMs` | `15000` | 完整上游请求的超时。 |
| `maxResponseBytes` | `1048576` | 上游 JSON 字节上限。 |
| `maxRequestBytes` | `65536` | 本地路由 JSON 字节上限。 |
| `maxDrafts` | `100` | 本地草稿保留上限。 |
| `maxStoreBytes` | `4194304` | 每个本地存储文件的字节上限。 |
| `maxTaskRecords` | `1000` | 本地任务尝试保留上限。 |

支持文件输入的市场技能复用同一个上传器。可选`POST /api/qianshou/compute/files/from-composer` 路由只解析指定活动会话已有的附件回执，核对整个有界选择，再由 PC 直接向 COS 发送文件。最多十五个文件、合计 16 MiB。草稿只保留经过验证的存储元数据，以便报价和恢复；上传不会创建订单或扣费。输入合同不支持或服务端价目缺失时，不能自动派单。

首帧图加自然语言的视频请求，需要上海当次任务类型目录明确给出 `capability_id=video.render` 和已审核的 `qianshou.reviewed-video-task-input.v1` 声明。声明把发布编号、已审核的 `qianshou.comfy-video-public-contract.v1` 摘要、`first_frame` 与 `input_manifest.files[0]`、文字槽与 `params.prompt` 逐一绑定。Host 建立本地草稿前检查这些语义、单张图片的格式与大小、不可变的上传对象版本和一致的描述，把用户确认时的发布编号与合同摘要作为预期值持久保存。首帧引用必须使用当前 Core 账号专用的已审核视频输入对象键；询价与付费提交前 Host 再次核对账号。Host 在询价与付费提交中发送同一份 `reviewed_publication`；若选了市场商品，还发送与视频审核发布编号一致的 `selected_product`，编号不一致就在本地拒绝建草稿。上海须同时核对两个绑定，才能完成端到端视频报价。询价和付费提交前重新读取目录，审核版本变化即拒绝旧草稿或报价，不发起收费任务。视频结果引用还须核对同账号的任务详情；受审任务只有冻结合同与 MP4 资产一致才返回链接，普通 WebM/MOV 任务仍可返回原链接。旧表单或未经审核的流程不会因名字或扩展名而走这条链。只有上海提供已审核声明且 Windows 执行器接收同一发布版本后，才能声称实际接单出片；现有 PC 测试仅验证候选协议。

`planCommerceImageWorkflow` v2 用调用方提供的已审核图片配方模型 ID 清单预览一个 `image.generate` 节点路线，清单不能为空。它不核验该配方是否已审核，不安装模型、不授权执行，也不调用出图提供方。图片路线本身不要求 H3；本机、市场节点和已审核云端提供方仍需分别完成产品接入。

### 私有出图试用

`imageTrial` 默认缺省。显式配置 `{ gatewayOrigin, tokenEnv, timeoutMs }` 后启用研究出图接口；地址必须为 `http://127.0.0.1:<port>`，用于运营者建立的广州 SSH 正向通道。`tokenEnv` 指定 Host 环境变量名，令牌不会进入响应或存储。八步超时默认 360000 毫秒，必须大于 300000 毫秒；12／20 步任务按采样步数比例增加等待预算，上游转发服务也需允许该长请求。状态接口只描述配置，不代表节点在线或已有官方价格。

可选的 `researchImage: { gatewayOrigin }` 将新的横屏八步对话请求送入上海的同账号免费研究队列。部署还须分别启用上海下发器和贡献电脑的任务消费者；API 探测可用本身不会执行任务。Host 在唯一一次元数据 POST 前保存原请求、会话、账号和广州精确 HTTPS 地址。超时或冷启动只查询原请求，即使该查询返回 404 也不重发。上海仅返回任务、尝试和原图引用；Host 使用私有账号凭据直接从广州读取对应 PNG，核验长度、SHA-256、PNG 结构和 2048 × 1152 尺寸后显示。已有 UUID 留在原通道；独立配置的方图、竖屏与 12／20 步试用继续使用原网关。已受理或结果未知的研究任务不回退到其他生成设备。排队、执行和结果未知的任务阻止更新重启；已完成原图的交付可仅通过 GET 恢复。这个固定免费通道不开放视频调度、跨账号任务、价格或结算。

机主 Connection 提供 `GET /api/qianshou/compute/image-trial/status`、`POST /api/qianshou/compute/image-trial/jobs`，以及指定 Session 的 `GET /api/qianshou/compute/image-trial/job` 和 `/image`。POST 接收不可变 UUID、活动 `sessionId`、提示词，以及 `square`、`landscape` 或 `portrait` 预设，分别对应 1024×1024、2048×1152 和 1152×2048 图片。可选 `steps` 仅接受 8、12、20，旧请求未提供时使用八步；状态上报 `supportedSteps: [8, 12, 20]`，各档位尺寸相同，同一 UUID 不可更改步数。Host 立即返回运行中回执，同一时间只接收一个任务；重复 UUID 和相同参数返回原回执，参数变化则拒绝。所有回执声明 `billing: research-no-charge`；此接口不会创建上海订单、报价或结算。

新回执在提交上游前持久化 `timing.submittedAt`，记录 Host 接受时间。等待网关出图响应时，`timing.phase` 为 `generating`；开始下载返回的 PNG 前变为 `receiving`。这些字段记录实际请求阶段，不代表采样进度或剩余时间。重复查询和界面重载保持同一起始时间；旧回执可以缺少 `timing`。Host 只校验文件完整性，不调用智能体评图。

最初向网关 POST 时若连接被拒绝，记录 `IMAGE_TRIAL_GATEWAY_UNAVAILABLE`，表示该连接没有送达模型请求。响应中断、超时或 Host 被中断仍记为结果未知。两种情况均不自动重新提交，原 UUID 保留原回执。智能体退出内存后，回执和图片查询仍可凭匹配的持久 Session 头读取；查询不会重开智能体或授权新提交。持久身份缺失或无法读取时拒绝访问，回执仍必须属于指定 Session。

Host 只向广州提交一次出图请求，只读取响应中受限的相对 `/img/5080/<file>.png` 路径，校验 PNG 完整性和实际尺寸后，将图片与回执保存到私有 `statePath + '.image-trial'` 目录。结果上限为 16 MiB。已有任务记录数和存储字节配置限制回执保留量；存储满时拒绝新试用。机主读取图片时重新校验摘要。重启后，运行中断的回执变为 `failed`，错误码为 `IMAGE_TRIAL_OUTCOME_UNKNOWN`，不重新提交。卸载时停止本地等待，不发出模型全局取消请求。运营者需要提供临时网关与节点隧道；此研究接口不会注册商业供给。

### 私有视频试用

`videoTrial` 默认缺省。显式 `{ gatewayOrigin, timeoutMs }` 可启用不计费的 H3 研究桥；地址必须是运维建立 SSH 转发的 `http://127.0.0.1:<port>`，完整等待默认 1800000 ms。`qianshou/image-trial.patch.yml` 和 `qianshou/video-trial.patch.yml` 都保留同账号免费 `researchImage` 路由，因为 Loader 的 config patch 会整体替换配置；部署特有的 compute 设置必须复制到所用 overlay。文字出片依赖已配置的图像接口及其 Host token；附一张 PNG/JPEG 首帧时不调用图像生成。

已拒绝的视频下载仅在用户明确查询原任务时重读（`retryDelivery=1`）。Host 通过 GET 复核原任务、已捕获配方身份及完整 MP4；恢复会话本身不重试已拒绝结果，也不重放生成 POST。

固定 24fps 试用要求 120 个视频样本。MP4 校验核对解码时间、显示偏移与编辑区间，仍拒绝损坏时间关系和不完整文件；容器检查不能代替原生播放验收。

既有机主鉴权 Connection 提供 `/api/qianshou/compute/video-trial/status`、`POST .../jobs`，以及按 Session 定位的 `GET .../job` 和 `GET .../video`。唯一接受档位为 `qs_new4`、`landscape_C`、4 步、5 秒、1344×768。提交前 Host 核对实时健康/spec 和首帧、recipe、模型 SHA-256 绑定；完成回执须确认相同 recipe/模型，MP4 必须符合请求的尺寸与时长。媒体校验检查容器元数据和采样字节范围，不派智能体审查，也不保证压缩帧可解码。输入和已核验 MP4 均限 16 MiB，并保存在私有 `.video-trial` 目录。

外部生成前 Host 先保存原 UUID、不可变输入指纹和首帧字节；浏览器仅保存不含媒体的引用。相同 UUID 返回已有回执。POST 结果未知时禁止重发，重启也不会重发；已有外部任务号可仅通过 GET 恢复，提交前中断保持未知。用户明确重出时，新 UUID 可引用已完成父任务保存的原首帧。阶段、耗时及可选上游进度均为观察事实。上游读取暂失败仍保留原编号，并明确提示等待原任务核对。每份回执均标为 `research-no-charge`；此桥不创建上海报价、订单、结算，也不登记正式供给。

### 原生法律文书候选

显式加载 `@deepseek-ai/dsh-compute-core/legal-document-plugin`，以准确模型名称和SHA-256 配置已安装在 PC 上的 Ollama 模型。插件默认关闭；只有实际模型身份校验和本机执行探测都通过，才注册 `legal.doc.bundle@1.0.0`。缺失配置不会授予执行器。`plugin_legal_document_template` 工具返回绑定此 provider 的私有创作配方，以及独立的`legal_doc_bundle_v1` 原生节点合同。

执行器读取经过验证的任务授权 TXT、Markdown、PDF 或 DOCX 附件，将十五份 Word草稿与清单打成一个 ZIP。虚构样例只证明文件结构和失败处理，不能证明专业法律质量；本机 provider 会拒绝无法独立核验的引用。买方上传要求显式配置 `inputStorageHostname`：PC 将文件直接上传到这个精确 COS 主机，上海只收到元数据。市场登记、跨机主附件授权、独立结果验证、法律定价和远端验收仍待接通；此原生合同不能替代现有 16 KiB QuickJS ABI。

千手 Host 组合已提供精确 COS 主机和默认关闭的原生 provider 加载入口。仅针对实际已安装模型设置 `QIANSHOU_LEGAL_PROVIDER_ENABLED=1`、`QIANSHOU_LEGAL_MODEL` 和`QIANSHOU_LEGAL_MODEL_SHA256`；可选 PDF 提取另需可执行文件及其摘要。上传完成的对象版本保留在草稿元数据里。`runAssignedTask` 把已审核标量表单转换成原生任务信封，调用统一的暂存、执行、验证、交付消费和清理流程；每个精确上传版本都需要已安装 Host 提供当前租约授权。缺版本文件和不匹配授权都会被拒绝。远端接单仍需新原生授权服务和独立设备证明；对话工具不能调用这个执行端口。

### 私有插件包装草稿

H3 原生声明锁定随包运行器、实际执行配方 SHA、模型字节 SHA 和私有配置摘要。纯 JSON 源包清单与运行器身份分开。`native-h3-device-proof` 只接受已按用途登记的 Ed25519 密钥，精确核对投稿、机主、已应答设备与上海合同快照，随后生成仅本进程有效、期限最多 300 秒的凭据。序列化副本、过期回执和身份变更均被拒绝。`native-h3-review` 核对独立、短期的审前挑战，不能替代已发布设备安装证明。`native-h3-presence` 核对独立的二十字段挑战，期限最多 120 秒，并绑定既有审核样例、原生配置与当前服务端签发的连接 UUID。在线续验不是新的 GPU 样例或审核通过。这些辅助模块不执行 GPU、不上传、不审核、不定价或结算。

鉴权后的 `native_h3_adapter_update` 帧携带请求 UUID 及最多十六项精确十四字段的原生声明，总量不超过 32 KiB。同一连接的应答必须匹配请求、当前服务端连接 UUID、accepted 状态和精确任务集合，随后才扩展该连接的原生任务范围；拒绝、迟到或不匹配的应答都不能启用。空声明只撤销原生范围，不移除普通任务范围。更新复用既有八项待应答上限与十秒截止，断线会拒绝待完成请求。这是元数据准入，不是出片或 GPU 回执。

`GET /api/qianshou/compute/plugin-drafts` 读取机主本地草稿。向同一路径 `POST` `{ "spec": { ... } }` 新建；带上返回的 `id` 可更新该草稿。`GET /api/qianshou/compute/plugin-drafts/export?id=...` 返回完整的私有设计草稿供机主备份。`GET /api/qianshou/compute/plugin-drafts/preview?id=...` 返回可下载的确定性结构打包计划、SHA-256 摘要和逐操作的本机检查。这些路由使用既有的机主鉴权连接，不访问插件市场、包管理器、模型、工作流或上海服务。

每份草稿有插件身份及最多 16 个自由命名的操作。每个操作声明带命名空间的模型、工作流或工具逻辑 ID，例如 `ollama:model-id`、`flow:workflow-id` 或 `tool:operation-id`，以及受限的输入输出 JSON Schema、权限、数据范围、可选网络来源、依赖和操作系统、架构、内存、磁盘、显存、输入输出大小与运行时长的拟定要求。Schema 根节点为对象；嵌套节点支持对象、数组、字符串、数值、整数、布尔和空值。对象必须提供 `properties`、`required`、`additionalProperties: false`；外部 `$ref` 和未知关键字会被拒绝。绑定引用不能是文件路径、URL 或命令。私有文件采用原子写入和仅机主可读权限。

保存和导出的回执始终为 `private-draft`、`installable: false`、`dispatchable: false`，适配器、真实探测、签名与审核都标为 `pending`。自由操作 ID 不会因此进入上海的能力注册表。导出物是设计草稿，不是 DSH 组合包或已签名的可安装 manifest。通用组合包安装或由机主授权的公开供给之前，还须实现运行时适配器、逐操作真机探测、隔离执行、包摘要与签名以及审核。

`HostPluginAdapterRegistry` 保存本机模型、工作流和工具的精确操作适配器。创作助手只读当前 Host 注册项；目录条目不能证明真实执行。私有候选要求草稿每项操作与适配器的绑定、输入输出 Schema 摘要、权限、数据范围、依赖、平台、架构和资产一致，并持有同一草稿版本近期由 Host 提交的样例摘要声明。卸载适配器或修改草稿会使声明失效。`plugin_draft_try_sample` 另取机主本次授权，在任何回调开始前核对全部输入，只调用已安装可信 Host 包登记的精确适配器，并在记录声明前核对真实输出。取消或超时会等待可信回调结清，途中失败会撤销本轮声明。纯数据压缩包经复验后保存在本机私有目录；回执不含样例或路径。样例输入输出可能含私人文字，分享包前须检查。候选和压缩包仍返回 `executionVerified: false`、`installable: false` 与 `dispatchable: false`：进程内受信样例不等于独立审核、任意第三方代码隔离或组合包安装。现有组合包安装器不能装载该压缩包。默认不登记通用适配器；已安装的私有 CSV 种子只是一个 Host 适配器例子，与 ComfyUI 无关。

经过复验的纯数据压缩包现可在保存草稿与每项当前可信 Host 适配器精确匹配时，仅为本机对话私用而启用。`plugin_private_activate` 针对确定的包和候选摘要请求机主逐次授权，再以原子写入保存仅机主可读的激活账本。`listPrivatePluginActivations()` 读取持久安装记录；压缩包、草稿版本或当前适配器缺失时标为不可用。`plugin_private_run` 对本次输入摘要另取机主授权，调用前重验制品、安装记录、活动适配器与 JSON Schema，只运行可信 Host 回调，最长两分钟。仅机主可读的调用账本先保留输入再运行；同一 Host 调用 ID 与输入已有完成结果时直接复用；新的机主授权调用 ID 可有意重复相同输入。失败后状态不明时阻止该操作自动重做。同一 Host 进程中同一适配器的样例与私用调用不能重叠。`plugin_private_uninstall` 在机主授权后删除确定的激活记录，并与进行中的私用调用串行；私有压缩包与调用历史保留在本机。压缩包不提供可执行代码；本路径不生成公开商品、上海能力、订单权限、销售或收费。Host 回调是进程内可信代码，不等于隔离第三方代码。`active-private` 只确认当前声明的绑定与 Schema 匹配，不证明活动实现的代码摘要或替换后 Host 实现经过独立审核。

`buildOfflinePluginDeclaration({ draft, capabilityIds })` 可准备广州投稿校验器接受的确定性、纯数据 `qianshou.declaration.v1` ZIP。调用方须为每项操作提供能力 ID；该库不推断上海登记，也不上传压缩包。导出内容不含样例、自由描述、绑定引用、资产或私人路径。广州 v1 格式无法表达网络目的地、依赖和工作区数据范围，因此导出器会拒绝使用这些特性的草稿，不会隐去它们。结果状态为 `built-offline-unsubmitted`，不等于已审核包、可安装组合包、许可或派单权限；客户端导出与上传尚未接通。

`buildReviewableExecutionArtifact()` 从多操作私有草稿、逐操作能力 ID 和完整程序生成有界、规范的 `qianshou.reviewable-execution.v1` JSON 字节。目前版本化执行器只接受随客户端实现的纯 `qianshou.string-map.v1` 解释器：程序将必填的平面字符串输入字段映射为必填输出字段，并做复制、去首尾空白或 ASCII 大小写转换。`verifyReviewableExecutionArtifact()` 对不可信字节重解析、核每项实现 SHA-256；`evaluateReviewableExecution()` 在运行包内程序前再次验包，不访问 Shell、文件、网络或模型。其他工具绑定、工作流、本机模型、权限、网络来源、依赖、工作区数据及非零设备要求都会被拒绝。制品不含草稿说明、样例、私人路径、模型权重和凭据；作者填写的字段名与插件 ID 仍须投稿前核对。它不是广州已有的 v1 ZIP、DSH 可安装包、签名发行物、许可证、市场商品或上海接单授权。

`plugin_reviewable_build` 核对精确的草稿版本，在仅机主可读、按内容摘要定位的目录中保存已验证的程序字节，只把 SHA-256 和状态返回给模型。`GET /api/qianshou/compute/plugin-drafts/reviewable-execution/export?sha256=...` 通过已有机主鉴权连接导出 JSON 候选，每次读取都重验磁盘字节和摘要。`plugin_reviewable_try_sample` 要求与候选摘要及样例摘要绑定的本次 Host 机主授权，再用内置纯解释器逐项试跑；样例输入和输出不会写进导出物。草稿版本过期、绑定不支持、磁盘文件被改动或样例缺失时会拒绝。这两步能制作并测试私有审核候选，但不使其获得审核、安装、发布、出售或接单资格。广州审核和发行契约须独立核验同一份字节，才能考虑市场权限。

`ComputeService.preparePrivatePluginSubmission()` 是仅供 Host 调用的导出入口。它要求精确草稿 ID 和版本、已持久化私有启用的两个摘要，以及每项操作显式填写的能力 ID。方法在持有私有制品与启用锁时重验样例压缩包、草稿、启用账本和当前可信适配器，只向 Host 调用方返回脱敏预览和声明 ZIP 字节。它不投稿、不授予许可，也不经模型工具、Connection 路由或 Client Remote 暴露私有样例包或声明 ZIP。未启用、草稿过期或制品被篡改时拒绝准备声明。

打包计划的摘要不受草稿 ID、时间戳和操作排列影响。计划只含结构性 ID、字段名、输入输出 Schema 摘要、权限与资源要求、依赖和网络来源的数量；不会收集源码、程序、模型权重、密钥文件、绑定引用、自由描述或 URL。本机只检查操作系统、架构、物理内存和空闲磁盘；无法测量磁盘时标为 `not-probed`。显存、本机模型/工作流绑定、依赖版本和实际运行仍未验证，因此没有发现硬件阻碍的计划也只是 `pending`，不能安装、发布、售卖或接单。机主填写的标识和字段名会保留在计划中，分享前应核对；完整草稿备份还含机主填写的自由文字。

智能体 preset 可以单独挂载 `@deepseek-ai/dsh-compute-core/plugin-draft-tools`，只获得 `plugin_draft_creation_context`、`plugin_draft_try_sample`、`plugin_reviewable_build`、`plugin_reviewable_try_sample`、`plugin_private_list`、`plugin_private_activate`、`plugin_private_run`、`plugin_private_uninstall`、`plugin_draft_mac_video_template`、`plugin_draft_model_candidates`、`plugin_draft_inspect_comfy_workflow`、`plugin_draft_probe_local_comfy`、`plugin_draft_preflight_comfy_workflow`、`plugin_draft_bind_comfy_workflow`、`plugin_draft_try_comfy_sample`、`plugin_draft_save`、`plugin_draft_install_mac_video`、`plugin_draft_read`、`plugin_draft_preview` 和插件创作提示；该入口不会带入 `compute_submit`。只读候选工具仅使用 Host 最近一次已完成的供给观察，选出状态不是 `unavailable` 的 `local-model`，返回逻辑 ID、名称、验证状态和观测时间。它不主动调用 `querySupplySnapshot`：该方法还会同步上海能力广告、写探测历史。之前没有观察时返回 `{ "observedAt": null, "models": [] }`，意思是未知，并非本机没有模型。缓存可能过时，`pending` 不表示模型可运行；工具不任意扫盘、下载模型、保存草稿或试跑推理。机主明确要求查看本机 ComfyUI 时，只读探测默认连接 `127.0.0.1:8188`，其他端口须机主提供；它限制 GET 响应大小、禁止重定向，只返回版本、显存、常见模型文件数量和最多 32 个机主指定节点类是否存在。它不返回模型文件名、系统状态原文、启动参数、工作流内容或任意 HTTP 正文。文件数量和节点存在均不证明可推理。机主提供 ComfyUI API 格式工作流时，独立的结构检查工具最多接收 256 KiB、128 个节点，只返回节点 ID、类名和候选字段名；它不返回提示词、模型文件名或其他字段值，也不读本机文件、连接 ComfyUI 或执行图。字段映射仍须机主确认。只有机主要求核对这份图在本机的选项时，工作流预检才通过同一有界回环 `object_info` 读取器查询最多 32 个不同节点类；只返回图摘要及每个节点类、直接模型选择器的真、假或未知，不返回提示词、模型文件名或原始节点资料。选项匹配不等于试跑推理。保存工具要求活跃智能体会话及机主主动要求或确认；Host 会拒绝未知字段、路径、URL、命令和无效 Schema。读取和预览只接受本地不透明草稿 ID；无 ID 的读取只返回简短清单。CEO 和专用创作助手 preset 已挂载该可选入口；真正的对话体验仍需真机验证。

固定的 `qianshou.mac-drawn-video@0.1.0` 配方保留独立的已审核组合包安装路径。`plugin_draft_mac_video_template` 返回已审核的精确设计；机主要求保存后，`plugin_draft_save` 将其存为普通私有草稿。`plugin_draft_install_mac_video` 只接受该草稿 ID 与版本，拒绝任何字段改动和其他适配器，检查 Mac 固定绘制工具，并以草稿版本和包 SHA-256 请求 Host 本次逐次授权。Host 从内置的已审核字节向机主资料目录写入固定压缩包与旁证，调用当前配置的插件管理器安装该本机包，再核对已安装压缩包、包文件、活动 Loader 与执行器。若安装要求重启，只报告待重启，不能称为已可用。这份未签名私有包不等于市场商品、公开能力声明、上海订单、售卖或收费；仍须由机主做真实本机试跑。通用创作路线还需要受审核的适配器模板、隔离打包、签名的 `qspkg` 提交、广州审核和绑定账号的上海准入；固定模板不会自动获得这些资格。

公开发行的生命周期仍是开发合同，不是已打通的功能：把机主确认的草稿操作绑定到受审核运行适配器；构建可复现的免费制品和逐操作试跑证据；签署 `qspkg` 声明并提交广州审核；把通过审核的商品关联发布者和明确许可；再进行压缩包检查、签名/依赖/模型/资源预检、本次机主安装授权、事务式安装与本机试跑，最后才考虑绑定账号的订单准入。定价、许可发放、提交、审核和上海准入属于独立服务，当前创作工具均不会调用。

日常任务里发现可复用流程时，智能体必须先看到可信的完成回执和可复现证据，才能建议制作插件；机主确认后才建立私有草稿。首批实现尚未把任务回执绑定到草稿：Host 无法验证模型任意填写的任务 ID，所以这种 ID 不能作为成功证明。候选工具只显示最近一次已完成本机供给观察里的模型；ComfyUI 服务探测只读回环元数据，结构检查只读取机主提供的图，工作流预检只为这份图读取有界的本机节点选项。自动发现工作流、通用生产适配器、可重复的推理验收、任意工作流打包、签名和审核仍是后续工作；下述本机单图只是隔离样例试跑。

绑定工具只接收机主提供的 API 图 JSON，不接收任意文件路径。它核对 256 KiB 图大小、128 节点上限、连线目标、标量输入、敏感字段名、路径、URL，以及机主确认的提示词与输出节点映射。写入前，Host 审批服务必须针对这份图的摘要与草稿版本返回一次带审计记录的 `allowed-once`；缺失或拒绝审批都不会改动草稿。规范化后的图与 SHA-256 保存在仅机主可读的本地草稿文件；没有绑定资产的旧版 v1 草稿仍可读取。智能体读取、配方导出和打包预览只显示摘要、节点数与 `stored-needs-trial` 状态，不返回提示词和模型文件名。图已保存仍需真实适配器与试跑，不是可执行、可安装或可售卖的插件；该工具不会调用 `/prompt`、向上海登记能力或发布到广州。

`plugin_draft_try_comfy_sample` 现允许创作助手在机主明确提出试跑、草稿已绑定输出为 `SaveImage` 的 API 图后，请求一次私有样例。模型只填写草稿和操作 ID 及映射后的样例输入；Host 从可信工具调用生成机主标识和幂等键，针对确切图/输入摘要要求活跃回合内的真实 `allowed-once` 逐次审批，并在任何 POST 前用 `ComfyPrivateTrialLedger` 原子占用幂等键。没有审批或机主拒绝就不执行。`PrivateComfyTrialHost` 通过固定回环的 ComfyUI 逐个预检节点类和直接引用的模型，只改机主确认映射的正反提示词、种子和尺寸字段，并用仅含本次精确 executor 的私有注册表执行。一次 `POST /prompt` 后仅查 `/history/{promptId}` 和历史结果指定的 `/view`；限制响应大小，校验唯一一张 8 位 RGB/RGBA PNG 的完整分块、尺寸及 SHA-256，再存入仅机主可读的目录。已鉴权的 `GET /api/qianshou/compute/plugin-drafts/comfy-trials/image?id=...` 只在核对机主、文件大小和摘要后返回已完成图片；创作会话展示图片或真实失败原因。回执仍明确 `installable: false`、`dispatchable: false`。POST 回包丢失或取消状态不明会保留在持久账本并阻止该端口的新试跑；不会自动重发或调用全局 `/interrupt`。该路径不会向上海登记能力、售卖或安装市场包、接单或收费。本机 Host 身份尚未与登录的千手账号绑定；目标 Comfy 版本核实及 Mac/Windows 真机试跑仍待完成，不能据此宣称产品就绪。

-----

机主私有的 `VideoWorkflowDraftStore` 接收有界的 ComfyUI API 图、已确认的提示词、可选首帧和帧数映射，以及一个 MP4 输出。列表只返回名称、模板、摘要和节点数，工作流内容保留在机主本机文件中。草稿始终为 `installable: false`、`dispatchable: false`。独立的 `qianshou.comfy-video-public-contract.v1` 解析器只描述具名任务输入、一个视频输出、资源限制和已审核摘要；规范图摘要将公开声明绑定到私有字节，不公开模型选择、提示词或路径。`ComfyVideoAttemptLedger` 在正在执行的任务租约下保存一次 Host 签发的提交和 ComfyUI 签发的 prompt ID；POST 结果不明会阻止再次预留，本机 MP4 核验也不同于平台结算。账本先在跨进程锁内持久记录 `reserved → submitting`，才允许唯一一次 `/prompt`；第二个调用方不能再花掉同一预留。POSIX 写入要求预先建好仅机主可访问的目录，并执行文件同步、重命名和父目录同步。Windows 尚未验证目录替换的断电持久性，因此预留前返回 `COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE`；此桥暂不能在 Windows 上提交真实 GPU 任务。上一任务完成本机 MP4 核验且状态为 `SETTLED` 后，或 `reserved` 尚未进入 POST 窗口且 Host 提供匹配的权威终态证据后显式释放，才可允许下一任务。`submitting` 等未知结果不能走此释放接口。生产级权威对账服务与恢复界面尚未接入，失败或未知提交仍可能阻塞整机。缺少新增证据字段的旧账本会安全拒绝，需要受控迁移。保存草稿或解析声明不代表已安装、已在本机执行、通过市场审核或取得接单资格。

`ComfyVideoSqliteAttemptLedger` 是独立的 Windows 本机账本；它不移除 JSON `ComfyVideoAttemptLedger` 的 Win32 拒绝，也不会让 Host 自动实例化账本。操作员须在接入任何任务前，显式调用一次 `provisionComfyVideoSqliteAttemptLedger`，在本地固定 NTFS 卷上全新的专用目录内建库。正常进程启动先调用 `recoverAtStartup` 再预约；数据库缺失、初始化中断或损坏时安全拒绝并留待人工核对，绝不重建空历史。SQLite 连接核对应用标识和结构，以 WAL 与 `synchronous=FULL` 先提交 `reserved`、再在唯一一次 `/prompt` 前提交 `submitting`。重启后的 `submitting` 或 `submitted` 属于未知结果，不能自动重试。本机进程崩溃、并发及 WAL/SHM 恢复测试不证明物理断电、控制器缓存丢失或数据库与 WAL 被移除时的持久性。此源码合同不表示生产 Host 已接线、已付费派单或已结算。

Windows 验收先将 `$env:QIANSHOU_WINDOWS_NTFS_TEST_ROOT` 设为已存在的本机 NTFS 目录，再运行 `pnpm exec vitest run packages/host/compute-core/tests/comfy-video-windows-ntfs-acceptance.spec.ts packages/host/compute-core/tests/comfy-video-sqlite-attempt-ledger.spec.ts`。回执须记录实际卷、进程退出、数据库与 WAL/SHM 状态及恢复后的账本状态；跳过用例不算验收证据。原 JSON 账本在 Win32 仍安全拒绝，单凭测试不能授权在生产 Host 中替换它。

独立的 Host 专用 `uploadEdgeVideoFile` 不改变现役 16 MiB 上传器。它用同一个打开的文件句柄核验 MP4 摘要，只把元数据交给上海的租约绑定预签接口，再把文件直接送到固定的 HTTPS 对象存储源；已审核视频路径当前每个结果限制 64 MiB。单次 PUT 返回真实 VersionId 后，认证的 Edge 连接先调用上海的精确版本 result-complete，并在响应完全匹配后才在同一连接登记 artifact。PUT 或 complete 结果不明时，不会自动再次 PUT 或重跑 GPU。候选仍默认关闭，须待签名订单、审核安装、存储和服务端门禁部署；本机测试不等于远端交付或 Windows NTFS 验收。

<a id="understand-the-implementation"></a>
### 显式原生 H3 V2

[V2 绑定](src/native-h3-binding.ts)将六个公开执行字段与设备的私有机主配置分开。固定 V2 ABI/运行时、真实配方、模型及首帧 SHA 共同决定逻辑绑定摘要。[V2 证据](src/native-h3-v2-evidence.ts)使用独立 schema 和签名用途：审核挑战十九字段、设备证明二十二字段、在线证明二十二字段、配置登记二十一字段。配置登记最长 300 秒，在线证明最长 120 秒，已发布设备证明最长 300 秒。V1 schema、用途和运行时摘要保持原样；V1 回执或 nonce 不能变成 V2 证据。

设备通过已鉴权的当前连接配置挑战和 CAS 修订登记私有摘要。配置改变以及改回旧字节都需要后续修订号。V2 原生适配器更新为十六字段，V1 仍为十四字段，两者共用十六条及 32 KiB 上限。只有当前 socket 的精确 ACK 才激活声明范围。

[普通 V2 任务租约](src/native-h3-task-lease.ts)是分开的十八字段顶层派单凭据，绑定投稿、源码、逻辑身份、私有摘要、修订号、设备密钥、连接及真实 worker/任务 attempt。鉴权传输先解析租约，HMAC 桥保存同进程原始凭据；买方参数不能生成或替换它。派单 account 是买方，租约 owner 是提供算力的作者。排队及执行中的任务重新核对固定元组，同连接同修订的新证明可以完成超过 300 秒的任务；变更后的元组不能替代旧 attempt。源码测试证明准入行为，不代表 Windows 出片或付费交付。

## 实现原理

<details>
<summary>实现与提供方职责</summary>

[服务](src/service.ts)把有上限的核心查询、本地持久化和受控原生执行串起来。能力插件在[执行器注册表](src/executor.ts)登记精确版本。[本地运行器](src/local-task-runner.ts)把经过授权的输入流暂存到随机私有目录，调用执行器，核验输出文件，并等结果消费者结束后清理。原生与传输提供方必须在返回之前停止全部子工作。本地路径和凭据不进入浏览器安全的[协议](src/protocol.ts)。

包入口仅以 Host 类型导出 `ComputeService`，供调用方命名必选的 `Context.computeCore` 合同；这不会新增 JavaScript 值导出或注册浏览器 Remote 方法。可选 `voiceActivity` 提供方仍只是观察来源；缺少提供方时，语音活动保持未知。

[任务授权验证器](src/envelope-security.ts)绑定 `qianshou.task.assignment.v1` 签名域、任务信封、尝试号、租约和派发方时间。只有它生成的冻结进程凭据才进入[协调器](src/employee-task-coordinator.ts)；复制 `verified` 标记不能取得准入授权。信任密钥和节点授权仍由调度适配器负责——而在交付的贡献者 profile 里，没有任何适配器提供它们：常驻节点装配的验证器就是 [inline Edge 桥](src/transport/inline-edge-bridge.ts)的进程内 HMAC 密钥，因此它的验签是自洽性检查，而不是平台授权。这里没有任何一处读取平台签名，真正决定准入的是对已鉴权链路的持有。所以节点状态投影里的 `productionGaps` 为空，并不构成「存在派单授权」的证据；`node-contributor` 会把依据（`gapsBasis`）发布在它旁边。公开包入口通过同一次多入口构建共享验证器注册表。

[inline Edge 桥](src/transport/inline-edge-bridge.ts)用进程内密钥对该 assignment fingerprint 做 HMAC，因为 Edge `shard_assign` 帧没有调度签名。它只接受带非空 `inline_input` 的 `input_kind: inline`，拒绝文件引用，并且从不拉取 `code_url`。`coreOrigin()` 返回已配置源站；`ownerAccountId()` 提供 Edge 所有者 id。`EdgeWorkerConnection` 的 `loopbackOnly` 默认为 true；HTTPS 调度源站传入 `false`。列入智能体会话的类型，包括 `word_count`，都在该会话里执行。`text.transform` 是同一落点，列出任一名字都会把两个都送进会话。`word_count` 只有两个名字都未列入会话时才在本地计数且不调用模型。贡献者必须同时点名 `isolatedProvider` 和 `isolatedModel`，隔离会话才会存在。

[传输连接器](src/node-transport.ts)解析已鉴权邀请，并使用显式限量的顺序队列。无效帧、队列溢出或消费者失败都会关闭会话；关闭会等待当前投递完成。出站帧按允许字段重新构建。具体传输仍负责 TLS、真实 worker 协议和地址。[能力 manifest](src/capability-manifest.ts)核对元数据与注册版本，不加载下载的代码。

[本地插件运行时](src/local-plugin-runtime.ts)是生命周期激活后的执行准入接缝。它在每次任务前把不可变 manifest 与由 Cordis effect 管理的执行器注册表重新核对；缺少执行器或仅声明远端运行时的插件会进入隔离状态，并且不会因为安装了文件就推断出能力。

[PC 任务面板](src/pc-task-surface.ts)把一份 `qianshou.agent-router.v1` 决策和可选的已解析本地回执投影成 `qianshou.pc-task-surface.v1`。本机路径和云端路径共用这张卡。`executionAuthorized` 与 `dispatchable` 保持为 false；主人批准只决定下一步是 `admit-local` 还是 `hand-off-cloud`。回执只出现在主人已批准的本机路径上，并且不包含结果字节、租约或扣费字段。

[常驻任务循环](src/resident-loop.ts)是与传输无关、由外部拉动的空闲智能体 tick 接缝。每次 tick 先发出已脱敏的心跳，再按顺序把已验证邀请交给协调器，并使用 `interactionPolicy: 'autonomous'`；重叠 tick 会按顺序排空，`close()` 会拒绝新任务。Host 适配器提供计时器、资源观察器、邀请队列和网络心跳。该接缝不会打开套接字、请求人为确认或执行插件代码。

[节点租约边界](src/node-lease.ts)为一次任务尝试明确记录所属节点、过期时间、撤销和幂等键。只有所属节点可以接受或完成租约，只有调度权限可以撤销；过期后接受会被拒绝。状态机是纯函数且状态不可变，作为未来传输/持久化适配器的合同，不携带媒体字节、本地路径、凭据、价格或上传地址。

[插件市场规划器](src/plugin-market.ts)会在返回冻结的暂存方案前核验解析后的 manifest、包摘要、宿主版本范围、显式权限和部署方提供的签名。它不会下载、解包、加载或执行包代码；后续事务式安装和进程隔离由部署适配器负责。GPU 与本地模型权限会标记为原生复核，上海继续只承担元数据控制面。

每个已声明的 Host JavaScript 导出都有明确的多入口构建配置，包括 `./fanout`。该子路径提供计划和结果合并合同，不执行任务或授予调度权限。构建导出回归检查把包的 manifest 与配置入口逐项核对，防止已声明路径从运行时构建中遗漏。

Host 构建完成后，在仓库根目录执行 `node --test packages/host/compute-core/tests/public-artifacts.test.mjs`，核验构建后公开入口间的 Ed25519 任务授权、原生 H3 子路径、根入口与子路径共享的原始原生租约凭据，以及构建后的 contributor/catalog 导入。`./native-h3-task-lease` 和 `./native-h3-v2-evidence` 都有明确的包导出和多入口产物；源码别名不能证明这些运行时入口存在。该检查消费构建产物，源码行为测试单独运行。包不发布运行时 `./invariant`，因为每个注册表与存储拥有自己的状态，没有另一个独立投影。

</details>

-----

### PC 任务卡

只有 Host 已核实路由事实时，才调用 `projectPcTaskSurface({ decision, ownerAuthorization, taskId, receipt })` 绘制状态卡。`ownerAuthorization` 取 `unavailable`、`pending`、`approved` 或 `denied`。`nextAction` 只指出下一步，不是运行、租约或扣费许可。旧的模型工具 `pc_route_card` 已撤下：它的本机／云端可用性及授权状态由模型自填，可能把未证实的线路显示为就绪。纯规划器和投影留待接入 Host 事实后再用。

| 代码 | HTTP | 条件 |
| --- | --- | --- |
| `COMPUTE_PC_TASK_SURFACE_INVALID` | 422 | 决策的版本、路径、状态、目标、原因或主人闸门不一致，或 `executionAuthorized` 不是严格的 false。 |
| `COMPUTE_PC_TASK_SURFACE_RECEIPT_MISMATCH` | 409 | 回执出现在未批准的本机路径之外，或任务标识不一致。 |

`parseLocalExecutionReceipt` 在回执本身带有租约、扣费或结算字段时仍抛出 `COMPUTE_EXECUTION_RECEIPT_INVALID`。

-----

### 结果资产验收

[`result-assets.ts`](src/result-assets.ts) 将已核验的本地输出文件转换为不可变的 `qianshou.result-assets.v1` 清单。它复用工作区核验器检查 SHA-256、字节数、普通文件归属和总量上限，然后要求每个输出都有受信的能力描述。描述声明有界 MIME 类型，可选的不透明 `evidence://`、`artifact://` 或 `urn:` 语义证据引用（可带摘要）。资产 ID 根据 `(taskId, idempotencyKey, name, sha256)` 确定生成，未来传输提供方可据此幂等去重。清单只为节点侧读取器保留本地路径；媒体字节和证据不会发送到上海，本包不上传、不查询对象存储，也不结算。


<a id="further-exploration"></a>
## 延伸阅读

- [Connection 载体](../../client/connection/README.zh.md) — 已鉴权本地路由。

-----

Workload 层的 `RUNNING` 回执不证明执行器已启动。`getWorkload` 可以读取绑定同一 workload 的已认证分片观察，补充 `executionStage`：等待派单为 `waiting`，RUNNING 且有当前 assignment 真实 `progress_at` 回执的分片为 `executing`，分片已完成而订单尚未完成为 `checking`。补充观察缺失或不兼容时不返回 stage，也不覆盖有效的 workload 状态；浏览器明确展示执行状态尚未确认。

## 绑定租约的文件传输

内部 `registrationOnly` 选项用空任务允许列表与精确的两个空执行能力数组认证设备挑战会话，只保留有界本机探测已经产生的硬件和工具事实；探测失败不补造 GPU、Python 或 H3，不增加 Hello 字段。同一连接的原生更新获准前，连接拒绝运行模式、派单及租约操作，resident 端口也拒绝带执行中任务或能力声明的心跳。传输状态 `ready` 表示已认证、可记录挑战。原生派单还须有该连接精确应答的原生任务范围，并通过当前机主授权；普通执行仍须使用其正常声明能力的会话。

候选文件消费者进入已有 resident 授权、attempt 与结果生命周期。只有单独验过的文件 provider 可以映射带 `file_contract` 的 offer，普通 offer 形状保持原样。元数据解析核对精确字段、SHA 绑定、归属和不可变版本，并限制深度 16、最多 256 个值及 8192 字节。

`EdgeWorkerConnection.readFileAttachment` 使用私有当前租约申请 `/api/v8/files/attachment-read-credential`，核对返回的所有身份与摘要，然后直读配置中的精确存储主机/版本并验证大小/SHA。`uploadFileArtifact` 将元数据发上海、字节直传存储，并保留确认的版本；只有该次实际上传的清单可作为结果返回。文件消费者在读取、上传与进度全程合并外部关闭及 attempt 信号，私有 workspace 仅写清单 JSON。独立用途登记、部署、已构建安装客户端和生产设备/任务/交付证据仍是各自独立门槛。

`readPinnedVideoFirstFrame` 是单独的 Host 候选读取器，只处理最多 16 MiB 的买家 PNG/JPEG 首帧；它要求买家账号路径、当前租约绑定的读取授权、精确对象版本、大小和 SHA-256，并检查图片头尾字节。原有文件运行器仍限制为 16 KiB。此读取器尚无生产图文 offer、图片读取授权接口或 Comfy resident 消费者；单元测试不证明 Windows 已交付素材。

`updateOwnerSupply` 是机主总开关及逐项服务控制使用的 Host 专用原子命令。它在策略队列内恢复已认证的 owner/node，只把本次模式或服务授权合并到真实提交策略；身份未知时的只读 `off` 投影从不作为写入来源。匹配绑定时保留其他授权、费率及资源限制。用户明确操作首次、旧无绑定或不同 owner/node 策略时，从空授权、空费率开始：模式操作不授权服务，服务操作保持模式关闭。独立客户端沿用本地策略。写入身份未知时拒绝，撤回上报后重新核对 owner/node；作者命令还保留原账号与 worker 断言。普通完整 `updateSupplyPolicy` 和 `updateBoundSupplyPolicy` 行为保持原样。

`updateBoundSupplyPolicy` 是 Host 专用作者操作。串行队列核对预期账号及 worker，撤回旧上报后重新读取 owner/node，并持久化捕获的原绑定。并发切换账号不能继承此前作者的供给权限。普通 `updateSupplyPolicy` 行为保持原样。

Workload 摘要保留有界数值进度或明确的空观察。中央 API 返回无时区创建时间时按 UTC 补全，再规范为 ISO 时刻交给浏览器。这些观察不授予重试或结算权限。

开发者任务报价失败仅在 estimate 入口对已知价目诊断作有界、精确分类。缺少价目与无效价目使用稳定公开错误码，任意上游内容仍不会透传给客户端；分类不创建任务、修改价目或授权扣费。

<a id="model-experience"></a>
## Model Experience

### 可选规划工具

#### What the model sees

千手 CEO 和插件创作助手预设显式加载算力工具。`compute_capability_landscape` 为自然对话提供一份按来源标注的只读观察：广州账号缓存的文本模型、上海实时语义目录、本机精确执行器和上一次本机供给探测。各来源分别保留观察时间与未知状态；这一览不证明当前健康、图片或视频可用、报价或接单准入。`compute_local_capabilities`、`compute_cloud_catalog` 和 `compute_capabilities` 仍可用于缩小范围；对有关的上海能力，`compute_pool` 再分别报告节点声明、当前可用数或查询不可达。相同的可记录工具链还提供本地方案草稿、账户与任务读取。`compute_submit` 只能读取已提交的方案；新付费订单仍必须经 Host 报价和机主按确切金额确认。能力描述仍是不可信参考文字。

#### Token effect

启用后工具 schema 加入智能体请求；只有实际调用的读取、草稿或回执加入工具结果。成功的 `compute_plan_draft` 还会把 `qianshou.task-card.v1` 观测写入 `tool/result.meta`，会话才能回放方案卡片。

#### KV Cache effect

目录数据变化时工具定义保持固定，实时数据进入已记录的结果。加载或卸载工具消费者会改变智能体的 schema 集合。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

部署接入仍承担以下责任：

- 私有目录、冻结信封与文件核验不等于 OS 沙箱，不能阻止有管理权限的操作或核验后的并发修改；原生插件需要进程隔离，资产服务器必须核验授权对象路径与摘要。
- 输入和传输提供方负责经鉴权的任务访问及取消。结果消费者须在返回前完成读取和上传，因为随后会删除任务目录。
- 常驻循环保持适配器无关。贡献者负责实际 worker 传输、任务租约和媒体上传适配器；其固定原生 H3 路径还要求当前机主与设备、配方与模型，以及独立设备安装证明。候选源码和隔离测试不能证明生产设备已加载这些接线或完成远端媒体交付。
- 已发布的 web profile 用上海源站和已登录账号会话读取目录。最终任务报价已有 Host 候选，但明确确认金额的界面和上海生产合同尚未发布；当前渲染器与模型工具不能付费提交。结算仍需单独接入。未知的开发者任务 POST 不会自动重试。目录不接受 `inline` 的会话目标会被拒绝。用户可见的结果 GET 是观测，不是结算。隔离节点智能体执行需要贡献者配置 `isolatedProvider` 和 `isolatedModel`；从不继承 CEO 默认路由。未设置隔离路由时 `word_count` 不调用模型；设置了该路由后它走隔离会话。未设置路由时，列出其他类型会在贡献者加载时失败。
- 价格、预算授权、付费提交、市场安装/签名与节点结算仍需独立验证接入。本地测试不能证明生产、移动真机或商店验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作备注</summary>

无。

</details>

### 明确区分 canonical H3 绑定

既有 `native-h3-binding` 子路径提供独立的 canonical 订单 ABI 和可移植联合类型。Canonical 声明沿用六项公开执行绑定及十三项声明字段，单独固定入口与 runner 的源码摘要。旧 V1 与固定 V2 解析器保留原运行时常量，拒绝新的 ABI。签名在场证明和原生套接字更新通过精确的可移植解析器读取绑定，原用途、身份元组、当前连接与有效期检查继续生效。

这表示软件源码支持。解析声明不会批准完整软件清单、计算图、模型或实际设备；部署方策略、独立审核、当前设备安装证明及实际租约仍须分别满足。103 项定向测试覆盖绑定、真实密码签名的在场证明样例及既有连接行为，不证明 canonical 生产套接字应答或 GPU 视频交付。

### 正式媒体对话候选

认证的本机 `/api/qianshou/compute/media/` 路由读取上海官方 `media-profiles`，为闭合十字段 `spec.media_input` 询价，再以稳定机主 `request_id` 确认确切人民币金额。浏览器只接收本地报价编号，`quote_token` 留在 Host 内存。确认时重新核对官方档位全部元数据和当前账号，保存意图后仅发送一次 `/api/v8/workloads` POST。响应不明时保持未知；恢复只查询原任务或账号请求索引，不重新派单。重启前未用的报价须由用户明确重新报价，再确认。

`formalMediaGatewayOrigin` 默认为空，只允许不含凭据、路径和查询参数的 HTTPS 源或 HTTP loopback 源。当前上海账号 access token 认证广州公开 `/v1/media/assets/ticket` 和 `/status`；Host 持有的签名上传票据只授权同源 `/upload`。PNG/JPEG 附件先作结构校验和摘要计算，限制 16 MiB。外部 POST 前 Host 保存原账号、Session、资产 UUID、角色和摘要，不保存图片字节或凭据。并发请求共享一次上传。结果不明时保留原编号，只查询状态，Loader 重启后也不重传。其他账号或 Session 的资产引用不能取得报价。 该源为空时仍可读取官方档位目录，但报价以 HTTP 503 `COMPUTE_MEDIA_DELIVERY_UNAVAILABLE` 拒绝、确认以 HTTP 409 `COMPUTE_MEDIA_CONFIRM_NOT_STARTED` 拒绝，均先于 estimate、账本或 workload POST。16 MiB 是附件输入上限；结果另限 64 MiB，正式图片按 4096 像素作检查。

已结算结果用上海私有 viewer grant 作为广州 `/media/result` 的 Bearer，不放进 URL。Host 核对当前任务、结算版本、账号、票据时限、字节长度和 SHA-256 后才返回媒体。正式结果沿用广州 64 MiB 上限和官方档位 4096 像素上限；MP4 按冻结档位检查样本范围、呈现时间、时长和帧数。PNG/JPEG 只作机械校验，不审查内容。独立研究接口保持 16 MiB 和首帧 2048 像素限制，并声明 `research-no-charge`。读取结果不会重新生成、结算或扣费。`formalMediaStatusPollMs` 是经校验的 500–60000 毫秒 Config 字段，默认 1500 毫秒，随任务观测投影给客户端。

真实 Loader HTTP 夹具覆盖报价确认、未知提交恢复、账号范围附件登记与未知上传恢复、结算后 PNG/MP4 交付、账号切换拒绝和坏字节拒绝。这些夹具与候选构建不能证明官方档位、合格设备、生产费率、收费 GPU 执行或 Windows GUI 已验收。`qianshou/windows-native-preflight.ps1` 只记录真实 Windows 设备与源码构建前置条件，不安装、生成或发布。

研究图像的唯一 POST 以原 image job UUID 作为 `Idempotency-Key`，视频生成首帧也沿用此规则。保留回执仍阻止响应不明或重启后的再次 POST；仅发送该请求头不代表旧桥已经转发或执行上游幂等。
