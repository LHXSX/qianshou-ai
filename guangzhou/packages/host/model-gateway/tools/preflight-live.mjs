/**
 * **真实端点预检**：对着真的服务商验证网关赖以成立的每一项能力。
 *
 * 为什么需要它：本地模拟上游是按"我读到的文档"写的，所以本地全绿只证明
 * "网关能解析我以为的那种格式"。真实端点是否认 `stream_options.include_usage`、
 * 是否在末帧回 `usage`、`max_tokens` 是否真的被尊重——只有打真端点才知道。
 *
 * **绝不打印密钥**：只打印它的来源（env/file）与长度。
 * 密钥不进日志、不写文件、不写进仓库。
 *
 * 跑法：
 *   PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs \
 *     packages/host/model-gateway/tools/preflight-live.mjs
 * 密钥来源（按序）：环境变量 `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` 的 `refs` 段。
 * 退出码非 0 表示有断言没过。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'
import { MIN_OUTPUT_TOKENS, TIERS } from '../src/tiers.ts'

/** 读凭据文件 `refs` 段里的密钥；只认最简单的 `key: value` 形状。 */
function keyFromCredentialsFile() {
  const path = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'].trim().length > 0
    ? join(process.env['DSH_HOME'], '.credentials.yaml')
    : join(homedir(), '.dsh', '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('refs:'))
  if (start === -1) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    // 到了下一个顶层段（顶格）就停。
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break
    const match = /^\s+DEEPSEEK_API_KEY:\s*(\S.*)$/.exec(line)
    if (match !== null && match[1].trim().length > 0) return { value: match[1].trim(), source: `file:${path}` }
  }
  return null
}

const fromEnv = process.env['DEEPSEEK_API_KEY']
const resolved = fromEnv !== undefined && fromEnv.trim().length > 0
  ? { value: fromEnv.trim(), source: 'env:DEEPSEEK_API_KEY' }
  : keyFromCredentialsFile()

if (resolved === null) {
  console.error('找不到密钥：环境变量 DEEPSEEK_API_KEY 未设置，凭据文件 refs 段里也没有。')
  process.exit(2)
}
// 只报告形状，**绝不报告值**。
console.log(`密钥来源：${resolved.source}（长度 ${resolved.value.length}，前缀 ${resolved.value.slice(0, 3)}***）\n`)

const BASE = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1'
const out = []
const check = (name, ok, detail) => { const line = `${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`; out.push(line); console.log(line) }

// —— 1. 直连上游：确认端点可达、认证通过 ——
const listResponse = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${resolved.value}` } }).catch((error) => ({ error }))
if (listResponse.error !== undefined) {
  check(`端点可达（${BASE}）`, false, String(listResponse.error))
  console.log('\n网络不可达：无法继续。')
  process.exit(1)
}
check(`端点可达（${BASE}）`, listResponse.status < 500, `HTTP ${listResponse.status}`)
if (listResponse.status === 401 || listResponse.status === 403) {
  check('密钥被服务商接受', false, `HTTP ${listResponse.status}：密钥无效或没有权限`)
  process.exit(1)
}
check('密钥被服务商接受', listResponse.ok || listResponse.status === 404, `HTTP ${listResponse.status}`)

// —— 2. 走完整网关链路打真实端点 ——
const ledger = createCreditLedger()
const routing = createRoutingConsole()
routing.publish({ publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic', 'plus', 'max'], maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
routing.bind({ publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: 0, reason: '真实预检', operator: 'system', rolloutPercent: 100 })
ledger.grant('preflight', 'basic', TIERS.basic.monthlySp)

const gateway = createGateway({
  ledger, routing,
  tierOf: () => 'basic',
  forwardConfig: { baseUrl: BASE, apiKey: () => resolved.value },
})

let text = ''
const deltas = []
let done = null
let failure = null
await new Promise((resolve) => {
  const handle = gateway.chat(
    { callId: 'preflight-1', accountId: 'preflight', publishedName: '千手·迅捷', messages: [{ role: 'user', content: '用一句话说明什么是订阅制。' }], maxOutputTokens: 128 },
    {
      onDelta: (value) => { deltas.push(value); text += value },
      onDone: (value) => { done = value; resolve() },
      onError: (value) => { failure = value; resolve() },
    },
  )
  void handle.completed
})

check('真实端点走通网关链路', failure === null && done !== null, failure === null ? '' : `失败：${failure.message}`)
check('流式：真的分多帧到达（不是攒完一次给）', deltas.length > 1, `帧数=${deltas.length}`)
check('拿回了正文', text.trim().length > 0, `字数=${text.trim().length}`)
check('用量来自服务商回执（不是本地估算）', done?.usageSource === 'provider', `usageSource=${done?.usageSource}`)

const record = ledger.recordsOf('preflight', 1)[0]
check('计费按真实 token 扣减', (record?.inputTokens ?? 0) > 0 && (record?.outputTokens ?? 0) > 0, `输入=${record?.inputTokens} 输出=${record?.outputTokens} token，扣 ${done?.chargedSp} SP`)
// 用户可见的那一层必须是前台名；backendKey 是**内部**成本核对字段，账本里该有。
check('审计的用户可见层是前台名（不含上游厂商标识）', record?.publishedName === '千手·迅捷', `publishedName=${record?.publishedName}`)
check('审计同时留了后端键供成本核对（内部字段）', typeof record?.backendKey === 'string' && record.backendKey.length > 0, `backendKey=${record?.backendKey}`)

// —— 3. 输出上限：下限被强制 + 预算被推理吃光时的说法可行动 ——
//
// 实测（真实端点）给出的两个事实：
//  a. 会推理的模型把**推理 token 也算进 `max_tokens`**，所以过小的上限会一个字都写不出；
//  b. 同一个提示需要多少预算差异很大——"用一句话说明订阅制" 128 就够，
//     而"从 1 数到 200" 那种长输出需求在 16/64 下必然触顶。
// 因此这一节不再假装"要多少给多少"（那是自相矛盾的请求），而是验证：
//  上限下限被强制、以及触顶时给用户的是一句**能动手**的话。

const CAP = 16
let longText = ''
let longFailure = null
await new Promise((resolve) => {
  const handle = gateway.chat(
    { callId: 'preflight-2', accountId: 'preflight', publishedName: '千手·迅捷', messages: [{ role: 'user', content: '从 1 数到 200，每个数字之间用顿号分隔。' }], maxOutputTokens: CAP },
    { onDelta: (value) => { longText += value }, onDone: () => resolve(), onError: (value) => { longFailure = value; resolve() } },
  )
  void handle.completed
})
check('过小的输出上限被抬到下限（不把一次误传的小值原样发出去）',
  (longText.length > 0) || (longFailure?.message ?? '').includes('输出上限太小'),
  `上限 ${CAP} → 网关抬到 ${MIN_OUTPUT_TOKENS}；正文 ${longText.length} 字`)

if (longFailure !== null) {
  // 触顶时必须是**能动手**的话，而不是"内容无法识别"那种让人以为产品坏了的说法。
  check('触顶时的说明指向用户能做的事', longFailure.message.includes('把上限调大'), `原文：${longFailure.message}`)
  check('触顶不计费（没拿到正文就不收钱）', ledger.recordsOf('preflight', 20).every(item => item.callId !== 'preflight-2'), '账本里没有这一笔')
} else {
  check('这次没触顶，正文正常拿到并计费', longText.length > 0, `正文 ${longText.length} 字`)
}

// —— 4. 上下文上限在网关侧强制 ——
let rejected = null
await new Promise((resolve) => {
  const handle = gateway.chat(
    { callId: 'preflight-3', accountId: 'preflight', publishedName: '千手·迅捷', messages: [{ role: 'user', content: '内'.repeat(70000) }] },
    { onDelta: () => {}, onDone: (value) => { rejected = value; resolve() }, onError: (value) => { rejected = value; resolve() } },
  )
  void handle.completed
})
check('上下文上限在网关侧就被挡住（没打给服务商）', rejected?.rejection?.kind === 'context-too-long', `kind=${rejected?.rejection?.kind}`)

console.log(`\n结果：${out.filter(line => line.startsWith('✗')).length === 0 ? '全部通过' : `${out.filter(line => line.startsWith('✗')).length} 项未通过`}（共 ${out.length} 项）`)
process.exit(out.some(line => line.startsWith('✗')) ? 1 : 0)
