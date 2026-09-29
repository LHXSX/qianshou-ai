/**
 * 「回复排版」的真机（真实 Chrome）端到端验证。
 *
 * 要回答的问题只有一个：模型回的 Markdown，在**用户实际看到的那个页面里**，
 * 到底变成了元素，还是原样一坨标记？
 *
 * 用真实 Chrome 而不是 jsdom：`http://203.0.113.20:18090/` 上跑的是构建产物，
 * 而单元测试跑的是源码——两者可能不是一回事（这个项目就踩过：产物里的 bundle 是旧的）。
 *
 * 用法：node tools/e2e-answer-layout.mjs [appUrl] [mockBaseUrl]
 * 前置：真实 Chrome 以 `--remote-debugging-port=9222` 启动；假 LLM 服务端在 mockBaseUrl。
 */
import { writeFileSync } from 'node:fs'

const APP = process.argv[2] ?? 'http://127.0.0.1:3100/'
const MOCK = process.argv[3] ?? 'http://127.0.0.1:18999'
const CDP = 'http://127.0.0.1:9222'
const SHOT_DIR = new URL('../../../docs/dev-plan/assets/', import.meta.url).pathname

const version = await (await fetch(`${CDP}/json/version`)).json()
const socket = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})

/** 开一个新标签页，手机视口。 */
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (method, params = {}) => send(method, params, sessionId)
await S('Page.enable')
await S('Runtime.enable')
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

/** 在页面里求值；返回可序列化的值。 */
const evaluate = async (expression) => (await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })).result.value
/** 等待某个条件成立。 */
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expression)) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const report = { app: APP, mock: MOCK }

// 预置配置：等价于用户填好自己的地址与密钥（密钥是假的，只走本机假服务端）。
await S('Page.navigate', { url: APP })
await waitFor('!!document.querySelector(".suggest") || !!document.querySelector("input")')
await evaluate(`(() => {
  localStorage.setItem('qianshou.mobile.connection.v1', JSON.stringify({
    providerId: 'custom', baseUrl: ${JSON.stringify(MOCK)}, model: 'mock-model',
  }))
  localStorage.setItem('qianshou.mobile.secret.v1', JSON.stringify({ key: 'sk-e2e-layout' }))
  localStorage.removeItem('qianshou.mobile.sessions.v1')
})()`)
await S('Page.reload')
await waitFor('!!document.querySelector(".suggest") || !!document.querySelector("input")')

// 进对话屏
report.enteredChat = await evaluate(`(() => {
  const tile = document.querySelector('.suggest')
  if (tile) { tile.click(); return true }
  return !!document.querySelector('input')
})()`)
await new Promise(resolve => setTimeout(resolve, 400))

// 输入并发送
report.sent = await evaluate(`(() => {
  const input = document.querySelector('input')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '请给我一份结构化的说明')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const button = [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === '发送')
  if (!button) return false
  button.click()
  return true
})()`)

// 等回复**真正收流**：表格出现只说明流到了那里，不代表已经结束。
// 判据用状态行回到「就绪」且插入符消失——这两样是用户肉眼能看到的收尾标志。
await waitFor(`!!document.querySelector('.answer .md table')`, 25000)
report.settled = await waitFor(`(() => {
  const line = document.querySelector('.status-line')
  const text = line ? line.textContent.trim() : ''
  return (text === '就绪' || text === '') && !document.querySelector('.caret')
})()`, 20000)
await new Promise(resolve => setTimeout(resolve, 500))

report.statusLine = await evaluate(`(() => {
  const el = document.querySelector('.status-line')
  return el ? el.textContent.trim() : null
})()`)
report.caretVisible = await evaluate(`!!document.querySelector('.caret')`)

// 连带问题芯片：文字必须放得下，不能靠省略号硬切
report.followUps = await evaluate(`(() => {
  const chips = [...document.querySelectorAll('.follow')]
  return chips.map((chip) => {
    const label = chip.querySelector('.follow-text')
    return {
      label: label ? label.textContent : chip.textContent.trim(),
      title: chip.getAttribute('title'),
      clipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
    }
  })
})()`)

// 取 DOM 结构：这是"排版真的生效"的硬证据
report.structure = await evaluate(`(() => {
  const answer = document.querySelector('.answer')
  if (!answer) return null
  return {
    hasMd: !!answer.querySelector('.md'),
    h2: answer.querySelectorAll('h2').length,
    ul: answer.querySelectorAll('ul').length,
    ol: answer.querySelectorAll('ol').length,
    li: answer.querySelectorAll('li').length,
    nestedLi: answer.querySelectorAll('li > ul > li').length,
    table: answer.querySelectorAll('table').length,
    th: answer.querySelectorAll('table th').length,
    td: answer.querySelectorAll('table td').length,
    pre: answer.querySelectorAll('pre').length,
    blockquote: answer.querySelectorAll('blockquote').length,
    strong: answer.querySelectorAll('strong').length,
    inlineCode: answer.querySelectorAll('code').length,
  }
})()`)

// 标记泄露检查：这些字符串如果出现在**正文文本**里，就说明没解析
report.leaked = await evaluate(`(() => {
  const text = document.querySelector('.answer')?.textContent ?? ''
  const needles = ['##', '**', '| --- |', '\`\`\`', '- 列表项一']
  return needles.filter(needle => text.includes(needle))
})()`)

// 排版度量：字号、行高、表格是否横向溢出页面
report.metrics = await evaluate(`(() => {
  const answer = document.querySelector('.answer')
  const p = answer?.querySelector('.md p')
  const table = answer?.querySelector('table')
  const style = p ? getComputedStyle(p) : null
  return {
    bodyFontSize: getComputedStyle(document.body).fontSize,
    paragraphFontSize: style?.fontSize ?? null,
    paragraphLineHeight: style?.lineHeight ?? null,
    paragraphColor: style?.color ?? null,
    tableOverflowsPage: table ? table.getBoundingClientRect().right > window.innerWidth + 1 : null,
    horizontalPageScroll: document.documentElement.scrollWidth > window.innerWidth,
  }
})()`)

report.answerTextHead = await evaluate(`(document.querySelector('.answer')?.textContent ?? '').slice(0, 160)`)

// 留一张截图作为人眼证据
const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(`${SHOT_DIR}手机端回复排版.png`, Buffer.from(shot.data, 'base64'))
report.screenshot = `${SHOT_DIR}手机端回复排版.png`

writeFileSync(new URL('./e2e-answer-layout.report.json', import.meta.url).pathname, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

await send('Target.closeTarget', { targetId })
socket.close()
