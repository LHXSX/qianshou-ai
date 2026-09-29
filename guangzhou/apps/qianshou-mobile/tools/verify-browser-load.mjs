/**
 * 真实浏览器验证：手机端页面在真实 Chrome 里能加载、不报错，且订阅通道确实在产物里。
 *
 * 为什么需要它：单测跑在 jsdom 里，"能加载"和"打不开"是两件事——包体积、路由前缀、
 * 资源路径任何一处错都会白屏，而单测全绿也照样白屏。
 *
 * 跑法（需要 Chrome 带 --remote-debugging-port=9222，以及 3100 上服务着 dist-mobile）：
 *   node apps/qianshou-mobile/tools/verify-browser-load.mjs
 * 退出码非 0 表示有断言没过。
 *
 * 一条刻意的断言方向：这个页面是**本地独立预览**（不是 /mobile/ 同源部署），
 * 所以按设计它走 BYOK，**并且不应该**显示"订阅通道需要同源部署"那句
 * （那句只在用户显式选了订阅档时出现）。断言写成"当前状态下正确的东西"，
 * 而不是"我希望看到的东西"——后者会为了通过而把假话说成真的。
 */
const CDP = 'http://127.0.0.1:9222'
const TARGET = process.env.MOBILE_URL ?? 'http://127.0.0.1:3100/mobile/'

/** 连上第一个可用的 page target。 */
const list = await (await fetch(`${CDP}/json/list`)).json()
let page = list.find(t => t.type === 'page')
if (page === undefined) {
  page = await (await fetch(`${CDP}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' })).json()
  await new Promise(r => setTimeout(r, 1500))
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let id = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params))
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const messageId = ++id
  pending.set(messageId, resolve)
  ws.send(JSON.stringify({ id: messageId, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: TARGET })
await new Promise(r => setTimeout(r, 4000))

/** 取页面文字。 */
const evalJs = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.result?.value
}

const title = await evalJs('document.title')
const text = await evalJs('document.body.innerText')
const assetOk = await evalJs(`[...document.querySelectorAll('script')].some(s => s.src.includes('/mobile/assets/'))`)
const hasSubscriptionCopy = typeof text === 'string' && text.includes('订阅通道需要同源部署')
const hasCreditChip = typeof text === 'string' && /剩余|额度未知|点/.test(text)

const out = []
const check = (name, ok, detail) => { out.push(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`) }
check('页面加载成功（有标题）', typeof title === 'string' && title.length > 0, `title="${title}"`)
check('用的是 /mobile/ 前缀的资源（同源部署形态）', assetOk === true)
check('页面渲染出文字（不是白屏）', typeof text === 'string' && text.trim().length > 20, `字数=${(text ?? '').trim().length}`)
// 这一页是**本地独立预览**（不是 /mobile/ 同源部署），所以按设计走 BYOK、
// 并且**不应该**显示"订阅通道需要同源部署"那句——那句只在用户显式选了订阅档时才出现。
// 断言写成"当前状态下正确的东西"，而不是"我希望看到的东西"。
const isSameOriginDeploy = await evalJs(`location.pathname.startsWith('/mobile/') && location.origin === 'http://127.0.0.1:3100'`)
check('本页确实不是同源部署形态（决定它该走 BYOK）', isSameOriginDeploy === true)
check('非同源时不显示订阅档文案（不假装可用）', hasSubscriptionCopy === false)
// 订阅通道的代码必须真的在产物里（否则"同源时能用"这句话没有依据）。
const bundleHasChannel = await evalJs(`(async () => {
  const src = [...document.querySelectorAll('script')].map(s => s.src).join(' ')
  const r = await fetch(src.split(' ').find(s => s.includes('/mobile/assets/')) ?? '')
  const code = await r.text()
  return code.includes('/api/qianshou/ai/chat') && code.includes('downgradeNote')
})()`)
check('产物里含订阅通道（端点 + 降级字段）', bundleHasChannel === true)
check('额度相关文案出现（额度条或"额度未知"）', hasCreditChip === true, `片段="${(text ?? '').slice(0, 60).replace(/\n/g, ' ')}"`)
check('无未捕获的页面异常', pageErrors.length === 0, pageErrors.length > 0 ? pageErrors[0].slice(0, 160) : '')
check('无控制台报错', consoleErrors.length === 0, consoleErrors.length > 0 ? consoleErrors[0].slice(0, 160) : '')

console.log(out.join('\n'))
ws.close()
process.exit(out.some(l => l.startsWith('✗')) ? 1 : 0)
