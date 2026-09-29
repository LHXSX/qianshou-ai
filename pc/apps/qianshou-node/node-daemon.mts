#!/usr/bin/env node
/**
 * 千手节点守护：把本机作为算力节点接入调度中心。
 *
 * 这是「闲时接单」的节点侧入口，负责：
 * 1. 真实探测本机能力（复用 `probeLocalSupply`），投影成调度中心契约后随 `hello` 上报；
 * 2. 建立并维持 `wss://<core>/api/v8/ws/worker` 长连（子协议 `edgecompute.v8`）；
 * 3. 收到派单后在本机执行，并把结果回传；
 * 4. 断线自动重连（指数退避），网关重启不会让节点永久掉线。
 *
 * 安全边界（刻意保持）：
 * - **默认 `paused`**：节点上线后不自动接单，只有 `--mode running` 才允许接收派单。
 *   未获授权就接单等于替机主做决定，因此默认必须关闭。
 * - **只做已实现的任务类型**：`--task-types` 未列出的任务一律拒绝，不做猜测性执行。
 * - **不下载、不执行任务附带的代码**：`code_url` 一律忽略。
 * - 不读取、不保存任何凭据到磁盘；token 由环境变量注入。
 * - **本机状态端点只绑 `127.0.0.1`**（`node-status-server.ts`），永不绑 `0.0.0.0`；
 *   可选口令 `QIANSHOU_NODE_OWNER_PROOF` 也只从环境变量来，不从命令行来。
 *
 * 用法（在仓库根用 tsx；后缀是 .mts 而不是 .mjs，因为 tsx 只对 TypeScript 入口套用
 * tsconfig.base.json 的 `paths`，`@deepseek-ai/dsh-compute-core` 才能落到 src；apps/ 下没有
 * package.json，node_modules 里没有这个包名）：
 *   QIANSHOU_NODE_TOKEN=<token> pnpm exec tsx apps/qianshou-node/node-daemon.mts \
 *     --core <coreBaseUrl> --owner <accountId> [--mode running|paused] \
 *     [--task-types word_count,dedup_lines] [--name <nodeName>] [--status-port 47615]
 *   pnpm exec tsx apps/qianshou-node/node-daemon.mts --dry
 *
 * 主人怎么看 / 怎么叫停（E9 第一层，`127.0.0.1`）：
 *   curl -s 127.0.0.1:47615/status
 *   curl -s -H 'content-type: application/json' -d '{"command":"tasks"}' 127.0.0.1:47615/command
 *   curl -s -H 'content-type: application/json' \
 *     -d '{"command":"abort","target":"all","reason":"主人手动叫停"}' 127.0.0.1:47615/command
 *   配了 `QIANSHOU_NODE_OWNER_PROOF` 时，`/command` 还要加 `-H "x-owner-proof: <口令>"`。
 */
// `EdgeWorkerConnection` 走包根：源码 `paths` 下 `/edge-worker` 是目录、没有 index.ts，只有构建产物才有该子路径。
import { EdgeWorkerConnection, HOST_SUPPLY_PACKAGES, HOST_SUPPLY_TOOLS, probeLocalSupply, runnerOwnedCapabilityIds } from '@deepseek-ai/dsh-compute-core'
import { EdgeReconnectBackoff } from '@deepseek-ai/dsh-compute-core/edge-worker/connection.ts'
import { mergeProvidedCapabilityAds, projectNodeCapabilities, providedCapabilityAdsForIds } from '@deepseek-ai/dsh-compute-core/node-capability'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOrderAcceptanceAgent } from './order-agent.ts'
import { createNodeStatusTracker, observeNodeConnection } from './node-status.ts'
import { startNodeStatusSurface, type NodeStatusSurface } from './node-status-server.ts'
import { createNodeResultVerification } from './workload-verification.ts'


/** 解析 `--key value` 形式的参数。 */
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = 'true'
    else { args[key] = next; i += 1 }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const core = args.core
const ownerId = Number(args.owner)
const token = process.env.QIANSHOU_NODE_TOKEN
const mode = args.mode === 'running' ? 'running' : 'paused'
const nodeName = args.name ?? 'qianshou-node'
const taskTypes = (args['task-types'] ?? 'word_count').split(',').map(s => s.trim()).filter(Boolean)
const dry = args.dry === 'true'
/**
 * 本地状态端点的端口。
 *
 * 默认值固定而不是随机：主人/客户端要能不带参数就 `curl 127.0.0.1:47615/status`。同一台机器上
 * 跑第二个节点时用 `--status-port` 换一个；传 `0` 由系统分配（端口会打印在启动日志里）。
 */
const statusPort = Number(args['status-port'] ?? 47615)
/**
 * 可选的主人口令：只从环境变量读。它闸的是**动作**（`/command`），不是只读快照；
 * 放进命令行会进 `ps`/shell 历史，所以这里不提供命令行入口。
 */
const ownerProof = process.env.QIANSHOU_NODE_OWNER_PROOF ?? ''

if (!dry && (!core || !Number.isSafeInteger(ownerId) || ownerId < 1)) {
  console.error('缺少参数：--core <baseUrl> --owner <accountId>')
  process.exit(2)
}
if (!dry && !token) {
  console.error('缺少凭据：请通过环境变量 QIANSHOU_NODE_TOKEN 注入，不要写进命令行或文件')
  process.exit(2)
}

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (scope, detail) => console.log(`[${stamp()}] ${scope}${detail ? ' · ' + detail : ''}`)

/**
 * 本机工具自检用的是**宿主唯一来源** `HOST_SUPPLY_TOOLS`（二进制）和
 * `HOST_SUPPLY_PACKAGES`（Python 包，广告名与平台 `required_software` 对齐）。
 * 探测不到的包不上报；不在本表的名字（`pandas` / `PIL`）也不上报。
 */

log('启动', `core=${core} owner=${ownerId} mode=${mode} 任务类型=${taskTypes.join(',')}`)
const probe = await probeLocalSupply({
  tools: HOST_SUPPLY_TOOLS,
  packages: HOST_SUPPLY_PACKAGES,
  readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
  timeoutMs: 8000,
  maxResponseBytes: 65536,
})
const capabilities = projectNodeCapabilities(probe, { mode: mode === 'running' ? 'running' : 'paused' })
// 与 edge-binding hello 同一合并：runner 拥有的语义 id 进 provided_capabilities，落地名不进。
const runnerAds = providedCapabilityAdsForIds(runnerOwnedCapabilityIds(taskTypes, []))
capabilities.provided_capabilities = mergeProvidedCapabilityAds(capabilities.provided_capabilities, runnerAds)
log('运行时', JSON.stringify(capabilities.runtimes))
log('软件', JSON.stringify(capabilities.software))
log('能力广告', JSON.stringify(runnerAds.map(ad => ad.name)))
if (dry) {
  const names = runnerAds.map(ad => ad.name)
  log('dry', names.includes('text.transform') ? 'text.transform' : 'missing-text.transform')
  process.exit(names.includes('text.transform') ? 0 : 1)
}

let attempt = 0
let stopped = false
const stop = () => { stopped = true }

/**
 * "正在跑什么"的唯一一份账（E9 第一层）——与守护进程同生共死，**跨重连保留计数**：
 * `offersReceived`/`accepted`/`succeeded`… 是这台机器干过多少活的记录，重连不该把它清零；
 * 而"现在在跑哪几个分片"是**当前链路**的事实，由 `connectionOffline` 结清。
 */
const nodeStatus = createNodeStatusTracker()

/**
 * 当前链路的拒绝发帧口。
 *
 * 必须指向**被观察的**那条连接（`observeNodeConnection` 的产物）：中止帧发出去的同时，
 * 本地账才会把它记成 `canceled-by-owner`，而不是事后猜。链路不在时抛错，端点会把它翻成
 * 明确的 `skipped: wire-refused`（而不是谎报"停下来了"）。
 */
let currentReject: (identity, failure) => void = () => { throw new Error('EDGE_NOT_CONNECTED') }

/** 状态端点在守护进程启动时就起**一次**，因此掉线/退避期间主人照样能读到"离线 + 原因"。 */
let statusSurface: NodeStatusSurface | undefined
try {
  statusSurface = await startNodeStatusSurface({
    port: statusPort,
    proof: ownerProof,
    status: () => nodeStatus.snapshot(),
    stopOwnerTasks: input => nodeStatus.stopOwnerTasks({ target: input.target, reason: input.reason, reject: currentReject }),
  })
  log('状态端点', `${statusSurface.origin}/status${ownerProof === '' ? '（未设主人本机口令）' : '（/command 需 x-owner-proof）'}`)
} catch (error) {
  // 端口被占不该让节点不能干活；但也不许静默：主人必须知道"这次没有状态出口"。
  log('状态端点失败', `${error?.constructor?.name}: ${String(error?.message ?? error).slice(0, 140)} · 节点继续，但没有本机状态出口`)
}

/** 一次连接的生命周期；返回后由外层按退避重连。 */
async function runOnce() {
  // 核验器与长连同源同凭据：它只走平台**已经审计过**的 HTTP 读侧，不发任何新帧。
  const verification = createNodeResultVerification({
    baseUrl: String(core), tokenProvider: () => token, timeoutMs: 15_000, maxResponseBytes: 65_536,
  })
  const connection = new EdgeWorkerConnection({
    origin: core,
    tokenProvider: () => token,
    expectedOwnerId: ownerId,
    name: nodeName,
    clientBuild: 'qianshou-node-daemon/1.0',
    os: capabilities.os,
    arch: capabilities.arch,
    capabilities,
    allowedTaskTypes: taskTypes,
    handshakeTimeoutMs: 20000,
    maxFrameBytes: 1_048_576,
    maxOutputBytes: 4_194_304,
    loopbackOnly: !String(core).startsWith('https:'),
    readLoad: () => 0,
    onOffer: async (offer, signal) => {
      log('派单', `${offer.taskType} shard=${offer.shardId} attempt=${offer.attempt}`)
      // 账上先开一条任务，并拿到**执行方真正会收到的那条** signal（主人中止就是把这条断掉）。
      const taskSignal = nodeStatus.offerDelivered(offer, signal)
      try {
        // 基线必须在**发出之前**读。发出之后再读的第一份计数无法区分"本来就是这样"和
        // "因为这次回传才这样"，拿它当基线就是自己造一个受理结论。读不到 ⇒ null ⇒ 核验走"未知"。
        const before = await verification.before(offer, taskSignal)
        // ★ 接单专员接管：由它「接订单 → 做任务 → 回传」；本进程只做连线与记账。
        //   行为不变 —— 专员的默认 worker 仍是本进程的内建 runner（`order-agent.ts` 的默认 seam），
        //   本步只是把"谁在处理这一单"显式化，并把它的四步轨迹记进状态面供面板显示。
        //   授权只来自主人启动参数（`--task-types`），**任务文本永远不改授权**。
        let deliveredState: string | null = null
        const workspacePath = await mkdtemp(join(tmpdir(), 'qianshou-node-task-'))
        try {
          const orderAgent = createOrderAcceptanceAgent({
            policy: { capabilityMode: 'builtin', authorizedTaskTypes: [...taskTypes] },
            courier: {
              async deliver(input) {
                const receipt = observed.complete(offer, { inlineOutputUtf8: input.verifiedText, elapsedMs: input.elapsedMs })
                deliveredState = receipt?.state ?? null
                return { accepted: receipt !== undefined && receipt !== null, reference: deliveredState }
              },
            },
            scoutSuggestions: [...capabilities.software],
            onTrace: line => { log('专员', line) },
          })
          const result = await orderAgent.handleOffer(
            { shardId: offer.shardId, attempt: offer.attempt, taskType: offer.taskType, inlineInput: offer.inlineInput ?? '' },
            // 与接单代理的默认时钟同一纪元。`performance.now()` 从进程启动起算，减 `Date.now()` 会把耗时写成墙上时刻。
            { workspacePath, signal: taskSignal, startedAtMs: Date.now() },
          )
          nodeStatus.noteTrace(offer.shardId, result.trace)
          if (!result.delivered) {
            observed.reject(offer, { code: result.refusal?.code ?? 'EDGE_EXECUTION_FAILED', message: result.refusal?.detail ?? 'order acceptance agent refused' })
            log('已拒绝或失败', offer.shardId)
            return
          }
        } finally {
          await rm(workspacePath, { recursive: true, force: true })
        }
        const verified = await verification.verify(offer, before, taskSignal)
        nodeStatus.recordVerification(offer.shardId, verified.outcome)
        // 只打印核验**看到了什么**：`workload-completed-shard-observed` 是工作负载聚合粒度的
        // 计数前进，不是"平台确认了这个分片"。未知/待定一律照原样打出来，禁止折算成成功。
        log('已回传', `${deliveredState ?? 'sent-awaiting-verification'} → ${verified.outcome} (${verified.disposition})`)
      } catch (error) {
        // 主人中止会让 runner（以及被中止打断的核验读）抛出取消异常。这一条**不许**往上抛：
        // `connection.ts:239-244` 把 onOffer 的异常一律翻成 `fail('EDGE_EXECUTION_CALLBACK_FAILED')`，
        // 那会为了"主人叫停"把整条会话拆掉（中止帧已经发过了，调度方那边是清楚的）。
        // 只有**已确认是主人停的**才吞；真正没预料到的异常照旧上抛，不被这里盖住。
        if (!nodeStatus.isOwnerStopped(offer)) throw error
        log('已中止', `${offer.shardId} 主人叫停 · ${String((error as Error)?.message ?? error).slice(0, 80)}`)
      }
    },
    onEvent: (event) => {
      const type = event?.type ?? '?'
      if (type === 'heartbeat-acknowledged') return
      if (type === 'authenticated') nodeStatus.connectionOnline({ core: String(core), workerId: event.workerId, ownerId: event.ownerId, mode })
      // `closed` 是**唯一**的掉线出口：`connection.fail()` 在任何路径上都发它（`connection.ts:299`），
      // 所以"在跑的活怎么结账"只有一个写入点，不会漏。
      if (type === 'closed') nodeStatus.connectionOffline(event.reason)
      log('事件', `${type}${event?.code ? ' code=' + event.code : ''}${type === 'closed' ? ' reason=' + event.reason : ''}`)
    },
  })
  // 记账口与被观察的连接同源：链路上发出去的每一帧都在同一处被抄进本地账。
  const observed = observeNodeConnection(connection, nodeStatus)
  currentReject = (identity, failure) => observed.reject(identity, failure)
  nodeStatus.connectionConnecting(String(core))
  await connection.connect()
  if (mode === 'running') connection.updateMode('running')
  log('已上线', `mode=${mode} 等待派单`)
  const deadline = Date.now() + 60 * 60 * 1000
  while (!stopped && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
  }
  try { await connection.close() } catch {}
  verification.close()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const backoff = new EdgeReconnectBackoff()
while (!stopped) {
  const sessionStartedAt = Date.now()
  try {
    await runOnce()
    backoff.reset()
    attempt = backoff.attempt
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'EDGE_CONNECTION_FAILED'
    const plan = backoff.next(reason, Date.now() - sessionStartedAt)
    attempt = plan.attempt
    log('连接失败', `${error?.constructor?.name}: ${reason.slice(0, 140)} · ${plan.delayMs}ms 后重试 · 第 ${plan.attempt} 次`)
    await new Promise(r => setTimeout(r, plan.delayMs))
  }
}
log('已停止', `重连尝试次数 ${attempt}`)
if (statusSurface) await statusSurface.close()
