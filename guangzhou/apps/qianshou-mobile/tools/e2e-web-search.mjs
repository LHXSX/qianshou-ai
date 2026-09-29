/**
 * 「联网搜索」的真机（真实 Chrome）端到端验证。
 *
 * 用真实 Chrome（CDP 驱动）在手机视口下走一遍用户会走的路：打开开关 → 看到去向说明 →
 * 发一条消息 → 看着状态从「正在搜索…」走到「正在整理…」再回到「就绪」→ 回复与来源上屏。
 * 同时记录**页面发出的每一个请求 URL**：这是"开关在请求层面真的产生了差异"的硬证据。
 *
 * 顺带验证历史入口：截对话屏（顶栏历史按钮应在首屏可见），点它进历史页。
 *
 * 用法：node tools/e2e-web-search.mjs <appUrl> <mockBaseUrl>
 */
import { writeFileSync } from 'node:fs'

const APP = process.argv[2] ?? 'http://127.0.0.1:3100/'
const MOCK = process.argv[3] ?? 'http://127.0.0.1:18999'
const CDP = 'http://127.0.0.1:9222'
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? '/tmp'

const ver = await (await fetch(`${CDP}/json/version`)).json()
const ws = new WebSocket(ver.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable')
await S('Runtime.enable')
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await S('Page.navigate', { url: APP })
const wait = ms => new Promise(r => setTimeout(r, ms))
await wait(4000)

const ev = async (expression) => (await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })).result.value
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = `${SHOT_DIR}/${name}.png`
  writeFileSync(path, Buffer.from(s.data, 'base64'))
  return path
}

const report = {}
report.title = await ev('document.title')

// 预置配置：等价于用户在设置页填好 DeepSeek 的地址与密钥（密钥是用户自己的，测试用假的）。
await ev(`(() => {
  localStorage.setItem('qianshou.mobile.connection.v1', JSON.stringify({
    providerId: 'deepseek', baseUrl: ${JSON.stringify(`${MOCK}/v1`)}, model: 'deepseek-chat'
  }))
  localStorage.setItem('qianshou.mobile.secret.v1', JSON.stringify({ key: 'sk-e2e-test' }))
  localStorage.removeItem('qianshou.mobile.sessions.v1')
  return 'ok'
})()`)
await S('Page.reload')
await wait(3500)

// 记录请求与状态文字：请求在页面侧抓，状态用 MutationObserver 抓，避免轮询漏帧。
await ev(`(() => {
  window.__requests = []
  const original = window.fetch
  window.fetch = (...args) => {
    try { window.__requests.push(String(args[0] instanceof Request ? args[0].url : args[0])) } catch {}
    return original(...args)
  }
  window.__statusLog = []
  const record = () => {
    const el = document.querySelector('.status-line')
    const text = el ? el.textContent.trim() : ''
    if (window.__statusLog[window.__statusLog.length - 1] !== text) window.__statusLog.push(text)
  }
  window.__statusTimer = setInterval(record, 10)
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true })
  record()
  return 'ok'
})()`)

// 打开「联网搜索」开关：它必须在发送之前就把这一条的去处说清楚。
report.chipOpen = await ev(`(() => {
  const chip = [...document.querySelectorAll('.chip')].find(node => node.textContent.includes('联网搜索'))
  if (!chip) return { ok: false, chips: [...document.querySelectorAll('.chip')].map(n => n.textContent) }
  chip.click()
  return { ok: true }
})()`)
await wait(400)
report.chipOpen.checked = await ev(`(() => {
  const chip = [...document.querySelectorAll('.chip')].find(node => node.textContent.includes('联网搜索'))
  return chip ? { on: chip.className.includes('on'), text: chip.textContent.trim() } : null
})()`)
report.searchNote = await ev(`(() => { const el = document.querySelector('.search-note'); return el ? { text: el.textContent.trim(), active: el.className.includes('on') } : null })()`)
report.topBarLabels = await ev(`[...document.querySelectorAll('.head [aria-label]')].map(n => n.getAttribute('aria-label'))`)

// 发一条消息（走手机自己的搜索循环：预览服务没有电脑网关，电脑判定为不可达）。
report.typed = await ev(`(() => {
  const el = document.querySelector('input')
  if (!el) return { ok: false }
  el.focus()
  return { ok: true, placeholder: el.getAttribute('placeholder') ?? '' }
})()`)
await S('Input.insertText', { text: '今天有什么新闻？' })
await wait(400)
report.draft = await ev(`(() => { const el = document.querySelector('input'); return el ? el.value : null })()`)
report.sendClicked = await ev(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '发送')
  if (!btn) return { found: false, labels: [...document.querySelectorAll('[aria-label]')].map(n => n.getAttribute('aria-label')).slice(0, 12) }
  btn.click()
  return { found: true }
})()`)

// 等收尾：状态回到「就绪」且发送按钮回来。
const deadline = Date.now() + 20000
let settled = false
while (Date.now() < deadline) {
  settled = await ev(`(() => {
    const el = document.querySelector('.status-line')
    return (el ? el.textContent.trim() : '') === '就绪' && !!document.querySelector('button.send')
  })()`)
  if (settled) break
  await wait(200)
}
report.settled = settled

report.statusSequence = await ev('window.__statusLog')
report.requests = await ev(`window.__requests.map(u => u.replace(${JSON.stringify(MOCK)}, '<mock>'))`)
report.answerText = await ev(`(() => { const el = document.querySelector('.answer'); return el ? el.textContent.trim() : null })()`)
report.sourcesLine = await ev(`(() => { const el = document.querySelector('.search-sources'); return el ? el.textContent.trim() : null })()`)
report.searchNoteAfterSend = await ev(`(() => { const el = document.querySelector('.search-note'); return el ? el.textContent.trim() : null })()`)
report.chatShot = await shot('mobile-web-search')

// 历史入口：顶栏按钮就在首屏，点一下应进入历史页。
report.historyEntry = await ev(`(() => {
  const btn = document.querySelector('.head [aria-label="历史对话"]')
  if (!btn) return { present: false, labels: [...document.querySelectorAll('.head [aria-label]')].map(n => n.getAttribute('aria-label')) }
  const rect = btn.getBoundingClientRect()
  btn.click()
  return { present: true, visibleInViewport: rect.top >= 0 && rect.bottom <= window.innerHeight }
})()`)
await wait(600)
report.historyView = await ev(`(() => ({
  local: document.body.innerText.includes('这台手机的对话'),
  pc: document.body.innerText.includes('发到电脑的指令'),
  hasBackButton: !!document.querySelector('[aria-label="返回"]'),
}))()`)
report.historyShot = await shot('mobile-history')

// 抽屉里的同一个入口：不滚动就能看到（原来它在 14 项之后）。
report.drawer = await ev(`(() => {
  const back = document.querySelector('.head [aria-label="返回"]')
  if (back) back.click()
  return 'back'
})()`)
await wait(500)
await ev(`(() => {
  const menu = document.querySelector('.head [aria-label="菜单"]')
  if (menu) menu.click()
  return 'menu'
})()`)
await wait(600)
report.drawerEntry = await ev(`(() => {
  const items = [...document.querySelectorAll('.drawer-list .d-item')]
  const index = items.findIndex(item => item.textContent.includes('历史对话'))
  const entry = items[index]
  return {
    index,
    total: items.length,
    needsScroll: entry ? entry.getBoundingClientRect().bottom > window.innerHeight : null,
    labels: items.slice(0, 7).map(item => item.textContent.trim()),
  }
})()`)
report.drawerShot = await shot('mobile-drawer')

report.stored = await ev(`(() => {
  const raw = localStorage.getItem('qianshou.mobile.sessions.v1')
  if (!raw) return null
  try { const s = JSON.parse(raw); return { count: s.length, roles: s[0]?.messages?.map(m => m.role), answer: String(s[0]?.messages?.[1]?.content ?? '').slice(0, 60) } } catch { return 'parse-failed' }
})()`)

console.log(JSON.stringify(report, null, 1))
await send('Target.closeTarget', { targetId })
ws.close()
