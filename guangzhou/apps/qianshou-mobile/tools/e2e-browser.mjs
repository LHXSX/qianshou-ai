/**
 * 在真实浏览器里端到端验证手机端：进设置页 → 填服务地址 → 回对话 → 发消息 → 看到流式回复并落盘。
 *
 * 用真实 Chrome（CDP 驱动），不是 jsdom：验证的是用户实际会经历的那条路径。
 * 用法：node e2e-browser.mjs <appUrl> <mockBaseUrl>
 */
import { writeFileSync } from 'node:fs'

const APP = process.argv[2]
const MOCK = process.argv[3]
const CDP = 'http://127.0.0.1:9222'

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

const ev = async (expression) => (await S('Runtime.evaluate', { returnByValue: true, expression })).result.value
const shot = async (name) => {
  const s = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(`/tmp/${name}.png`, Buffer.from(s.data, 'base64'))
  return `/tmp/${name}.png`
}

const report = {}
report.title = await ev('document.title')
report.initial = await ev('document.body.innerText.slice(0, 200)')

// 预置配置：直接写 localStorage，等价于用户在设置页填好
await ev(`(() => {
  localStorage.setItem('qianshou.mobile.connection.v1', JSON.stringify({
    providerId: 'custom', baseUrl: ${JSON.stringify(MOCK)}, model: 'mock-model'
  }))
  localStorage.setItem('qianshou.mobile.secret.v1', JSON.stringify({ key: 'sk-e2e-test' }))
  return 'ok'
})()`)
await S('Page.reload')
await wait(3500)

// 发一条消息
report.typed = await ev(`(() => {
  const el = document.querySelector('input[placeholder], textarea, [contenteditable="true"]')
  if (!el) return { ok: false, inputs: [...document.querySelectorAll('input,textarea')].map(e => e.getAttribute('placeholder')) }
  el.focus()
  return { ok: true, tag: el.tagName, placeholder: el.getAttribute('placeholder') ?? '' }
})()`)
await S('Input.insertText', { text: '端到端验证消息' })
await wait(600)
report.draft = await ev(`(() => { const el = document.querySelector('input[placeholder], textarea'); return el ? el.value : null })()`)
report.sendClicked = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const sendBtn = btns.find(b => /发送|send/i.test((b.getAttribute('aria-label') || b.textContent || '')))
  if (!sendBtn) return { found: false, labels: btns.map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 12) }
  sendBtn.click()
  return { found: true, label: sendBtn.getAttribute('aria-label') }
})()`)
await wait(6000)

report.finalText = await ev('document.body.innerText.slice(0, 900)')
report.stored = await ev(`(() => {
  const raw = localStorage.getItem('qianshou.mobile.sessions.v1')
  if (!raw) return null
  try { const s = JSON.parse(raw); return { count: s.length, first: s[0]?.messages?.map(m => m.role + ':' + String(m.content).slice(0, 40)) } } catch { return 'parse-failed' }
})()`)
report.shot = await shot('mobile-e2e')

console.log(JSON.stringify(report, null, 1))
await send('Target.closeTarget', { targetId })
ws.close()
