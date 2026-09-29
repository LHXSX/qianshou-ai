---
description: "千手模型网关与公开的只读插件目录。"
kind: "package-library"
---

# @deepseek-ai/dsh-host-model-gateway

[English](README.md) | 中文

## 广州媒体节点连接

能力广告和 `envelope.spec.media_input` 的 `profile_version` 均为至少 1 的严格整数（须在 JavaScript 安全整数范围内），与上海官方 profile 版本一致。`"1"` 等字符串、布尔值和小数均拒绝。派单信封必须使用上海封闭的 `media_input` 字段：capability、mode、prompt、negative_prompt、quality、orientation、seconds、assets、profile_id、profile_version；negative_prompt/assets/图像秒数沿用上海可选默认值。`spec.task_type` 须匹配 `image_generate` 或 `video_generate`。资产角色须符合模式；拒绝隐藏旧输入、params、执行 URL 与冗余生成。信封中的调用方 billing/non_billable/price/charge 声明及派单请求额外字段均拒绝；零价或试用标签不能获得授权或改变结算行为。

显式配置 `mediaNodes` 才向既有 `webServer` 挂载节点路由；省略时不挂载。配置包括绝对私有 `0700` 目录下的 `storePath`、固定上海 HTTPS `accountApiOrigin`、`heartbeatIntervalMs`、至少为间隔两倍的 `heartbeatTimeoutMs` 与 `maxLongPollRequests`。私有试验可用 15000/45000 毫秒及最多 64 个轮询。SQLite 为 `0600`，只存凭据摘要，需要本仓库支持的 Node 22.19+；当前实验 API 提示属于预期。每库仅支持一个网关实例，生产多实例协同和保留期限须另接部署机制。

节点控制路由使用 POST JSON，拒绝浏览器 Origin/Cookie、重复 Authorization、压缩及超过 128 KiB 的正文，不使用广州浏览器主人会话。`/v1/nodes/register` 核验当前请求的上海账号 Bearer，接收 `{deviceId,deviceToken,adapterVersion,capabilityRevision,capabilities,maxConcurrency}`。Host 注册前生成并私有保存 32 字节 base64url 设备令牌；相同重试保留 epoch。profile 含 `profile_id`、`profile_version`、`model_sha256`、`workflow_sha256`、`validation_receipt_sha256`。同 revision 改数据或改变主人/凭据绑定均冲突。注册返回相同令牌与 `{ok,deviceId,connectionId,connectionEpoch,heartbeatIntervalMs,heartbeatTimeoutMs}`。

其他路由使用设备 Bearer。`/reconnect` 接收 `{deviceId,capabilityRevision}`，推进 epoch 并返回连接字段。`/channel` 接收 `{deviceId,connectionEpoch,afterSequence,waitMs}`，`0 ≤ waitMs ≤ 25000`，返回连接字段以及 `online`、`sequence`、`tasks`。任务字段为 `{sequence,deviceId,taskId,attemptId,leaseEpoch,leaseExpiresAt,quoteId,authorizationId,envelope,stage,expired}`。新 epoch 首次快照也返回已保存 cursor 之前的未终任务。Host 须对账已有 attempt/外部 jobId，逐项写盘才推进 cursor；恢复不授权再次 POST 模型。`/heartbeat` 接收 `{deviceId,connectionEpoch,capabilityRevision,freeSlots,runningAttemptIds,freeVramMb,availableSeconds}`，返回 epoch/online。只有已恢复的当前 epoch 可报告供给；超时空闲槽为零；未决 attempt 即使租约过期仍占槽。`/disconnect` 接收 `{deviceId,connectionEpoch}`，立即撤回供给并保留任务。`/events` 接收 `{deviceId,connectionEpoch,taskId,attemptId,leaseEpoch,sequence,stage,percent?}`。percent 须为真实上游 0–100 有限值。事件幂等、绑定租约且不能倒退阶段或节点终态；模型完成仅到 `awaiting_settlement`，不能完成订单或扣费。

`dispatchCredentialRef` 指定上海内部元数据入口的服务凭据引用。持久全局事件流水提供读取/确认页、原任务对账、独立Ed25519结果入库与幂等结算通知。正式派单核验上海完整签名的买家/贡献者/任务/租约/冻结价格绑定；未知提交不创建第二attempt。`exchangeOrigin`/`exchangeCredentialRef`只连接既有广州媒体验真服务。目录默认能力自报、不可用；新鲜独立正式回执可为精确device/owner/profile授予资格，上海继续执行供给政策。

设备绑定input-read票据在有效lease下保留原买家/角色/版本，有界代理验证完整长度及SHA。order-current relay上海fullspec签名，task-status恢复原verdict/settlement；官方runtime安装manifest及owner/device/worker精确资格缺受审发行/模型许可材料即关闭。源码候选提供买家账号绑定资产票据、设备原任务结果上传票据与有界原始bytes上传，不下发服务或COS凭据。既有Python服务负责不可变版本文件核验与签名结果交付。正式发行目录、明确profile费率及真实设备验收必须存在，缺证据则目录不可用。详见 [正式媒体合同](../../../deploy/native-h3-20260927/FORMAL-MEDIA-PORT.md) 与 [连接决策](../../../.agents/notes/implemented/architecture/2026-09-29-guangzhou-media-node-channel.zh.md)。H3 18802仍是独立试用桥；源码、loopback与隔离CPU解码检查均不证明生产部署或Windows原生验收。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/media-control-feed.node-test.mjs packages/host/model-gateway/tests/media-node-channel.node-test.mjs packages/host/model-gateway/tests/plugin-license-bearer.node-test.mjs` 检查控制、恢复、身份与资产载体。

## 插件目录接口

宿主提供 `webServer` 时，网关注册公开只读接口 `GET /qianshou-market/plugins`。运营方未配置 `marketCatalogPath` 时返回 `{ "listings": [] }`；该配置必须是审核后 JSON 文件的绝对路径。接口位于 `/api` 之外，因为 Mac 插件目录请求不携带浏览器登录 Cookie。其他 HTTP 方法返回 405。已配置文件不可读、超限或无效时返回 503，不公开部分条目。

文件包含 `version: 1` 和最多 100 条 `listings`。每条使用 Mac `MarketListing` 字段：`id`、`title`、`summary`、`capabilityId`、`version`、`packageSpec`、`installable`、`requirements`。所有条目必须声明 `installable: false`。`requirements.signature` 必须是 `{ kind: "publisher", publisher, value }`，其中签名使用 Ed25519，对 Mac 插件目录的 `declarationBytes` 内容签署。`marketPublisherKeys` 是发布者 ID 到 base64 SPKI DER 公钥的映射。服务端逐条验签，任何一条不合格就拒绝整个文件。价格等未定义字段同样拒绝。私钥不得放进宿主配置或目录文件。

Mac 的 `qianshou-plugin-catalog` 使用 API 模式时，配置 `connection: "api"`、`apiBaseUrl: "https://<广州域名>/qianshou-market/"`，并配置相同的可信 `publisherKeys`。结尾斜杠不可省略：Mac 使用相对路径 `plugins`。外层反向代理还须把 `/qianshou-market/plugins` 转发到 DSH 的 `webServer`；此源码没有配置反向代理。Mac 会再次验证响应和签名，请求不携带浏览器凭据。

该目录只展示已审核的元数据。源码中没有已审核的商品目录；这个接口不证明插件可安装或可在本机执行，也没有定价、购买、发布者投稿、接单能力。后续开放写入前，需要商品审核、可执行能力验证、购买权益记录和机主授权。

### 发布版本与制品校验候选

另有独立的 `GET /qianshou-market/releases` 源码候选。未配置 `marketReleaseRegistryPath` 时返回 `{ "releases": [] }`，且所有返回条目固定 `installable: false`。运营方配置绝对路径的版本登记文件、`marketArtifactDir`、`marketPublisherKeys` 与 `marketOperatorKeys` 后，服务端逐条核验：

- `pluginId + version` 与 `releaseId` 唯一；版本号、制品 SHA-256、字节数、系统/架构、操作的能力 ID、执行器种类、输入输出 Schema 摘要和权限清单均在签名范围内。
- 发布者 Ed25519 签署版本内容；审核员另用受信任公钥签署相同版本、发布者证明和审核编号。只填写“已签名”或作者名称不能通过。
- `marketArtifactDir/<packageSha256>.qspkg` 必须是真实普通文件，大小和逐字节 SHA-256 均匹配；符号链接、缺包、改包和签名错误会使**整份登记文件**返回 503。制品目录需 `0700`，制品文件需 `0600`，登记文件不能被组或其他用户写入。当前上限为单包 512 MiB、总制品 1 GiB、登记文件 1 MiB、100 个版本。
- 运行时在登记文件旁保存 `<registryPath>.lock.json`（可由 `marketReleaseLockPath` 指定，权限 `0600`）。已经公开过的 `pluginId + version` 不能改摘要、签名、审核内容或从登记文件删除；锁文件随发布备份一起保存。上线前需验证锁文件的备份/恢复和单写实例部署。

响应中的 `verificationScope: "opaque-archive-bytes"` 由服务端固定生成：通用发布目录只证明 `.qspkg` 原始文件字节与双签名符合登记值，不替代客户端 ZIP、执行器和权限验证。隔离客户端可使用显式配置的 `marketArtifactAccessToken` 作为静态测试 Bearer；它不是购买许可，不能打入普通用户安装包。元数据仍公开且所有版本固定为 `installable: false`。发布者和审核员私钥不能进入服务配置。签名字节格式由 `pluginReleasePayload` 与 `pluginApprovalPayload` 固定。公开路由还未证明已被广州线上反向代理转发。对公网开放前仍需压测、限速和多实例一致性验证。

### 首个免费种子插件

`POST /api/qianshou/ai/plugins/submissions` 提供受服务端身份核验的 `submit`、`mine`、`pending`、`approve`、`approve-declaration`、`reject` 操作。必须显式配置私有的 `marketSubmissionStagingDir`、版本登记与制品目录、受信任 Ed25519 公钥，以及将发布者/审核员签名 ID 绑定到真实账号的 `marketPublisherAccounts`、`marketOperatorAccounts`，否则不能投稿或审核。发布者提交 base64 包及标题、简介，服务端记录已核验账号。原有 `qianshou.csv-profile` v1 固定五文件 ZIP 仍是唯一允许执行 `approve` 的格式：服务端拒绝路径穿越、额外条目、软链接和压缩炸弹，核对原始输入输出 JSON Schema 摘要；审批时重新核对暂存归档以及独立双签覆盖的平台、架构、操作、摘要和权限，再原子追加不可替换版本。另需 Mac Host 中经过审核的适配器。私钥留在服务外。此流程不等于自动批准、收费、安装或接单授权。

新增的 `qianshou.declaration.v1` 接收第三方**纯数据声明**并进入待审队列。ZIP 精确包含 `manifest.json`，以及从 `schemas/0/input.json`、`schemas/0/output.json` 至 `schemas/N-1/input.json`、`schemas/N-1/output.json` 的文件，其中 `1 ≤ N ≤ 16`；ZIP 内的条目顺序不限，不接受脚本、二进制、样例、额外文件或目录。manifest 精确包含 `format`、`pluginId`、`version`、`releaseId`、`platforms`、`architectures`、`operations`；每个按序号对应的操作精确包含 `capabilityId`、`operationId`、`executorKind`、`inputSchemaSha256`、`outputSchemaSha256`、`permissions`。标识符、系统与架构、执行器（含工具、工作流和模型）及权限使用受限词表，同一能力与操作组合不能重复。Schema 摘要是对应 JSON **原始字节**的小写 SHA-256，且 Schema 必须是 `type: "object"` 的 JSON 对象。通用包内所有 JSON 文件必须为 UTF-8，字节内容须等于 `JSON.stringify(JSON.parse(bytes))`，以拒绝重复键和其他有歧义的编码。ZIP 上限 2 MiB，单条目上限 512 KiB，解压后总量上限 2 MiB；仅接受普通文件、UTF-8 文件名、stored/deflated 压缩、匹配的本地与中央元数据、CRC、无 ZIP 注释或扩展字段及连续条目。`submit` 请求将 JSON 正文限制为 3 MiB、base64 限制为 2,796,204 字符，可容纳 2 MiB 的压缩包上限。返回的 `packageSha256` 是整个 ZIP 精确字节的摘要；`unpackedTreeSha256` 是按 manifest 优先、各操作输入再输出顺序排列的 `JSON.stringify([[path, sha256], ...])` 摘要。通用声明调用可执行版本的 `approve` 仍返回 `PLUGIN_REVIEW_UNSUPPORTED`（409）。独立的 `approve-declaration` 只接收审核员签名的元数据审核回执：服务端复核暂存 ZIP、账号与公钥绑定、包和 manifest 摘要，以及是否已有冲突决定或版本，然后保存私有不可变回执。`mine` 随后返回 `review.status: "declaration-reviewed"`、`scope: "declaration-only"`、`installable: false`。此操作不写可执行版本登记或下载制品，不赋予许可、销售或派单资格。可安装版本仍需独立核验执行代码、安全适配器与本机试跑，并形成商业政策。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-declaration-submissions.node-test.mjs packages/host/model-gateway/tests/plugin-seed-flow.node-test.mjs` 验证两种格式。

第三种投稿格式 `qianshou.reviewable-execution.v1` 是单个不超过 256 KiB 的规范 UTF-8 JSON，携带完整的受限声明式程序。广州独立重解析每个字节：1–16 个不同操作、最多 32 个安全字段名的必填平面字符串输入/输出 Schema、有序系统与架构清单、输入输出字节和运行时长上限，以及仅支持 `qianshou.string-map.v1` 的复制、去首尾空白和 ASCII 大小写映射。服务端按真实规范化程序重新计算每项实现 SHA-256 和输入/输出 Schema SHA-256；脚本、路径、常量、任意权限、未知执行器、非规范 JSON、重复键与多余字段均拒绝。投稿记录保存独立核验的完整 manifest 与精确包摘要；单个 JSON 文件的 `unpackedTreeSha256` 是 `JSON.stringify([["artifact.json", packageSha256]])` 的 SHA-256，不信任 Mac 提供的摘要。

独立且已绑定的管理员可在内部鉴权投稿路由提交 `{"action":"approve-execution","submissionId":"<UUID>","candidate":{...}}`。候选包含 `format: "qianshou.execution-release-candidate.v1"`、已核验的投稿/账号/作者和插件/版本标识、`releaseId: "execution." + 完整 packageSha256`、标题、简介、包字节数与摘要、`verificationScope: "self-contained-declarative-program"`，以及每项操作的 ID、能力 ID、执行器种类、实现/Schema 摘要、空权限清单与资源限制。`publisher:{id,accountId,signature}` 使用 `pluginExecutionPublisherPayload(candidate)` 签名，独立的 `approval:{reviewId,operatorId,operatorAccountId,reviewedAt,signature}` 使用 `pluginExecutionApprovalPayload(candidate)` 签名；两函数以不同域前缀按源码固定字段顺序序列化。服务端验证两套公钥、账号绑定、审核员独立性与签名时效，并重新打开和独立核验暂存程序，才原子保存私有 `0600` 不可变候选。`mine` 返回 `review.status: "execution-candidate-reviewed"`。两份签名精确绑定制品与全部操作；篡改或同版本冲突失败。候选固定为 `installable:false`、`saleable:false`、`dispatchable:false`，不进入旧发行登记、CSV 许可账本、公开目录或制品接口。Mac 运行准入、公开售卖与派单策略仍需后续开发。

独立的 `POST /qianshou-market/execution-access` 只接收逐请求核验的上海账号 Bearer，以及 `{"action":"claim","submissionId":"<UUID>","packageSha256":"<64位小写十六进制>"}`。浏览器 Origin/Cookie、跨站请求、重复 Authorization 和超过 1024 字节的正文均拒绝。只有原投稿账号可按精确摘要领取已审核候选。成功响应包含 `{ok,candidate,releaseId,pluginId,version,packageSha256,license,installable:false,saleable:false,dispatchable:false,download:{url,token,expiresAt}}`。`candidate` 是发布者与审核员完整双签对象；Mac Host 必须用留存的两套公钥独立验签并核对每个字段。私有 `0600` 自用许可可幂等领取，精确绑定投稿、账号、发行 ID 与包摘要，`scope` 为 `self-use-review-candidate`。它只是服务端访问记录，**不是**离线签名权益或可安装、可售发行物。随机下载令牌有效五分钟；携带 `Authorization: Bearer <下载令牌>` 调用 `GET /qianshou-market/execution-access?submission=<UUID>&sha256=<摘要>`，服务端重新验证候选双签、程序实现与许可后才返回原始规范 JSON。客户端仍须核对 `x-qianshou-package-sha256` 响应头、计算下载字节摘要、独立解析程序，并在本机执行前获得机主授权。不要把下载令牌送入浏览器 Remote 或写日志。外层代理还需配置 TLS 转发与请求限速；这份源码不证明线上部署或 Mac 安装已完成。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-reviewable-execution.node-test.mjs` 验证候选、账号与下载行为。

投稿上限按**已核验账号**分别计数，每个账号最多 1000 条。新投稿还受全局暂存目录 50,000 文件与 16 GiB 字节上限约束。账号达到上限返回 429；全局空间达到上限返回 507；已存在的 `mine` 历史不会被限额隐藏。`mine` 与仅管理员可用的 `pending` 返回 `{ok:true,submissions:[...],nextCursor:<UUID|null>}`；每页至多 20 条，并按约 3 MiB 条目字节预算提前截页，低于 Mac 桥的 4 MiB 响应上限。持续提交 `{"action":"mine","cursor":"<上一页 nextCursor>"}`，直到游标为 null；不属于该账号排序列表的游标返回 400。排序按 `submittedAt` 降序、同毫秒按 `submissionId` 降序。调用方须限制总页数，并在并发新投稿造成页间变化时去重。

Mac Host 可走独立的 `POST /qianshou-market/submissions`，携带上海账号 Bearer。公开桥只接受 `{"action":"submit","publisherId":"...","title":"...","summary":"...","archiveBase64":"..."}` 和 `{"action":"mine"}`；`pending`、`approve`、`approve-declaration`、`approve-execution`、`reject` 在进入投稿处理器前返回 403。它拒绝浏览器 Origin/Cookie、跨站请求、重复或无效 Authorization、压缩请求体及超过 3 MiB 的正文，只把单个 Bearer 头交给逐请求鉴权。每次请求都在固定的 `marketLicenseAccountApiOrigin` 向上海 `/api/v8/auth/me` 核验，不读取广州进程里的浏览器会话；原有 `/api/.../submissions` 浏览器路径仍独立。缺失或撤销身份返回 401，未配置账号核验或上游故障返回 503，作者 ID 未经 `marketPublisherAccounts` 与 `marketPublisherKeys` 绑定返回 403；投稿处理器仍要求私有暂存、发行登记和制品路径。提交成功返回绑定账号的 `submissionId`、精确制品 `packageSha256` 及 manifest，之后可分页使用 `mine` 读取 `review.status`。桥的每次响应上限是 4 MiB；超限返回 503，不静默截断。当前 `submit` 无幂等键：超时后须先分页使用 `mine` 按本机包摘要核对，再决定是否重试，否则可能产生重复投稿。外层反向代理仍需显式转发此路径与 Authorization，并配置 TLS、限流及不含令牌的日志。源码与本机回环测试不证明公网已部署。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-submission-bearer.node-test.mjs` 验证 HTTP 回环合同。

审核员审核通用声明元数据时提交 `{"action":"approve-declaration","submissionId":"<UUID>","review":{...}}`。回执精确包含 `format: "qianshou.declaration-review.v1"`、投稿/账号/作者 ID、插件/版本/发行 ID、标题、简介、ZIP 与解包树 SHA-256、字节数、`manifestSha256 = SHA256(UTF8(JSON.stringify(submission.manifest)))`、UUID 审核 ID、审核员 ID/账号、Unix 毫秒时间、`scope: "declaration-only"`、`installable: false` 与 Ed25519 签名。审核员在服务外对 `pluginDeclarationReviewPayload(review)` 签名；函数先加 `qianshou-plugin-declaration-review-v1\n` 域前缀，再按上述字段顺序序列化。提交时要求当前管理员账号绑定该审核公钥，签署时间在服务端时间前后五分钟内；历史读取仅凭保留的审核公钥和投稿记录验证。服务端原子发布私有 `0600` 回执并同步目录后才确认；完全相同的重试幂等，冲突决定或同版本审核返回错误，篡改或验签失败不展示为通过。回执须随暂存目录备份。这仅是声明审核证据，不是可执行发行物或公开商品目录。

审核员拒绝投稿时提交 `{"action":"reject","submissionId":"<UUID>","rejection":{...}}`，其中 `rejection` 精确包含 `submissionId`、`packageSha256`、`reviewId`（UUID）、`operatorId`、`operatorAccountId`、`reviewedAt`（Unix 毫秒）、`note`（去除首尾空白后 1–500 字）和 base64 Ed25519 `signature`。审核员在服务外使用私钥签署 `pluginRejectionPayload(rejection)` 返回的 UTF-8 字节；该函数以 `qianshou-plugin-rejection-v1` 分隔域并按固定顺序序列化其余全部字段。服务端写入时核验当前管理员账号与 `marketOperatorAccounts` 绑定、公钥签名、投稿 ID 和制品摘要；签署时间须在服务端当前时间前后五分钟内。历史读取只使用签名及保留的审核公钥，不再依赖可变的管理员账号绑定；轮换账号时须保留历史 `marketOperatorKeys`，撤销的旧账号不能再提交。私钥不能进入服务配置。服务端先将完整回执写入并同步同目录临时文件，再用原子独占硬链接发布为私有 `0600` 回执、同步父目录，成功响应只在目录同步后发送；中断留下的 `.tmp` 不会被识别为审核决定，完整回执被改写则拒绝展示。若链接已生成但目录同步失败，精确相同的已签回执可以重试并再次同步目录后返回成功；不同回执返回 409。投稿 ID 格式错误返回 400，不存在返回 404，损坏或验签失败返回 503。`mine` 向原投稿账号返回 `review.status: "rejected"`、原因与签名；`pending` 不再列出该项。批准和拒绝共用版本登记写锁，拒绝后不能再批准，已批准项也不能改为拒绝；请将回执随投稿目录备份。此操作不更改上海旧市场审核队列，目前仍是未部署广州公网的源码候选。

`POST /api/qianshou/ai/plugins/license` 收到 `{"action":"claim","releaseId":"qianshou.csv-profile-1.0.0"}` 后，只在当前账号核验成功、版本已双签且 `marketFreeReleaseIds` 显式列为免费时，在 `marketLicenseLedgerPath` 私有持久账本中按账号和版本摘要幂等领取。未配置返回 503。响应字段为 `{ok,releaseId,pluginId,version,packageSha256,license:{licenseId,kind:"free",accountId,claimedAt},download:{url,token,expiresAt}}`，时间为 Unix 毫秒。临时随机 Bearer 五分钟内只可下载同一 `releaseId` 与 SHA-256；缺少、过期或不匹配返回 403。客户端须再次核验签名、下载字节、ZIP 和自己的执行器/权限策略。当前只是源码与本机 loopback 测试，尚无广州公网代理、账号通道、Mac 安装或结算已上线的证据。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-seed-flow.node-test.mjs` 可验证与 Mac 固定 ZIP 一致的领取和回流。

Mac Host 不使用上述浏览器 Cookie 路径。它使用独立的 `POST /qianshou-market/license`，携带上海账号 Bearer，并先发 `{"action":"check"}`；广州逐请求向固定 `marketLicenseAccountApiOrigin` 的 `/api/v8/auth/me` 核验，成功返回 `{ok:true,accountId:"167",authMode:"bearer-request-bound"}`，不写许可账本。随后 `{"action":"claim","releaseId":"..."}` 才走同一份免费版本策略和私有账本。账号 ID 只取上海响应，绝不取请求正文或广州当前浏览器会话。缺 Bearer、无效或撤销令牌返回 401；上海失联、响应异常或缺少配置返回 503。`marketLicenseAccountApiOrigin` 必须是固定 HTTPS 源站（本机测试可用回环 HTTP），不得带路径、查询、用户信息；不要在日志中打印令牌。外层反向代理仍需显式转发 `/qianshou-market/license` 并保留 `Authorization` 头，且应设置 TLS、请求速率限制与审计（审计不得记录令牌）；源码和回环测试不证明线上已经开放该路径。聚焦测试：`node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-license-bearer.node-test.mjs packages/host/model-gateway/tests/plugin-seed-flow.node-test.mjs`。

跨仓客户端验证可运行 `node --experimental-strip-types packages/host/model-gateway/tests/seed-loopback-server.mjs 167`。脚本只监听 `127.0.0.1`，运行时生成临时发布者/审核员密钥，通过同一投稿和审核逻辑，并输出本机地址、公钥、包摘要和仅测试用 `testBearer`。测试服务用固定本机替身模拟上海 `/auth/me`，可按上述 `check → claim → download` 链路验证 Mac Host，但不能作为真实鉴权或上线证据；客户端验证结束后停止进程。

## 插件审核代理

`POST /api/qianshou/ai/admin/marketplace` 通过现有浏览器通道接受 `{"action":"list"}` 或 `{"action":"approve|reject|suspend","appId":12,"note":"审核原因"}`。接口先核验当前管理员账号，再把同一账号由服务端保存的访问令牌发送到上海 `/api/v8/admin/marketplace/review`。`marketplaceAdminApiOrigin` 必须配置为固定 HTTPS 源站；未配置时返回 503。浏览器不能指定上游地址或自行提交 Bearer 令牌。

上海旧审核入口目前只能通过免费 HTTPS 网页展示。这条代理不能发布可执行包、启用安装、修改价格或分成，也不能代替机主上报设备接单能力。上面的公开签名目录仍由运营方单独管理。

## 验证

从仓库根目录运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-market.node-test.mjs`。测试启动真实的本机 HTTP 服务，覆盖空目录、已签名条目、伪造或无效文件以及只读方法。该本地测试不能证明广州反向代理已经开放接口。

发布版本聚焦测试：`node --experimental-strip-types --test packages/host/model-gateway/tests/plugin-releases.node-test.mjs`，覆盖双签名、真实制品摘要、符号链接、重复版本、运行中替换和重启后的版本锁。仍不代表上架、安装或线上发布。

运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/marketplace-admin.node-test.mjs` 可验证管理员授权、固定上海地址与请求校验。测试不证明上海或广州已部署该路由。

## 普通技能投稿与员工发布

`marketOrdinarySkillStorePath` 在既有网关启用独立 `ordinary_skill` 发布种类：owned0700目录下的私有0600 SQLite只保存投稿、不可变包/定价元数据与员工签名决定，不建资金账本。复用 `marketLicenseAccountApiOrigin`、`marketOperatorKeys`（base64 SPKI DER Ed25519）和 `marketOperatorAccounts`。`marketOfficialSkillAccounts` 是服务权威维护的真实账号名单，匹配才返回publisher_kind=official，否则默认user，不接受作者/审核员自报官方。普通用户只需真实上海账号，不要求预绑定适配器发布者，也不要求executor/capability ABI。原适配器投稿、有偿订单审核与许可合同保留。

Mac Host携逐请求核验的上海账号Bearer调用 `POST /qianshou-market/skills`。submit精确 `{action,requestId:UUID,skillId,version,title,summary,price_yuan,archiveBase64}`；币种固定CNY，价格为用户明确的非负十进制字符串，最多两位小数。requestId按账号绑定，原请求重试恢复同一不可变投稿；改bytes/价格冲突。ZIP压缩/解包均≤2MiB，≤128普通文件、每文件≤512KiB，根或同一顶层目录须有一个UTF-8 SKILL.md；拒绝越界路径、符号链接、重叠ZIP记录和大小写冲突。检查不执行技能指令/脚本。每项projection含原requestId；未知submit响应只以 `{action:'mine',requestId:UUID}` 精确查当前owner原记录，回零/一条，不再次上传包。mine、catalog接受 `{action,cursor?}`，每页20条并返回nextCursor；GET同路径公开读取已发布首个目录页。公开POST拒绝员工审核动作与浏览器carrier。

已绑定管理员通过既有浏览器carrier `POST /api/qianshou/ai/skills/submissions` 操作：pending看队列，`{action:'pull',submissionId}`返回原archiveBase64及SHA供广州员工人工测试。员工测试这些精确bytes后，提交 `{action:'review',submissionId,review:{key_id,payload,signature}}`，独立签名发布/拒绝决定。payload精确 `{schema:'qianshou.ordinary-skill-review.v1',purpose:'qianshou:ordinary-skill-review',submissionId,accountId,skillId,version,title,summary,price_yuan,currency,packageSha256,packageBytes,unpackedTreeSha256,skillMdSha256,skillMdPath,manual_test:{tested,test_receipt_sha256},decision:'publish'|'reject',note,reviewId,operatorId,operatorAccountId,reviewedAt}`。服务外员工私钥签 `ordinarySkillReviewBytes(payload)`（按key排序的canonical JSON），signature是canonical base64。新决定要求当前管理员账号与公钥绑定、非投稿者且签时前后五分钟；发布须tested=true及真实人工测试回执SHA。服务重新读取/核验原archive、绑定投稿价格、拒绝同版本替换，持久成功才确认，只有同一签名重试幂等。私钥不进服务配置。

只有员工人工发布的普通技能进入该目录，带完整签名验收和价格。上海buyout/entitlement与PC安装尚未接入时，明确 `purchase_available:false`、`installable:false`；价格展示不授购买/自动执行权，不自动测试、批准或安装用户包。这是源码与本机HTTP验收，未宣称生产发布。运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/ordinary-skill-publication.node-test.mjs packages/host/model-gateway/tests/plugin-submission-bearer.node-test.mjs packages/host/model-gateway/tests/plugin-declaration-submissions.node-test.mjs packages/host/model-gateway/tests/plugin-seed-flow.node-test.mjs`，14项通过。


## 生产网关装配

导出的现役7080没有旧适配器市场模块。部署从live插件原文仅插入四media核心、独立[普通技能包校验器](src/ordinary-skill-package.ts)、[普通技能Bearer carrier](src/ordinary-skill-bearer.ts)、普通发布核心和逐请求账号核验器；支付、platform-proxy、serviceAdmin与既有模型路由逐字保留。不能用本仓完整历史plugin替换而启用整组旧市场。普通技能管理handler沿用live请求身份策略，空审核公钥只保留pending。PC实际包及人工签名回执已与广州本地互通；价格元数据和人工上架不会启用购买或安装。


## 不计费研究任务

研究通道使用独立 `researchDirectoryCredentialRef`（只读元数据）与 `researchDispatchCredentialRef`（同账号任务）。凭据引用不能复用正式派单、交换或目录元数据身份；无需正式档位、worker 资格、报价或余额。固定 Qwen 工作流 `comfy-pilot-image-154f7d6133fe0276` 只接受 `{prompt}`，以 8 步生成 2048×1152 PNG。挑战回执只能确认原先上报的模型和工作流；原本空缺的哈希或版本可以在复查时补全。其他探测到的 API 可展示，但不能进入此固定免费任务的派发。API 已确认不代表设备当前空闲。

设备 Bearer POST `/v1/nodes/research/execution` 精确接收 `{deviceId,connectionEpoch,observationRevision,mode:'image',idle:boolean|null,resourceAllowed:boolean|null}`。服务器绑定当前已登记 API revision、写入服务器 `observedAt`，精确返回 `{ok:true,deviceId,connectionEpoch,observationRevision,mode:'image',observedAt}`。只读目录可选 `execution` 的八个字段为 `schema:'qianshou.research-node-execution.v1',observedAt,connectionEpoch,observationRevision,idle,resourceAllowed,activeTasks,slotCount:1`。达到 15 秒、心跳/政策失效、revision 或 epoch 改变后，资源标志变为未知。`activeTasks` 来自持久未终态研究/正式 attempt 与心跳 running id 的并集，节点不能自报此计数。上海也须在派发前为每台设备预占一个槽。

`POST /internal/media/research/dispatch` 接收精确 14 字段 `qianshou.research-media-lease.v1` 请求，并冻结当前 API revision 与 `non_billable:true`。SQLite 在同一事务内检查并预占设备；资源报告过期在插入前返回 `RESEARCH_EXECUTION_NOT_READY`。结果未知保留原 task/attempt 和占位，不因租约过期或重连释放。`/internal/media/research/task` 读取原 tuple。`/v1/nodes/research/channel`、`/claim`、`/events`、`/task-status` 使用独立 cursor 与当前设备凭据；持久 duplicate claim 只对账原提交，不授权再次 POST 模型。撤回资源许可阻止新 claim，原已 claimed 任务仍可 GET 恢复与交付。Host 在唯一 runtime POST 前继续复查实际空闲与账号政策。详见 [预占决策](../../../.agents/notes/2026-09-30-research-node-capacity.zh.md)。

PNG 按节点→广州→账号传输，不经过上海。`/v1/nodes/research/results/upload` 限制 64 MiB，核验完整 PNG chunk、CRC、尺寸与 SHA，只有不可变原文件能完成任务。账号 Bearer GET `/v1/media/research/result?taskId=<UUID>&attemptId=<UUID>` 只读取原账号绑定产物，不向 PC 下发正式 viewer grant 或服务凭据。下载失败只重试原 GET，不能重生成。研究完成不产生扣费或结算回执。

`POST /v1/nodes/device-info` 使用设备 Bearer，精确接收 `{deviceId,connectionEpoch,deviceInfo}`。配置包含 `os,osVersion,arch,deviceName,cpu,gpu,memoryMb,vramMb`，标签拒绝路径、端点、IP 与控制字符；GPU 统一内存的 `vramMb:null`。缺失证据保持 null，不构成硬件资格。管理员投影增加可选 `username` 与 `deviceInfo`，研究目录不包含这两个字段。用户名只来自注册时上海 `/api/v8/auth/me`，或账号 Bearer POST `/v1/nodes/account-identity` 的精确 `{deviceId}`。刷新核验原账号归属，不改变设备 epoch 或授权。

运行 `node --experimental-strip-types --test packages/host/model-gateway/tests/research-tasks.node-test.mjs packages/host/model-gateway/tests/research-directory.node-test.mjs packages/host/admin-console/tests/api-connections.node-test.mjs` 验证 CPU SQLite、真实 HTTP 预占、恢复、字节校验与管理员投影。受保护发布只替换 extension bundle，保留财务、profile、unit 与既有运行文件。这些测试不证明多 PC 原生执行、Windows 验收或付费发行。
