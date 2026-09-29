/**
 * 电脑端排版的真机测量。
 *
 * 在**真实页面**里注入与渲染器同构的 DOM，读**计算后**的样式——读到的是这个页面
 * 此刻真正生效的值（含主题令牌、用户字号设置、CSS Modules 的类名），不是我在源码里
 * 看到的字面量。手机端这轮的改动要同步到电脑端，就得先知道电脑端现在到底是多少。
 *
 * 不作假的地方：这里**不发消息**，也不改用户数据，只读样式度量。
 *
 * 用法：node tools/measure-pc-typography.mjs <带 token 的地址>
 * 前置：真实 Chrome 以 `--remote-debugging-port=9222` 启动。
 */
import { writeFileSync } from 'node:fs'

const URL_ = process.argv[2]
if (!URL_) throw new Error('用法：node tools/measure-pc-typography.mjs <url>')
const CDP = 'http://127.0.0.1:9222'

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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (method, params = {}) => send(method, params, sessionId)
await S('Page.enable')
await S('Runtime.enable')
// 桌面视口
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await S('Page.navigate', { url: URL_ })
await new Promise(resolve => setTimeout(resolve, 4000))

const evaluate = async (expression) => {
  const result = await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
  return result.result.value
}

const report = await evaluate(`(() => {
  // 真实类名从**已加载的样式表**里取（CSS Modules 会加哈希，写死会失效）。
  let rootClass = null
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      const selector = rule.selectorText ?? ''
      if (!selector.includes('markdown')) continue
      // 样式表里有两套含 "markdown" 的类名：文件类型图标那套（_markdown_1wejo_）
      // 和渲染器那套。渲染器同时声明了 min-width 与 overflow-wrap，用它来区分。
      if (!(rule.cssText ?? '').includes('overflow-wrap')) continue
      const found = /\\.([_A-Za-z0-9-]*markdown[_A-Za-z0-9-]*)/.exec(selector)
      if (found) { rootClass = found[1]; break }
    }
    if (rootClass) break
  }
  if (rootClass === null) return { error: '样式表里找不到 markdown 根类名' }

  // 主题令牌有没有真的解析出来（没解析的话量到的就是浏览器默认值，等于没量）。
  // 令牌由运行时注入的内联样式定义在 body 上，不是 :root。
  const rootStyle = getComputedStyle(document.body)
  const tokens = {
    base: rootStyle.getPropertyValue('--dsw-font-markdown-base').trim(),
    baseSize: rootStyle.getPropertyValue('--dsw-font-markdown-base-font-size').trim(),
    baseLineHeight: rootStyle.getPropertyValue('--dsw-font-markdown-base-line-height').trim(),
    h2: rootStyle.getPropertyValue('--dsw-font-markdown-h2').trim(),
  }

  const host = document.createElement('div')
  host.className = rootClass
  host.innerHTML = [
    '<p>这是第一段中文正文，用来量出行高与字号的真实比例，长度足够换行。</p>',
    '<p>这是第二段。</p>',
    '<h2>小标题</h2>',
    '<ul><li>列表项一</li><li>列表项二<ul><li>子要点</li></ul></li></ul>',
    '<blockquote>引用一句</blockquote>',
    '<table><thead><tr><th>列</th><th>值</th></tr></thead><tbody><tr><td>甲</td><td>1</td></tr></tbody></table>',
    '<pre><code>const x = 1</code></pre>',
  ].join('')
  host.style.position = 'absolute'
  host.style.left = '-9999px'
  host.style.width = '720px'
  document.body.append(host)

  const pick = (selector, props) => {
    const node = host.querySelector(selector)
    if (!node) return { found: false }
    const style = getComputedStyle(node)
    const out = { found: true }
    for (const prop of props) out[prop] = style.getPropertyValue(prop)
    return out
  }

  const measure = {
    rootClass,
    tokens,
    fontFamily: getComputedStyle(host).fontFamily,
    paragraph: pick('p', ['font-size', 'line-height', 'margin-top', 'text-align']),
    heading2: pick('h2', ['font-size', 'line-height', 'margin-top', 'font-weight']),
    listItem: pick('li', ['font-size', 'line-height', 'margin-top']),
    nestedList: pick('li ul', ['margin-top', 'padding-left']),
    blockquote: pick('blockquote', ['border-left-color', 'border-left-width', 'padding-left', 'color']),
    code: pick('code', ['font-family', 'font-size']),
    pre: pick('pre', ['margin-top', 'padding-left', 'background-color']),
    tableCell: pick('th', ['padding-top', 'border-bottom-color', 'border-bottom-width', 'font-size']),
  }

  host.remove()
  return measure
})()`)

writeFileSync(new URL('./measure-pc-typography.report.json', import.meta.url).pathname, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

await send('Target.closeTarget', { targetId })
socket.close()
