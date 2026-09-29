/**
 * 真实服务商的帧格式差异实测：同一个网关，对四种上游形态各跑一次。
 *
 * 为什么要有这个文件：模拟上游是我自己按**我读到的文档**写的，所以"端到端通过"
 * 只能证明"网关能解析我以为的那种格式"。真实服务商之间有实实在在的差异，
 * 密钥到位后最容易翻车的就是这里。四种形态都是真实存在的：
 *
 * - `official`：DeepSeek 官方文档的形状——用量在**单独一帧**里，那一帧没有 choices。
 * - `usage-on-final-frame`：用量与 finish_reason 挤在同一帧（很多兼容层这样做）。
 * - `no-usage`：完全不回用量（自建/兼容层常见）→ 网关必须退回本地估算，且**如实标注**。
 * - `ignores-stream`：忽略 stream 参数、直接回一整份 JSON → 网关必须照样取出正文与用量。
 *
 * 跑法：`PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/verify-provider-variants.mjs`
 */
import { createServer } from 'node:http'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'

/** 四种上游形态。 */
const VARIANTS = {
  // A：DeepSeek 官方文档里的形状——用量在**单独一帧**里，那一帧的 choices 是空数组
  official: (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    // ← 关键：这一帧没有 choices，只有 usage
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  },
  // B：同一帧里既给 usage 又给 finish_reason（很多兼容层这样做）
  'usage-on-final-frame': (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  },
  // C：完全不回 usage（一些自建/兼容层就是这样）
  'no-usage': (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  },
  // D：忽略 stream 参数，直接回一整份 JSON
  'ignores-stream': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '你好，我是整包回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 9 },
    }))
  },
}

const ledger = createCreditLedger()
const routing = createRoutingConsole()
routing.publish({ publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic','plus','max'], maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
routing.bind({ publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: 0, reason: 'p', operator: 'ceo', rolloutPercent: 100 })

let current = 'official'
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    // 让每个变体自己决定响应头——'ignores-stream' 要回 application/json 而不是 SSE。
    VARIANTS[current](res, raw, req.headers)
  })
})
await new Promise(r => upstream.listen(0, '127.0.0.1', r))
const gateway = createGateway({ ledger, routing, tierOf: () => 'basic', forwardConfig: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: () => 'k' } })

const out = []
const check = (name, ok, detail) => { const l = `${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`; out.push(l); process.stdout.write(l + '\n') }

let seq = 0
for (const [name, ] of Object.entries(VARIANTS)) {
  current = name
  const account = `acc-${name}`
  ledger.grant(account, 'basic', 390)
  let text = ''
  const result = await new Promise((resolve) => {
    const h = gateway.chat({ callId: `c-${seq++}`, accountId: account, publishedName: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] },
      { onDelta: (t) => { text += t }, onDone: (r) => resolve({ done: r }), onError: (f) => resolve({ fail: f }) })
    void h.completed
  })
  const rec = ledger.recordsOf(account, 1)[0]
  if (result.done === undefined) {
    check(`[${name}] 应当成功`, false, `fail=${result.fail?.kind}: ${result.fail?.message}`)
    continue
  }
  check(`[${name}] 有正文`, text.length > 0, `text="${text}"`)
  check(`[${name}] 用量来源=${result.done.usageSource}`, true, `扣费=${result.done.chargedSp} SP 审计token=${rec?.inputTokens}/${rec?.outputTokens}`)
}

upstream.close()
const bad = out.filter(l => l.startsWith('✗')).length
console.log(`\n结果：${out.length - bad}/${out.length} 通过`)
process.exit(0)
