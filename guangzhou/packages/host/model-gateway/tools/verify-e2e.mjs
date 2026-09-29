/**
 * 网关端到端真实验证：**真 HTTP 上游（本地 SSE 服务）+ 真实网关服务层**。
 *
 * 与单元测试的分工：单元测试换掉 forward、只测判定与账务；这里**不替换任何东西**，
 * 走真实 `fetch`、真实 SSE 解析、真实结算收尾，所以下面这些是被真的跑过一遍的：
 * 流式分片、上游用量回执、按 token 扣减、逐调用审计、上下文上限、档位降级、
 * 五小时刹车、并发上限、上游失败全额退回。
 *
 * 跑法：`PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/verify-e2e.mjs`
 * 退出码非 0 表示有断言没过。
 *
 * 一条踩坑记录：最开始的模拟上游用 `setInterval` 分块且**不调用 `flushHeaders()`**，
 * 结果网关侧要等 8 秒才收到回调，看起来像网关的流式有 bug。实际上 SSE 的每一帧
 * 都必须真的刷出去，否则它留在内核缓冲里，客户端就是收不到。现在这里显式
 * `flushHeaders()`，并用 `setTimeout` 链而非 `setInterval`，行为是确定的。
 */
import { createServer } from 'node:http'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'
import { statusForRejection } from '../src/routes.ts'
import { TIERS } from '../src/tiers.ts'

const seen = []
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    const slow = body.messages?.[0]?.content?.includes('SLOW') === true
    const step = slow ? 250 : 5
    seen.push({ model: body.model, auth: req.headers.authorization, stream: body.stream, streamOptions: body.stream_options, maxTokens: body.max_tokens })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const chunks = ['千手', '·迅捷', '答', '复']
    let i = 0
    const next = () => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`)
        i += 1
        setTimeout(next, step)
        return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    setTimeout(next, step)
  })
})
await new Promise(r => upstream.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${upstream.address().port}`

const ledger = createCreditLedger()
const routing = createRoutingConsole()
routing.publish({ publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic','plus','max'], maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
routing.bind({ publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: 0, reason: '端到端', operator: 'ceo', rolloutPercent: 100 })
routing.publish({ publishedName: '千手·强力', label: '千手·强力', tiers: ['plus','max'], maxOutputTokens: 16384, order: 1, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
routing.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: 0, reason: '端到端', operator: 'ceo', rolloutPercent: 100 })

const TIER = {}
const gateway = createGateway({ ledger, routing, tierOf: (id) => TIER[id] ?? 'basic', forwardConfig: { baseUrl, apiKey: () => 'sk-test-key' } })

const out = []
const check = (name, ok, detail) => { const l = `${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`; out.push(l); process.stdout.write(l + '\n'); return ok }

function send(call) {
  return new Promise((resolve) => {
    let text = ''
    const deltas = []
    const h = gateway.chat(call, {
      onDelta: (t) => { deltas.push(t); text += t },
      onDone: (r) => resolve({ text, deltas, done: r }),
      onError: (f) => resolve({ text, deltas, fail: f }),
    })
    void h.completed
  })
}

const ACCOUNT = 'acc-1'
TIER[ACCOUNT] = 'basic'
ledger.grant(ACCOUNT, 'basic', TIERS.basic.monthlySp)

// 1. 正常流式
const r1 = await send({ callId: 'c1', accountId: ACCOUNT, publishedName: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] })
check('流式：分片拼接正确', r1.text === '千手·迅捷答复', `text=${JSON.stringify(r1.text)}`)
check('流式：真的是多帧而非攒完一次给', r1.deltas.length >= 3, `chunks=${r1.deltas.length}`)
check('网关用我们的密钥打上游（密钥不出网关）', seen[0]?.auth === 'Bearer sk-test-key')
check('上游收到 stream:true 与 include_usage', seen[0]?.stream === true && seen[0]?.streamOptions?.include_usage === true)
check('输出长度上限真的传下去了', seen[0]?.maxTokens === 4096, `max_tokens=${seen[0]?.maxTokens}`)

// 2. 真实用量结算 + 账本精确
check('结算：按上游回执的真实 token 扣减', r1.done?.chargedSp === 0.07, `chargedSp=${r1.done?.chargedSp}`)
check('结算：余额精确、无浮点漂移', ledger.creditOf(ACCOUNT, 'basic').remainingMonthlySp === TIERS.basic.monthlySp - 0.07, `remaining=${ledger.creditOf(ACCOUNT, 'basic').remainingMonthlySp}`)
check('用量来源标注为上游回执', r1.done?.usageSource === 'provider')

// 3. 逐调用审计
const rec = ledger.recordsOf(ACCOUNT, 5)[0]
check('审计：留下调用记录', ledger.recordsOf(ACCOUNT, 5).length === 1)
check('审计：记真实 token 用量', rec?.inputTokens === 120 && rec?.outputTokens === 40, `i=${rec?.inputTokens} o=${rec?.outputTokens}`)
check('审计：记前台名而非上游厂商', rec?.publishedName === '千手·迅捷')
check('审计：记实际后端键供成本核对', rec?.backendKey === 'deepseek-flash')
check('审计：SP 与结算一致', rec?.sp === r1.done?.chargedSp)

// 4. 上下文上限（普通档 64K token；中文才能真的超）
const before4 = ledger.creditOf(ACCOUNT, 'basic').remainingMonthlySp
const r4 = await send({ callId: 'c4', accountId: ACCOUNT, publishedName: '千手·迅捷', messages: [{ role: 'user', content: '内'.repeat(65000) }] })
check('上下文上限：超限被拒', r4.fail?.rejection?.kind === 'context-too-long', `kind=${r4.fail?.rejection?.kind}`)
check('上下文上限：说明里给出真实数字', /65000 token/.test(r4.fail?.message ?? '') && /64000/.test(r4.fail?.message ?? ''))
check('上下文上限：拒绝映射到 400', statusForRejection(r4.fail?.rejection?.kind ?? '') === 400)
check('上下文上限：被拒不扣费、不留审计', ledger.recordsOf(ACCOUNT, 5).length === 1 && ledger.creditOf(ACCOUNT, 'basic').remainingMonthlySp === before4)

// 5. 档位：普通档用不了强力，且给出替代
const r5 = await send({ callId: 'c5', accountId: ACCOUNT, publishedName: '千手·强力', messages: [{ role: 'user', content: '你好' }] })
check('降级：普通档请求强力 → 继续作答，不是拒绝', r5.done !== undefined && r5.fail === undefined, `fail=${r5.fail?.message ?? ''}`)
check('降级：如实告知换成了哪个模型', r5.done?.publishedName === '千手·迅捷' && r5.done?.requestedName === '千手·强力' && r5.done?.downgraded === true, `作答=${r5.done?.publishedName} 请求=${r5.done?.requestedName}`)
check('降级：给用户一句可显示的说明（不能静默）', typeof r5.done?.downgradeNote === 'string' && r5.done.downgradeNote.includes('千手·迅捷'), `note=${r5.done?.downgradeNote}`)
check('档位：拒绝语义仍映射到 403（供"整档无可用模型"时用）', statusForRejection('model-not-in-tier') === 403)
const plusOk = await (async () => { TIER['acc-plus'] = 'plus'; ledger.grant('acc-plus', 'plus', TIERS.plus.monthlySp); return send({ callId: 'c5b', accountId: 'acc-plus', publishedName: '千手·强力', messages: [{ role: 'user', content: '你好' }] }) })()
check('档位：高级档用强力不降级', plusOk.done?.downgraded === false && plusOk.done?.publishedName === '千手·强力', `作答=${plusOk.done?.publishedName} 降级=${plusOk.done?.downgraded}`)

// 6. 额度不足 → 402
const POOR = 'acc-poor'
TIER[POOR] = 'basic'
ledger.grant(POOR, 'basic', 1)
const r6 = await send({ callId: 'c6', accountId: POOR, publishedName: '千手·迅捷', messages: [{ role: 'user', content: 'x'.repeat(30000) }] })
check('额度：不足时被拒', r6.fail?.rejection?.kind === 'no-credit', `kind=${r6.fail?.rejection?.kind}`)
check('额度：映射到 402（该付费了）', statusForRejection(r6.fail?.rejection?.kind ?? '') === 402)
check('额度：说明给出还剩多少/最多需要多少', /还剩 1 SP/.test(r6.fail?.message ?? ''), `msg=${r6.fail?.message?.slice(0,70)}`)

// 7. 并发上限（普通档 5）真的执行
const CONC = 'acc-conc'
TIER[CONC] = 'basic'
ledger.grant(CONC, 'basic', TIERS.basic.monthlySp)
const burst = await Promise.all(Array.from({ length: TIERS.basic.concurrency + 1 }, (_, i) =>
  send({ callId: `burst-${i}`, accountId: CONC, publishedName: '千手·迅捷', messages: [{ role: 'user', content: 'SLOW' }] })))
const accepted = burst.filter(r => r.done !== undefined).length
const throttled = burst.filter(r => r.fail?.rejection?.kind === 'too-many-concurrent').length
check(`并发：同时发 ${burst.length} 条，恰好放行 ${TIERS.basic.concurrency} 条`, accepted === TIERS.basic.concurrency, `放行=${accepted} 被拒=${throttled}`)
check('并发：超出的被拒且分类是并发（不是额度）', throttled === 1)
check('并发：映射到 429（该等一下）', statusForRejection('too-many-concurrent') === 429)
check('并发：刹车说明含具体上限数字', burst.find(r => r.fail)?.fail?.message?.includes(String(TIERS.basic.concurrency)) === true)
check('并发：被拒请求不留审计', ledger.recordsOf(CONC, 20).length === TIERS.basic.concurrency, `records=${ledger.recordsOf(CONC, 20).length}`)
const afterBurst = await send({ callId: 'after-burst', accountId: CONC, publishedName: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] })
check('并发：全部结束后额度位释放，下一条仍可发', afterBurst.done !== undefined, `fail=${afterBurst.fail?.kind ?? ''}`)

// 8. 上游失败全额退回
const ACC8 = 'acc-fail'
TIER[ACC8] = 'basic'
ledger.grant(ACC8, 'basic', TIERS.basic.monthlySp)
const before8 = ledger.creditOf(ACC8, 'basic').remainingMonthlySp
const dead = createGateway({ ledger, routing, tierOf: () => 'basic', forwardConfig: { baseUrl: 'http://127.0.0.1:1', apiKey: () => 'sk-test-key' } })
const r8 = await new Promise((resolve) => {
  const h = dead.chat({ callId: 'c8', accountId: ACC8, publishedName: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] },
    { onDelta: () => {}, onDone: (x) => resolve({ done: x }), onError: (f) => resolve({ fail: f }) })
  void h.completed
})
check('上游失败：如实报错且带分类', typeof r8.fail?.kind === 'string', `kind=${r8.fail?.kind}`)
check('上游失败：额度全额退回', ledger.creditOf(ACC8, 'basic').remainingMonthlySp === before8)

// 9. 五小时窗口刹车
const WIN = 'acc-win'
TIER[WIN] = 'plus'
ledger.grant(WIN, 'plus', TIERS.plus.monthlySp)
const big = '内'.repeat(200000) // 高级档 256K 上下文内，但预算很大
const wins = []
for (let i = 0; i < 6; i += 1) wins.push(await send({ callId: `w-${i}`, accountId: WIN, publishedName: '千手·强力', messages: [{ role: 'user', content: big }] }))
const windowHit = wins.filter(r => r.fail?.rejection?.kind === 'no-credit' && /五小时/.test(r.fail?.message ?? '')).length
check('五小时刹车：窗口额度耗尽后拒绝并说明是短时限流', windowHit >= 1, `命中=${windowHit} 用例=${wins.length}`)

upstream.close()
const bad = out.filter(l => l.startsWith('✗')).length
console.log(`\n结果：${out.length - bad}/${out.length} 通过`)
process.exit(bad > 0 ? 1 : 0)
