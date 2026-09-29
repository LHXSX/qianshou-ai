/** Public instructions only. These strings never include account, device or upstream credentials. */
export const OFFICIAL_MEDIA_API_BASE = 'https://app.qianshousuanli.com'

export const NODE_AI_INSTRUCTIONS = `请为这台电脑准备千手图像/视频节点接入，先只读检查并编写候选程序，等待机主明确授权后才连接。

官方 HTTPS Base：${OFFICIAL_MEDIA_API_BASE}
节点主动向广州发起 HTTPS 请求，无需公网 IP、端口映射或 WebSocket。普通 PC 用户在“算力共享”页确认启用，无需手填 token 或 IP。

1. 只读识别本机模型、运行服务、可用资源及现有任务；保留正在运行的千手、ComfyUI、H3和原任务。已有模型先核验复用，不重复下载。上游 API token 只保存在本机私有文件，绝不发给广州、页面、日志或聊天。
2. 先用新 nonce 调用 GET /v1/nodes/probe?nonce=<UUID>，核对返回的 schema、service、原 nonce 和 time。HTTP 200、探测可达或本机模型存在均不代表可以接单。
3. 从实际本机API只读元数据识别模型与工作流；机主明确授权的不计费试运行无需先取得正式收费资格。正式收费另用账号Bearer查询官方profile、发行与设备资格，缺正式材料时保持 capabilities=[]、freeSlots=0，不伪造收费能力、价格或回执。
4. 机主确认后，在本机先持久保存随机 deviceId、私有 deviceToken、capabilityRevision和原任务日志，再按协议登记。账号 Bearer 仅用于登记/安装/资格；设备 Bearer 仅用于该设备通道，禁止使用管理员Cookie或服务端私钥。
5. 严格保存服务器返回的 connectionEpoch；先读取原游标的 /v1/nodes/channel 恢复原任务，再心跳。另按设备Bearer上报api-observations，并处理apiProbes里的只读metadata挑战、以原UUID提交api-probe-result；收到成功回执后才显示广州已确认API。重连不能重执行，账号切换不能继承旧确认。正式收费模式缺资格时保持零槽。
6. 只读metadata挑战不能生成图像或视频。真实试运行只通过用户明确授权的既有不计费调用合同执行。正式收费任务另需上海签名与精确task/attempt/lease/profile绑定；不得模拟任务、调用内部派单、自动购买或定价收费。
7. GPU提交前先持久化一次性执行权和稳定attempt-ID；收到外部job-ID后立即持久化。未知POST结果保留原UUID，只按实际上游合同查询原任务，不重发GPU POST、不换attempt、不释放未知占用。成片后只恢复原文件上传/下载；广州验真和上海账本结算独立，设备不能自行宣称已结算或有收益。

请先输出本机只读发现、缺失的官方材料、候选源码和验收清单；不要在收到这段说明时自动连接、安装模型、运行GPU或变更生产配置。详细路径和JSON字段以下载的《节点接入协议》为准。`

export const NODE_CONNECTION_PROTOCOL = `# 千手节点接入协议（公开说明）

官方 HTTPS Base：${OFFICIAL_MEDIA_API_BASE}
这份说明描述协议，不证明所有接口已经开放。管理页的当前状态来自后端读取；未提供状态、读取失败或材料缺失均不能推断为可执行。节点采用 HTTPS 主动出站和HTTP长轮询，无公网IP/端口映射要求，不使用猜测的WebSocket地址。

## 身份与授权
- 当前机主账号Bearer来自上海真实登录，不能用管理台Cookie、其他机主凭据或后台服务token代替。公开请求不传accountId/ownerId，由广州核验auth/me绑定。
- deviceId和capabilityRevision采用本机持久UUID；deviceToken采用安全随机32字节的base64url并保存于本机私有文件，不放URL、页面或日志。注册JSON里的deviceToken与后续设备Bearer必须是同一个已保存值。
- 注册快照（能力、并发、adapterVersion、revision）不可变。同一deviceId/revision的登记只能使用原完整快照；未知登记结果不换身份。能力变化先撤回原空闲供给，再明确登记新revision。
- connectionEpoch只取合法服务器响应并持久化，禁止本地猜测加一。新的epoch必须先channel恢复再heartbeat；旧epoch回复、账号变化和旧异步回调不能恢复新机主权限。
- 以下JSON的尖括号均是说明占位符，不是真实凭据或可直接执行的配置；所有POST为application/json，Bearer放Authorization，不放query。

## 公开探测（无需凭据）
GET /v1/nodes/probe?nonce=<新的UUID>
响应精确语义：schema=qianshou.media-gateway-probe.v1，service=qianshou-guangzhou-media，nonce与请求相同，time为Unix秒。验证挑战与当前时间，不把普通200当协议证明。

## 官方安装与资格（当前机主账号Bearer）
POST /v1/media/install-manifest
{"nonce":"<UUID>","deviceId":"<已保存设备ID>","workerId":"<已保存worker UUID>","mode":"image","platform":"win32","arch":"x64","hardware":{"gpu_name":"<实测名称>","vram_mb":0,"memory_mb":0}}
mode=image|video，platform=darwin|win32，arch=arm64|x64，硬件数值来自实测，不照抄占位0。安装manifest必须按独立metadata固定公钥验证用途、nonce、当前账号/设备/worker、平台、文件大小/SHA、受审entrypoint及loopback启动合同。缺发行材料返回503，不能把试用模型当正式包。

POST /v1/media/devices/qualification
{"nonce":"<UUID>","deviceId":"<已保存设备ID>","workerId":"<已保存worker UUID>"}
核验签名用途、原nonce和有效期；仅相同账号/设备/worker的profile可用。签名空profiles表示未取得正式资格，不能用设备登记或本机健康替代。metadata信任键不能作为正式result、Shanghai order、离线发行或独立验证键。

## 登记与持久连接
POST /v1/nodes/register （机主账号Bearer）
{"deviceId":"<已保存设备ID>","deviceToken":"<本机私有随机设备Bearer>","adapterVersion":"<真实程序版本>","capabilityRevision":"<已保存revision>","capabilities":[],"maxConcurrency":1}
capabilities仅填已经取得资格的精确五字段：profile_id、profile_version（整数>=1）、model_sha256、workflow_sha256、validation_receipt_sha256。缺资格必须为空；并发不超过实测许可。响应保存deviceId、connectionId、connectionEpoch、heartbeatIntervalMs、heartbeatTimeoutMs；回显deviceToken仍只本机私存。相同注册快照的幂等恢复不等于GPU可重提。

POST /v1/nodes/reconnect （原设备Bearer）
{"deviceId":"<原设备ID>","capabilityRevision":"<原revision>"}
保存合法新connectionEpoch后恢复原channel。响应未知不能自行推算epoch或上报空闲；按原设备/任务记录核查，绝不获得新GPU提交权。

POST /v1/nodes/channel （设备Bearer，HTTP长轮询）
{"deviceId":"<设备ID>","connectionEpoch":1,"afterSequence":0,"waitMs":0}
首次/重连以持久原游标读取，waitMs=0..25000；后续使用服务端返回sequence。先持久化收到的精确任务和恢复状态再推进游标。恢复页可能重复原任务，按taskId+attemptId+leaseEpoch对照原日志，只恢复GET/交付，不能重执行。

POST /v1/nodes/heartbeat （设备Bearer）
{"deviceId":"<设备ID>","connectionEpoch":1,"capabilityRevision":"<原revision>","freeSlots":0,"runningAttemptIds":[],"freeVramMb":0,"availableSeconds":0}
按服务器heartbeatIntervalMs发送，所有资源字段必须真实。未资格、未空闲、未知执行或仅连接授权时freeSlots=0；已有在途attempt必须保留runningAttemptIds，不因暂停丢弃。有效心跳仅证明该epoch在线。

POST /v1/nodes/disconnect （设备Bearer）
{"deviceId":"<设备ID>","connectionEpoch":1}
仅确认ok=true且online=false才记为已断连。暂停新接单先归零；有原任务时保留其原session/状态和交付通路直到drain，不能用立即断连切断原attempt回传。

## 本机 API 上报与广州往返确认（不计费元数据）
POST /v1/nodes/api-observations （设备Bearer）
{"deviceId":"<原设备ID>","connectionEpoch":1,"observationRevision":"<本机保存的不可变版本>","observations":[{"mode":"image","adapter":"<实际adapter ID>","status":"ready","model":{"id":"<实际公开模型ID>","sha256":null,"version":null},"workflow":{"id":"<实际公开工作流ID>","sha256":null,"version":null},"observedAt":"<UTC ISO时间>"}]}
observations最多两项且mode不重复；ready必须含实际model和workflow。标识只允许安全ASCII，不包含地址、路径、token；未知SHA保持null，不猜hash。同revision内容不可变，未知上报结果不换身份。
channel的apiProbes与生成任务分开，字段为requestId、mode、epoch、kind=metadata、expiresAt。设备只对已投递的原UUID执行只读API/模型/工作流GET，不能把探测当GPU生成。
POST /v1/nodes/api-probe-result （设备Bearer）
{"deviceId":"<原设备ID>","connectionEpoch":1,"requestId":"<已投递原UUID>","observation":{"mode":"image","adapter":"<原adapter ID>","status":"ready","model":{"id":"<实际公开模型ID>","sha256":null,"version":null},"workflow":{"id":"<实际公开工作流ID>","sha256":null,"version":null},"observedAt":"<UTC ISO时间>"}}
广州校验当前设备、epoch、mode、adapter和原挑战。成功confirmed回执仅表示实际metadata往返，120秒有效；旧epoch、离线、暂停、撤销上报或过期都不能保留确认。此链路不修改正式capabilities、GPU槽位、报价、结算或费用，API确认也不是实际图像/视频生成成功。

## 正式任务、状态与交付（设备Bearer；未准入不调用执行）
channel提供上海冻结任务，不能自己构造或提交/internal派单、result-record、settlement。执行前验证上海固定公钥签名、当前设备/机主、taskId、attemptId、leaseEpoch、leaseExpiresAt、quoteId/authorizationId、plan_sha256、官方profile及实际闲时准入；机主只授权连接不等于运行授权。

POST /v1/nodes/media/order-current
POST /v1/nodes/media/task-status
两者JSON均为 {"deviceId":"<设备ID>","connectionEpoch":1,"taskId":"<原taskId>","attemptId":"<原attemptId>","leaseEpoch":1}。只查询原元组；状态/资源未知时保持占用，不提交新任务。

POST /v1/nodes/media/input-ticket
{"deviceId":"<设备ID>","connectionEpoch":1,"taskId":"<原taskId>","attemptId":"<原attemptId>","leaseEpoch":1,"assetId":"<原素材ID>","sha256":"<原64位小写SHA>"}
按固定输入票据POST /v1/media/assets/read，Authorization是原签名票据Bearer，body为空，不能以本机上游token调用；读原版本、长度和SHA均核验。

POST /v1/nodes/events
{"deviceId":"<设备ID>","connectionEpoch":1,"taskId":"<原taskId>","attemptId":"<原attemptId>","sequence":1,"leaseEpoch":1,"stage":"accepted"}
可选percent仅0..100实测值，未知不传。stage仅accepted|downloading_assets|running|uploading|awaiting_settlement|failed|cancelled|outcome_unknown。本机sequence单调持久；同一事件重查/回传只能原内容。事件不能携带本地path、凭据、媒体bytes或客户端费率，也不代表结算。

POST /v1/nodes/media/result-ticket
{"deviceId":"<设备ID>","connectionEpoch":1,"taskId":"<原taskId>","attemptId":"<原attemptId>","leaseEpoch":1,"assetId":"<持久结果UUID>","sha256":"<结果SHA>","size_bytes":1,"content_type":"image/png"}
sha/size/mime为实际结果，不照抄占位1。原签名上传票据Bearer用于POST /v1/media/results/upload，body是原始媒体bytes，Content-Type/Length精确。未知上传不换assetId或重生成，只查原结果。

POST /v1/nodes/media/result-status
{"deviceId":"<设备ID>","connectionEpoch":1,"taskId":"<原taskId>","attemptId":"<原attemptId>","leaseEpoch":1,"assetId":"<原结果UUID>"}
仅已核验原artifact可进入awaiting_settlement事件，额外字段为assetId和artifact精确五字段object_key/object_version_id/sha256/size_bytes/content_type。广州按固定对象版本完整验真，上海按真实账本单次结算。上传成功、HTTP200或本地PNG/MP4不代表计费/收益成立。

## 未知结果与安全恢复
在任何GPU POST之前持久化一次性执行权；稳定idempotencyKey/attemptID及外部jobID按实际上游合同保存。响应丢失、进程重启或重连都只GET原任务，禁止重新POST生成、换UUID、清理unknown槽、自动退款或再次扣费。同一成片的失败交付仅取原文件/同版本，不重新执行。旧通道和跨账号异步结果必须撤销。所有素材/成片在广州、节点、客户端之间交换，上海仅控制元数据与账本。

这份协议不提供设备密钥、生产服务凭据、模型定价、正式发行或独立设备资格。当前开通状态以管理页后端观察及官方签名回执为准。
`

export const LOCAL_AI_DEPLOYMENT_GUIDE = `# 本地AI部署与复用指引

官方节点连接：${OFFICIAL_MEDIA_API_BASE}（HTTPS主动出站）

1. 先只读检查操作系统、GPU/独立显存、内存、现有模型、ComfyUI/H3/统一API和正在执行的任务。不要关闭旧千手、重启服务、重复下载已有模型或占用新的GPU任务来“证明”连接。
2. 本机API的地址、端口、workflow_id和认证方式必须来自实际配置与只读官方catalog；不要照抄猜测端口。Windows上游私有token文件只由本机程序读取，不上传到管理台、广州或聊天。健康200仅证明可达，仍需核验精确API/工作流合同。
3. 不计费接入优先复用实际已有API与模型，服务/模型/workflow元数据必须来自真实GET。正式收费程序另需匹配官方签名安装包、每文件大小/SHA、执行器ABI及独立profile设备回执；research Qwen/H3试用或CPU测试包不是正式受审材料。当前v1独立显存/受审硬件规则不能套用Mac共享RAM，缺对应方案如实保留待接入。
4. 外部节点AI先准备候选程序和回归证据；机主明确授权后才登记和上报本机API。正式收费未资格时保持capabilities=[]、freeSlots=0；不计费元数据往返独立进行，不把健康200当广州已确认API或实际生成成功。普通千手PC用户直接在“算力共享”页选择图像/视频并确认，可暂停或撤销，不需要找token、IP或开放端口。
5. 正式执行还需本机闲时授权、真实空闲/前台/语音/内存观察、官方profile与上海精确租约共同通过。不新增未经确认的自测、购买、报价、收费或收益承诺。
6. 用持久原task/attempt/lease和外部jobID恢复；未知GPU POST不重发。暂停只关闭新接单，原任务继续在原权限下查询和交付；换账号不能继承旧授权。完成后由广州机械验真、上海账本结算，下载失败只恢复原交付。

交付给机主：只读发现、可复用文件的核验结果、缺失官方材料、候选程序版本、有限回归结果和未验收项目。源码/CPU测试/本机健康不能宣称正式发布、真实GPU验收或已经盈利。
`

/** Download fixed public documentation locally; no credential or live operation is requested. */
export function downloadConnectionGuide(kind: 'protocol' | 'deployment', protocol = NODE_CONNECTION_PROTOCOL): void {
  const text = kind === 'protocol' ? protocol : LOCAL_AI_DEPLOYMENT_GUIDE
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = kind === 'protocol' ? '千手节点接入协议.md' : '千手本地AI部署指引.md'
    link.click()
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0) }
}
