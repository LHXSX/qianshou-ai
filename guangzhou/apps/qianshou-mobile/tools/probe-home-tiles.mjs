/**
 * 首页 tile 栅格的窄屏布局探针（可复跑，也可当作回归门禁）。
 *
 * ## 要解决的问题
 *
 * 真实 Chrome 实测到：首页四张能力卡的第二列在窄视口下越出右边界，320 宽时越界 58.8px
 * （"任务运行"卡右侧的箭头整块跑到视口外），被 `.phone` 的 `overflow: hidden` 裁掉。
 *
 * 根因（本探针能量出来）：`.grid` 原本写的是 `grid-template-columns: 1fr 1fr`。
 * `1fr` 的完整含义是 `minmax(auto, 1fr)`，那个 `auto` 下限**就是卡片的 min-content 宽度**；
 * 卡片里的标题与副标题都是 `white-space: nowrap`，min-content 等于"一个字都不折行"的
 * 宽度。于是两列 + 8px 间距 = 362.8px 是栅格**缩不下去的绝对下限**：容器比它窄，
 * 栅格就整块溢出（列宽相等性也一起丢掉：实测第一列 174.7 / 第二列 180.2）。
 *
 * ## 它量什么（全部来自真实布局，没有估算）
 *
 * - `tiles[].overBy`        单张卡 right 超出 `innerWidth` 多少像素（>0 即越界）
 * - `overBy`                整页所有可见元素里最右边界超出多少（比只看卡片更严）
 * - `gridOverflow`          卡片右边界超出 `.grid` 内容盒多少（栅格有没有撑破自己的容器）
 * - `horizontalScroll`      `scrollWidth > clientWidth`（有没有横向滚动条）
 * - `text[].truncated`      `scrollWidth > clientWidth`，被 ellipsis 吃掉字
 * - `text[].lineCount`      行盒数量（`Range.getClientRects` 一行一个矩形）
 * - `text[].singleCharColumn` 行数 ≥2 且每行 ≤1.5 字（被压成竖排单字）
 * - `demand[].need`         把卡片克隆到离屏 `width: max-content` 容器里量一次再删掉：
 *                           这张卡"一个字都不裁"所需的最小宽度。修复后 `need ≤ 列宽`
 *                           就是"没裁字"的硬证据，也是选栅格下限的依据。
 *
 * ## 用法
 *
 *   node tools/probe-home-tiles.mjs <appUrl> <outDir> [--diag] [--check]
 *
 * 例：
 *   node tools/probe-home-tiles.mjs http://127.0.0.1:4174/ /tmp/tiles/before --diag
 *   node tools/probe-home-tiles.mjs http://127.0.0.1:4174/ /tmp/tiles/after --check
 *
 * 输出：
 *   <outDir>/probe-report.json     五个视口的原始数字
 *   <outDir>/<width>x<height>.png  每个视口一张截图
 * 退出码：`--check` 下发现任一违规项即 1，否则 0（可直接当门禁用）。
 *
 * 依赖：只用一个跑着 `--remote-debugging-port=9222` 的真实 Chrome，Node 原生 WebSocket，
 * 不装任何依赖。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const APP = process.argv[2] ?? 'http://127.0.0.1:4174/'
const OUT_DIR = process.argv[3] ?? '/tmp/qianshou-tiles'
const DIAG = process.argv.includes('--diag')
const CHECK = process.argv.includes('--check')
const CDP = process.env['CDP_URL'] ?? 'http://127.0.0.1:9222'

/** 要覆盖的五个宽度：小屏安卓、iPhone SE、iPhone 15、大屏安卓、折叠屏/桌面预览。 */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
  { width: 744, height: 1133 },
]

/** 判定阈值：0.5px 是子像素取整的容差，不是"差不多就行"。 */
const TOL = 0.5

mkdirSync(OUT_DIR, { recursive: true })

// 把"报告"和"当时的源码"钉在一起：两份报告的数字才有资格放在一起比。
const stylesPath = new URL('../src/styles.css', import.meta.url)
const stylesSha256 = createHash('sha256').update(readFileSync(stylesPath)).digest('hex').slice(0, 16)

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
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const ev = async (expression) => {
  const res = await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`)
  return res.result.value
}

/** 页面侧量法。一次 evaluate 把所有数字取回来，避免多次往返之间布局已经变了。 */
const MEASURE = `(() => {
  const r1 = (n) => Math.round(n * 10) / 10
  const vw = window.innerWidth
  const de = document.documentElement
  const body = document.body
  const grid = document.querySelector('.grid')

  // ---- 1. 卡片几何 ----
  const tiles = [...document.querySelectorAll('.tile')].map((el, index) => {
    const r = el.getBoundingClientRect()
    const b = el.querySelector('b')
    const small = el.querySelector('small')
    // 卡片内部元素有没有跑到卡片外面（比"越出视口"更早发现问题）
    let childOver = 0
    for (const node of el.querySelectorAll('*')) {
      const cr = node.getBoundingClientRect()
      if (cr.width === 0 && cr.height === 0) continue
      childOver = Math.max(childOver, cr.right - r.right, r.left - cr.left)
    }
    return {
      index,
      title: b ? b.textContent.trim() : '',
      desc: small ? small.textContent.trim() : '',
      left: r1(r.left), right: r1(r.right), width: r1(r.width), height: r1(r.height),
      overBy: r1(r.right - vw),
      childEscape: r1(Math.max(0, childOver)),
    }
  })

  // ---- 2. 栅格自身有没有撑破容器 ----
  let gridBox = null
  if (grid) {
    const gr = grid.getBoundingClientRect()
    const gcs = getComputedStyle(grid)
    const contentRight = gr.right - parseFloat(gcs.paddingRight || '0')
    const contentLeft = gr.left + parseFloat(gcs.paddingLeft || '0')
    const tileRight = tiles.length ? Math.max(...tiles.map(t => t.right)) : contentLeft
    const tileLeft = tiles.length ? Math.min(...tiles.map(t => t.left)) : contentLeft
    gridBox = {
      left: r1(gr.left), right: r1(gr.right), width: r1(gr.width),
      contentLeft: r1(contentLeft), contentRight: r1(contentRight),
      columns: gcs.gridTemplateColumns,
      columnGap: gcs.columnGap,
      gridOverflow: r1(tileRight - contentRight),
      gridUnderflowLeft: r1(contentLeft - tileLeft),
    }
  }

  // ---- 3. 整页最右边界 ----
  let maxRight = 0
  let maxRightSel = ''
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (r.right > maxRight) {
      maxRight = r.right
      maxRightSel = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
    }
  }

  // ---- 4. 文本行盒 / 截断 ----
  const textOf = (el, where) => {
    if (!el) return null
    const text = el.textContent || ''
    const cs = getComputedStyle(el)
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = [...range.getClientRects()].filter(r => r.width > ${TOL} && r.height > ${TOL})
    const lineCount = Math.max(1, rects.length)
    const charsPerLine = text.length / lineCount
    // 文字自身的推进宽度：一行行盒从左到右的跨度，和"字被裁没被裁"是两回事。
    const advanceWidth = rects.length
      ? r1(Math.max(...rects.map(r => r.right)) - Math.min(...rects.map(r => r.left)))
      : 0
    return {
      where, text, chars: text.length, lineCount,
      charsPerLine: Math.round(charsPerLine * 100) / 100,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily.split(',')[0],
      advanceWidth,
      whiteSpace: cs.whiteSpace,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      truncated: el.scrollWidth > el.clientWidth + 1,
      singleCharColumn: lineCount >= 2 && charsPerLine <= 1.5,
    }
  }
  const text = []
  for (const el of document.querySelectorAll('.tile')) {
    const b = textOf(el.querySelector('b'), '.tile b')
    const s = textOf(el.querySelector('small'), '.tile small')
    if (b) text.push(b)
    if (s) text.push(s)
  }

  // ---- 5. 卡片真实需要的宽度（离屏 max-content 克隆，量完立刻删掉）----
  // 标题/副标题都是 nowrap，所以 max-content 就是"一个字都不裁"所需的最小宽度。
  const demand = []
  const holder = document.createElement('div')
  holder.setAttribute('data-probe', 'tile-demand')
  holder.style.cssText = 'position:absolute;left:-10000px;top:0;width:max-content;'
  document.body.appendChild(holder)
  for (const el of document.querySelectorAll('.tile')) {
    const clone = el.cloneNode(true)
    holder.appendChild(clone)
    const need = clone.getBoundingClientRect().width
    demand.push({
      title: (el.querySelector('b') || {}).textContent?.trim() ?? '',
      need: r1(need),
    })
    holder.removeChild(clone)
  }
  holder.remove()

  const out = {
    href: location.href,
    title: document.title,
    innerWidth: vw,
    innerHeight: window.innerHeight,
    docClientWidth: de.clientWidth,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: body.scrollWidth,
    horizontalScroll: de.scrollWidth > de.clientWidth || body.scrollWidth > de.clientWidth,
    mediaMatches: {
      'max-width:480px': window.matchMedia('(max-width: 480px)').matches,
    },
    tiles,
    tileCount: tiles.length,
    grid: gridBox,
    text,
    demand,
    maxRight: r1(maxRight),
    maxRightSelector: maxRightSel,
    overBy: r1(maxRight - vw),
    viewportMeta: (document.querySelector('meta[name=viewport]') || {}).content ?? null,
  }

  // ---- 6. 诊断：解释"栅格为什么没跟着视口收缩" ----
  if (${DIAG}) {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        sel,
        rect: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)],
        width: cs.width,
        padding: cs.padding,
        gridTemplateColumns: cs.gridTemplateColumns,
        columnGap: cs.columnGap,
        display: cs.display,
        overflow: cs.overflow,
        minWidth: cs.minWidth,
        gap: cs.gap,
      }
    }
    out.diag = {
      stage: pick('.stage'),
      phone: pick('.phone'),
      scroll: pick('.scroll'),
      grid: pick('.grid'),
      firstTile: pick('.tile'),
      firstGlyph: pick('.glyph'),
      firstCopy: pick('.tile-copy'),
      firstChev: pick('.tile .chev'),
      visualViewport: window.visualViewport
        ? { width: r1(window.visualViewport.width), scale: window.visualViewport.scale }
        : null,
    }
  }
  return out
})()`

/** 把一次测量翻译成"过 / 不过"，每条都带证据，不靠印象。 */
function violations(entry) {
  const bad = []
  const push = (rule, detail) => bad.push({ rule, detail })
  if (!entry.ready) push('ready', '首页卡片没渲染出来（.tile 一直不存在）')
  if (entry.tileCount !== 4) push('tileCount', `首页卡片数量 ${entry.tileCount}，期望 4`)
  for (const t of entry.tiles ?? []) {
    if (t.overBy > TOL) push('tile-overflow', `「${t.title}」右边界 ${t.right} 越出视口 ${t.overBy}px`)
    if (t.childEscape > TOL) push('tile-child-escape', `「${t.title}」内部元素跑出卡片 ${t.childEscape}px`)
  }
  if ((entry.overBy ?? 0) > TOL) push('page-overflow', `最右元素 ${entry.maxRightSelector} 的 right=${entry.maxRight} 越出视口 ${entry.overBy}px`)
  if (entry.grid && entry.grid.gridOverflow > TOL) push('grid-overflow', `卡片撑破 .grid 内容盒 ${entry.grid.gridOverflow}px（列宽 ${entry.grid.columns}）`)
  if (entry.horizontalScroll) push('h-scroll', `出现横向滚动：scrollWidth=${entry.docScrollWidth} clientWidth=${entry.docClientWidth}`)
  for (const t of entry.text ?? []) {
    if (t.truncated) push('text-truncated', `${t.where}「${t.text}」被裁：scrollWidth=${t.scrollWidth} > clientWidth=${t.clientWidth}`)
    if (t.singleCharColumn) push('text-single-char', `${t.where}「${t.text}」被压成竖排：${t.lineCount} 行 / 每行 ${t.charsPerLine} 字`)
    if (t.lineCount > 1) push('text-wrapped', `${t.where}「${t.text}」折成 ${t.lineCount} 行（原本 nowrap 单行）`)
  }
  // 卡片"一个字都不裁"所需宽度 vs 实际列宽
  if (entry.grid && entry.demand) {
    const colWidth = (Math.max(...entry.tiles.map(t => t.width)))
    for (const d of entry.demand) {
      if (d.need > colWidth + TOL) push('card-demand', `「${d.title}」需要 ${d.need}px，实际列宽 ${colWidth}px，差 ${Math.round((d.need - colWidth) * 10) / 10}px`)
    }
  }
  return bad
}

const report = {
  app: APP,
  cdp: CDP,
  probe: 'probe-home-tiles.mjs',
  sourceStyles: 'apps/qianshou-mobile/src/styles.css',
  sourceStylesSha256: stylesSha256,
  at: new Date().toISOString(),
  viewports: [],
}

for (const vp of VIEWPORTS) {
  await S('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: true })
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await S('Page.navigate', { url: APP })

  // 等首页真正渲染出来再量：轮询 .tile，不靠固定 sleep 赌时间。
  const deadline = Date.now() + 25000
  let ready = false
  while (Date.now() < deadline) {
    try { ready = await ev('!!document.querySelector(".tile")') } catch { ready = false }
    if (ready) break
    await wait(200)
  }
  // 等两帧，确保字体与布局都稳定。
  await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  await wait(ready ? 250 : 0)

  let measured
  try {
    measured = await ev(MEASURE)
  } catch (error) {
    measured = { error: String((error && error.message) || error), bodyText: await ev('document.body.innerText.slice(0, 300)') }
  }

  const shotName = `${OUT_DIR}/${vp.width}x${vp.height}.png`
  const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(shotName, Buffer.from(shot.data, 'base64'))

  const entry = { viewport: vp, ready, screenshot: shotName, ...measured }
  entry.violations = violations(entry)
  report.viewports.push(entry)

  const maxTileRight = measured.tiles?.length ? Math.max(...measured.tiles.map(t => t.right)) : 'n/a'
  const worstDemand = measured.demand?.length ? Math.max(...measured.demand.map(d => d.need)) : 'n/a'
  const widest = measured.tiles?.length ? Math.max(...measured.tiles.map(t => t.width)) : 'n/a'
  console.log(
    `${String(vp.width).padStart(3)}px  overBy=${String(measured.overBy ?? 'n/a').padStart(6)}` +
    `  maxTileRight=${String(maxTileRight).padStart(6)}  cols=${String(measured.grid?.columns ?? 'n/a').padEnd(24)}` +
    `  gridOverflow=${String(measured.grid?.gridOverflow ?? 'n/a').padStart(6)}` +
    `  hScroll=${measured.horizontalScroll}  最宽卡需=${String(worstDemand).padStart(6)} 实际列宽=${String(widest).padStart(6)}` +
    `  违规=${entry.violations.length}`,
  )
}

const allViolations = report.viewports.flatMap(v => v.violations.map(x => ({ vp: v.viewport.width, ...x })))
report.violationCount = allViolations.length
if (allViolations.length) {
  console.log('\n违规明细：')
  for (const v of allViolations) console.log(`  [${v.vp}px] ${v.rule}: ${v.detail}`)
} else {
  console.log('\n所有视口通过：无越界、无栅格撑破、无横向滚动、无裁字、无竖排。')
}

const reportPath = `${OUT_DIR}/probe-report.json`
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(`\nreport -> ${reportPath}  (styles.css sha256:${stylesSha256})`)
await Promise.race([send('Target.closeTarget', { targetId }).catch(() => {}), wait(2000)]).catch(() => {})
ws.close()

if (CHECK && allViolations.length) process.exitCode = 1
