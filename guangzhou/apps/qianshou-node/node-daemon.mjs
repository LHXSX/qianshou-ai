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
 *
 * 用法：
 *   QIANSHOU_NODE_TOKEN=<token> node node-daemon.mjs \
 *     --core <coreBaseUrl> --owner <accountId> [--mode running|paused] \
 *     [--task-types word_count,dedup_lines] [--name <nodeName>]
 */
import { EdgeWorkerConnection } from '@deepseek-ai/dsh-compute-core/edge-worker'
import { projectNodeCapabilities } from '@deepseek-ai/dsh-compute-core/node-capability'
import { probeLocalSupply } from '@deepseek-ai/dsh-compute-core'
import { readFileSync } from 'node:fs'

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

if (!core || !Number.isSafeInteger(ownerId) || ownerId < 1) {
  console.error('缺少参数：--core <baseUrl> --owner <accountId>')
  process.exit(2)
}
if (!token) {
  console.error('缺少凭据：请通过环境变量 QIANSHOU_NODE_TOKEN 注入，不要写进命令行或文件')
  process.exit(2)
}

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (scope, detail) => console.log(`[${stamp()}] ${scope}${detail ? ' · ' + detail : ''}`)

/** 本机可探测的工具；顺序即上报顺序。 */
const TOOLS = [
  { id: 'python3', name: 'Python 3', command: 'python3', args: ['--version'] },
  { id: 'node', name: 'Node.js', command: 'node', args: ['--version'] },
  { id: 'ffmpeg', name: 'ffmpeg', command: 'ffmpeg', args: ['-version'] },
  { id: 'git', name: 'git', command: 'git', args: ['--version'] },
  { id: 'bash', name: 'bash', command: 'bash', args: ['--version'] },
]

log('启动', `core=${core} owner=${ownerId} mode=${mode} 任务类型=${taskTypes.join(',')}`)
const probe = await probeLocalSupply({
  tools: TOOLS,
  readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
  timeoutMs: 8000,
  maxResponseBytes: 65536,
})

/**
 * Python 包自检：只上报**真实装上**的包。
 * 上游 runtimes/software 决定派单资格，所以这里绝不能凭猜测填。
 */
const PYTHON_PACKAGES = ['numpy', 'requests', 'pandas', 'openpyxl', 'PIL', 'pymupdf', 'selectolax', 'readability', 'onnxruntime']
/** 依次尝试的解释器：PATH 上的 python3，以及本机 Homebrew 的 python3（若存在）。 */
const PYTHON_INTERPRETERS = [
  { id: 'python3', path: 'python3' },
  { id: 'python3-homebrew', path: '/opt/homebrew/bin/python3' },
]
const pythonSoftware = await probePythonPackages(PYTHON_INTERPRETERS, PYTHON_PACKAGES)
const capabilities = projectNodeCapabilities(probe, { mode: mode === 'running' ? 'running' : 'paused' })
const pythonPackages = [...new Set(Object.values(pythonSoftware).flat())]
if (pythonPackages.length > 0) {
  capabilities.software = [...new Set([...capabilities.software, ...pythonPackages])]
  for (const [interpreter, packages] of Object.entries(pythonSoftware)) {
    log('Python 包', `${interpreter} → ${JSON.stringify(packages)}`)
  }
}
log('运行时', JSON.stringify(capabilities.runtimes))

/** 已实现的本地执行器；未列出的任务类型一律拒绝，绝不猜测性执行。 */
const EXECUTORS = {
  word_count: (input) => {
    const text = typeof input === 'string' ? input : (input?.text ?? '')
    const counts = {}
    for (const raw of String(text).split(/\s+/)) {
      const word = raw.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
      if (word) counts[word] = (counts[word] ?? 0) + 1
    }
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }
  },
}


/**
 * Python 包自检：**按解释器分别探测**。
 *
 * 为什么不能平铺成一个包名列表：同一台机器上不同解释器装的东西不同
 * （实测本机 `/usr/bin/python3` 有 PIL、`/opt/homebrew/bin/python3` 有 numpy），
 * 平铺上报会让"有 numpy"这个事实失去归属，调度侧无法据此判断哪个解释器能跑。
 * 返回形如 `{ "python3": ["PIL"], "/opt/homebrew/bin/python3": ["numpy", "requests"] }`。
 */
async function probePythonPackages(interpreters, names) {
  const { execFile } = await import('node:child_process')
  const code = `import importlib.util\nprint(",".join(n for n in ${JSON.stringify(names)} if importlib.util.find_spec(n)))`
  const found = {}
  for (const interpreter of interpreters) {
    const result = await new Promise((resolve) => {
      execFile(interpreter.path, ['-c', code], { timeout: 8000 }, (error, stdout) => {
        resolve(error ? [] : String(stdout).trim().split(',').map(s => s.trim()).filter(Boolean))
      })
    })
    if (result.length > 0) found[interpreter.path] = result
  }
  return found
}

let attempt = 0
let stopped = false
const stop = () => { stopped = true }

/** 一次连接的生命周期；返回后由外层按退避重连。 */
async function runOnce() {
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
    readLoad: () => 0,
    onOffer: async (offer) => {
      const type = offer?.taskType ?? offer?.task_type
      const identity = offer?.identity ?? offer?.taskIdentity ?? offer
      log('派单', `${type ?? '?'} ${JSON.stringify(offer)?.slice(0, 200) ?? ''}`)
      const executor = EXECUTORS[type]
      if (!executor) {
        log('拒绝', `未实现的任务类型 ${type}`)
        return
      }
      try {
        const input = offer?.input ?? offer?.inlineInput ?? offer?.payload?.inline_input ?? ''
        const result = executor(input)
        const payload = JSON.stringify(result)
        await connection.complete(identity, { inlineOutputUtf8: payload, elapsedMs: 5 })
        log('已回传', `${Object.keys(result.counts ?? {}).length} 个词 → sent-awaiting-verification`)
      } catch (error) {
        log('执行失败', `${error?.constructor?.name}: ${String(error?.message ?? error).slice(0, 160)}`)
      }
    },
    onEvent: (event) => {
      const type = event?.type ?? '?'
      if (type === 'heartbeat-acknowledged') return
      log('事件', `${type}${event?.code ? ' code=' + event.code : ''}`)
    },
  })
  await connection.connect()
  log('已上线', `mode=${mode} 等待派单`)
  const deadline = Date.now() + 60 * 60 * 1000
  while (!stopped && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
  }
  try { await connection.close() } catch {}
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

while (!stopped) {
  try {
    attempt = 0
    await runOnce()
  } catch (error) {
    attempt += 1
    const delay = Math.min(60, 2 ** Math.min(attempt, 6))
    log('连接失败', `${error?.constructor?.name}: ${String(error?.message ?? error).slice(0, 140)} · ${delay}s 后重试`)
    await new Promise(r => setTimeout(r, delay * 1000))
  }
}
log('已停止', `重连尝试次数 ${attempt}`)
void readFileSync
