/**
 * 抓取网关**真实发出的 SSE 字节**，存成契约样本。
 *
 * 为什么需要它：手机端（与将来的电脑端）解析的是网关的 SSE 帧。如果两边各自对着
 * 自己写的假数据做测试，会出现"双方都绿、合起来坏掉"——字段名差一个字母就足够。
 * 所以让网关**把真实字节吐出来**，存成一份样本，让消费端对着它做契约测试。
 *
 * 跑法：`PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/capture-wire.mjs --write`
 * 不带 `--write` 时只打印，不落盘。
 *
 * **消费端**：`apps/qianshou-mobile/tests/gateway-wire-contract.spec.ts` 直接读这份样本，
 * 用手机端真实的解析器去吃网关真实的字节。所以**改了帧结构就必须重跑本脚本**，
 * 否则那份契约测试会红——这是刻意的：两端各自对着自己的假数据测试，
 * 会出现"双方都绿、合起来坏掉"，字段名差一个字母就足够。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'
import { ADMIN_NAMES_PATH, createAiAdminRoutes } from '../src/admin-routes.ts'
import { AI_CHAT_PATH, createAiRoutes } from '../src/routes.ts'
import { TIERS } from '../src/tiers.ts'

const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.flushHeaders()
    // 用官方形状：用量在单独一帧、那一帧没有 choices。
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }], usage: null })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(r => upstream.listen(0, '127.0.0.1', r))

const ledger = createCreditLedger()
const routing = createRoutingConsole()
for (const [order, record] of [
  { publishedName: '千手·迅捷', tiers: ['basic','plus','max'], maxOutputTokens: 4096, backends: ['flash'] },
  { publishedName: '千手·强力', tiers: ['plus','max'], maxOutputTokens: 16384, backends: ['pro'] },
].entries()) {
  routing.publish({ publishedName: record.publishedName, label: record.publishedName, tiers: record.tiers, maxOutputTokens: record.maxOutputTokens, order, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
  routing.bind({ publishedName: record.publishedName, backendKeys: record.backends, effectiveFrom: 0, reason: '契约抓取', operator: 'system', rolloutPercent: 100 })
}
const gateway = createGateway({ ledger, routing, tierOf: () => 'basic', forwardConfig: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: () => 'k' } })
ledger.grant('契约账号', 'basic', TIERS.basic.monthlySp)
const routes = createAiRoutes({ gateway, ledger, tierOf: () => 'basic', authenticate: () => '契约账号' })
const adminRoutes = createAiAdminRoutes({ routing, authenticate: () => ({ accountId: '契约管理员', isAdmin: true }) })

/** 把一次响应的字节读干净。 */
async function bytesOf(response) {
  let out = ''
  for await (const chunk of response.body) out += new TextDecoder().decode(chunk)
  return out
}

/** 发一条对话。 */
async function chat(body) {
  return await bytesOf(await routes.chat(new Request(`http://127.0.0.1${AI_CHAT_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })))
}

const captured = {
  note: '由 packages/host/model-gateway/tools/capture-wire.mjs 从真实网关抓取；消费端应把它当作线上字节来解析。',
  capturedAt: new Date().toISOString(),
  chatPath: AI_CHAT_PATH,
  success: await chat({ model: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] }),
  downgraded: await chat({ model: '千手·强力', messages: [{ role: 'user', content: '你好' }] }),
  rejectedQuota: await chat({ model: '千手·迅捷', messages: [{ role: 'user', content: '内'.repeat(200000) }] }),
  rejectedUnknownModel: await chat({ model: '不存在的模型', messages: [{ role: 'user', content: '你好' }] }),
  rejectedBadBody: await chat({ messages: [] }),
}

/**
 * 管理面目录：控制台面板解析的就是它。
 *
 * 为什么也要抓真实的：简报里我写的是"顶层有 `bindings`"，而实现把历史挂在
 * `names[].history` 上——**简报写错了**。控制台子智能体按实际代码做了兼容，
 * 但"按某人的描述实现"和"对着真实响应验证"是两件事。抓下来存成夹具，
 * 让控制台侧也有一份不可争辩的样本。
 */
const adminCaptured = {
  note: '由 packages/host/model-gateway/tools/capture-wire.mjs 从真实 admin 处理器抓取。',
  capturedAt: new Date().toISOString(),
  namesPath: ADMIN_NAMES_PATH,
  names: await (async () => {
    const response = await adminRoutes.names(new Request(`http://127.0.0.1${ADMIN_NAMES_PATH}`, { method: 'POST', body: '{}' }))
    return await response.json()
  })(),
}

const text = `${JSON.stringify(captured, null, 2)}\n`
const adminText = `${JSON.stringify(adminCaptured, null, 2)}\n`
if (process.argv.includes('--write')) {
  // 从本文件位置推到仓库根，再落到手机端的 fixtures 目录。
  // 消费端（手机端）的契约测试直接读这个文件——它必须能被单独运行，不该依赖抓取端在场。
  const here = dirname(fileURLToPath(import.meta.url))
  const target = join(here, '..', '..', '..', '..', 'apps', 'qianshou-mobile', 'tests', 'fixtures', 'gateway-wire.json')
  writeFileSync(target, text)
  console.log(`已写入 ${target}`)
  const adminTarget = join(here, '..', '..', '..', '..', 'packages', 'client', 'ui-settings-routing', 'tests', 'fixtures', 'admin-names-wire.json')
  mkdirSync(dirname(adminTarget), { recursive: true })
  writeFileSync(adminTarget, adminText)
  console.log(`已写入 ${adminTarget}`)
} else {
  console.log(text)
}
upstream.close()
process.exit(0)
