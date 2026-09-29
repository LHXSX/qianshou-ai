/**
 * 窄屏裁剪扫描器：首页之外，别的页有没有"同一类"越界被裁的问题？
 *
 * 首页那份缺陷（tile 栅格撑破 `.phone` 的 `overflow: hidden`）只是这个类的一个实例。
 * 这个探针把"同类"的定义写死成可判定的形式，然后逐屏去量，避免靠肉眼看截图下结论。
 *
 * ## 判定口径
 *
 * - `clipped[]`：元素越出**最近一个会裁剪的祖先**（`overflow-x` 为 `hidden`/`clip`）的
 *   padding box 超过 0.5px。这就是首页那种"被外层裁掉"——不是滚动，是**看不见**。
 * - `hScrollContainers[]`：元素越出最近一个**可横向滚动**的祖先（`overflow-x` 为
 *   `auto`/`scroll`），且那个祖先的 `scrollWidth > clientWidth`。这类是"能滑出来"，与
 *   上一条性质不同，所以分开报，不混为一谈。
 * - `docHScroll`：整页 `scrollWidth > clientWidth`（出现横向滚动条）。
 *
 * ## 仪器自证（positive control）
 *
 * 一个只会说"没问题"的检测器毫无价值。所以每次运行都先做阳性对照：把**修复前那两条 CSS
 * 规则**用 CDP 注入回首页（只注入，不碰文件），此时扫描器**必须**报出那两张 tile 被裁；
 * 再把注入的样式删掉，必须报 0。自证通过才继续扫其余页面，否则直接以退出码 2 结束。
 *
 * 用法：
 *   node tools/probe-narrow-clipping.mjs <appUrl> <outDir> [width]
 * 退出码：0 = 扫完且无裁剪；1 = 发现裁剪；2 = 阳性对照失败（探针本身不可信）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.argv[2] ?? 'http://127.0.0.1:4174/'
const OUT_DIR = process.argv[3] ?? '/tmp/qianshou-screens'
const WIDTH = Number(process.argv[4] ?? 320)
const HEIGHT = WIDTH <= 320 ? 568 : WIDTH <= 375 ? 667 : WIDTH <= 393 ? 852 : 915
const CDP = process.env['CDP_URL'] ?? 'http://127.0.0.1:9222'

/** 修复前首页那两条规则：阳性对照靠它把已知缺陷重新造出来。 */
const LEGACY_HOME_CSS = `
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tile { padding: 10px 8px 10px 10px; gap: 8px; }
`

mkdirSync(OUT_DIR, { recursive: true })

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
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const ev = async (expression) => {
  const res = await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? 'unknown'}`)
  return res.result.value
}

const SCAN = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''
    return el.tagName.toLowerCase() + cls
  }
  const vw = window.innerWidth
  const de = document.documentElement
  const clipped = []
  const inInnerScroller = []
  let maxRight = 0, maxRightSel = ''

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (r.right > maxRight) { maxRight = r.right; maxRightSel = name(el) }

    // 往上走完整条祖先链，把"会裁剪的边界"全部累计起来。
    // 内层的 overflow-x: auto 若只是纵向滚动容器按规范把 x 也算成 auto（盒子跟视口一样宽），
    // 那不是"故意可横滑"，照样算边界；只有比视口窄的内层横滑条（.cat 那种）才放行。
    let anc = el.parentElement
    let boundaryRight = Infinity, boundaryLeft = -Infinity, clippedBy = null, worst = 0
    let innerStrip = null
    while (anc) {
      const acs = getComputedStyle(anc)
      const ox = acs.overflowX
      if (ox !== 'visible') {
        const ar = anc.getBoundingClientRect()
        const isNarrowScroller = (ox === 'auto' || ox === 'scroll') && ar.width < vw - 1
        if (isNarrowScroller) {
          if (anc.scrollWidth > anc.clientWidth + 1) innerStrip = name(anc)
        } else {
          const over = Math.max(r.right - ar.right, ar.left - r.left)
          if (over > worst) { worst = over; clippedBy = name(anc) }
          boundaryRight = Math.min(boundaryRight, ar.right)
          boundaryLeft = Math.max(boundaryLeft, ar.left)
        }
      }
      anc = anc.parentElement
    }
    const beyond = Math.max(r.right - boundaryRight, boundaryLeft - r.left)
    if (beyond > 0.5) {
      const rec = {
        el: name(el), clippedBy, over: r1(beyond), overflowX: 'hidden',
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18),
      }
      // 内层横滑条里的元素是"滑一下就能看到"，与"看不见"不同性质，分开记。
      if (innerStrip) inInnerScroller.push({ ...rec, innerScroller: innerStrip })
      else clipped.push(rec)
    }
  }
  const byOver = (a, b) => b.over - a.over
  clipped.sort(byOver); inInnerScroller.sort(byOver)
  return {
    href: location.href,
    innerWidth: vw,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    docHScroll: de.scrollWidth > de.clientWidth,
    maxRight: r1(maxRight), maxRightSelector: maxRightSel, overBy: r1(maxRight - vw),
    clippedCount: clipped.length, clipped: clipped.slice(0, 8),
    inInnerScrollerCount: inInnerScroller.length, inInnerScroller: inInnerScroller.slice(0, 5),
  }
})()`

const shot = async (file) => {
  const s = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(`${OUT_DIR}/${file}.png`, Buffer.from(s.data, 'base64'))
  return `${OUT_DIR}/${file}.png`
}

await S('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true })
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await S('Page.navigate', { url: APP })
const deadline = Date.now() + 25000
while (Date.now() < deadline && !(await ev('!!document.querySelector(".tab")').catch(() => false))) await wait(200)
await wait(600)

const report = { app: APP, width: WIDTH, height: HEIGHT, at: new Date().toISOString(), positiveControl: null, screens: [] }

// ---- 阳性对照：先证明这个检测器真的能抓到首页那个已知缺陷 ----
await ev(`(() => {
  const s = document.createElement('style')
  s.id = 'probe-legacy-home'
  s.textContent = ${JSON.stringify(LEGACY_HOME_CSS)}
  document.head.appendChild(s)
  return 'ok'
})()`)
await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
const withLegacy = await ev(SCAN)
const controlShot = await shot(`control-legacy-${WIDTH}`)
await ev(`document.getElementById('probe-legacy-home').remove()`)
await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
const withoutLegacy = await ev(SCAN)

report.positiveControl = {
  expectation: '注入修复前的规则后必须抓到 .tile 被裁；移除后必须为 0',
  withLegacy: { clippedCount: withLegacy.clippedCount, clipped: withLegacy.clipped, overBy: withLegacy.overBy, screenshot: controlShot },
  withoutLegacy: { clippedCount: withoutLegacy.clippedCount, clipped: withoutLegacy.clipped, overBy: withoutLegacy.overBy },
}
const controlOk = withLegacy.clippedCount > 0 && withoutLegacy.clippedCount === 0
console.log(`阳性对照：注入修复前规则 → 裁剪 ${withLegacy.clippedCount} 处（越界 ${withLegacy.overBy}px）；移除后 → ${withoutLegacy.clippedCount} 处  ⇒ ${controlOk ? '通过' : '失败'}`)
if (!controlOk) {
  writeFileSync(`${OUT_DIR}/screens-report-${WIDTH}.json`, JSON.stringify(report, null, 2))
  console.error('阳性对照失败：这个检测器连已知缺陷都抓不到，后续结论一律不可信。')
  process.exit(2)
}

// ---- 逐屏扫描：底部导航每一个 tab ----
const tabs = await ev(`[...document.querySelectorAll('.tab')].map((b, i) => ({ i, label: b.textContent.trim() }))`)
for (const tab of tabs) {
  await ev(`(() => { const b = document.querySelectorAll('.tab')[${tab.i}]; if (b) b.click(); return 'ok' })()`)
  await wait(900)
  const m = await ev(SCAN)
  m.screen = tab.label
  m.screenshot = await shot(`screen-${tab.i}-${tab.label}-${WIDTH}`)
  report.screens.push(m)
  console.log(
    `${String(tab.i).padStart(2)} ${tab.label.padEnd(4)}  看不见=${String(m.clippedCount).padStart(2)}` +
    `  内层横滑条内=${String(m.inInnerScrollerCount).padStart(2)}  整页横向滚动=${m.docHScroll}  overBy=${m.overBy}` +
    (m.clippedCount ? `  最严重：${m.clipped[0].el}「${m.clipped[0].text}」超出 ${m.clipped[0].clippedBy} ${m.clipped[0].over}px` : ''),
  )
}

const totalClipped = report.screens.reduce((n, s) => n + s.clippedCount, 0)
const totalHScroll = report.screens.reduce((n, s) => n + s.inInnerScrollerCount, 0)
report.totalClipped = totalClipped
report.totalInInnerScroller = totalHScroll
writeFileSync(`${OUT_DIR}/screens-report-${WIDTH}.json`, JSON.stringify(report, null, 2))
console.log(`\n合计：看不见（越出裁剪边界）${totalClipped} 处，位于内层横滑条内 ${totalHScroll} 处`)
console.log(`report -> ${OUT_DIR}/screens-report-${WIDTH}.json`)
await Promise.race([send('Target.closeTarget', { targetId }).catch(() => {}), wait(2000)]).catch(() => {})
ws.close()
if (totalClipped > 0) process.exitCode = 1
