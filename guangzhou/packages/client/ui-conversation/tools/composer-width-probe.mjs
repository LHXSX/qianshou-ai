/**
 * composer 底部控制行的**真实 Chrome 几何探针**（CDP 驱动，无第三方依赖）。
 *
 * 目的：为「chip 被压成竖排单字 / 纵向穿透卡片下边框」这条缺陷提供**可复跑的数字证据**，
 * 并在修复前后用同一份脚本对比。脚本只做测量与截图，不改页面、不改 DOM。
 *
 * 每个宽度采集：
 *   - `.row` 的 clientWidth / scrollWidth / clientHeight / scrollHeight、行高是否仍是 41px；
 *   - `.tools` / `.productChips` / `.trailing` / `.add` / 各 chip / 各控件 的 rect；
 *   - 每个 chip 的**文字行数**与**每行字数**（Range.getClientRects 逐字聚簇）——
 *     "单字成列"就是 lines >= 2 且每行 1 字；
 *   - 每个 chip 是否**纵向/横向越出输入卡片**（卡片矩形包含判定），
 *     并单独判定是否穿透卡片**下边框**；
 *   - 页面级横向滚动（documentElement.scrollWidth > clientWidth）。
 *
 * 用法：
 *   node packages/client/ui-conversation/tools/composer-width-probe.mjs \
 *     --label before \
 *     --out ./ui-audit/after \
 *     [--url http://127.0.0.1:3099/] [--cdp http://127.0.0.1:9222] \
 *     [--widths 1488x960,994x642,...] [--no-shots]
 *
 * 前置：一个开着 `--remote-debugging-port=9222` 的真实 Chrome，
 *       且该 profile 已经带着 dsh web 的 auth cookie（打开过一次 dsh web 打印的 URL）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const URL_UNDER_TEST = arg('url', 'http://127.0.0.1:3099/')
const CDP = arg('cdp', 'http://127.0.0.1:9222')
const OUT = arg('out', '/tmp/composer-probe')
const LABEL = arg('label', 'run')
const SHOTS = !process.argv.includes('--no-shots')
/* `--variant docked`：先在一个**宽视口**下打开一条既有会话（侧栏只在宽视口可见），
   再逐宽度量——这样量到的是**会话（active）形态**的真实组合：
   右侧多出模型选择器与语音入口。默认 `hero`（首屏形态）。 */
const VARIANT = arg('variant', 'hero')
const OPEN_WIDTH = Number(arg('open-width', 1400))
const OPEN_HEIGHT = Number(arg('open-height', 900))
const WIDTHS = arg('widths', '1488x960,994x642,900x700,820x642,760x642,700x620,560x640')
  .split(',').map((pair) => {
    const [w, h] = pair.split('x').map(Number)
    return { width: w, height: h }
  })

mkdirSync(OUT, { recursive: true })

const version = await (await fetch(`${CDP}/json/version`)).json()
const ws = new WebSocket(version.webSocketDebuggerUrl)
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable')
await S('Runtime.enable')
const ev = async (expression) => {
  const result = await S('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

/* 采集表达式：全部在页面里同步算完再返回，避免往返期间布局变化。 */
const MEASURE = `(() => {
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2) }
  }
  const row = document.querySelector('[data-composer-actions]')
  const card = row ? row.closest('[data-composer-card]') ?? row.parentElement : null
  const layersOf = (el) => {
    /* 逐字测行：把每个字符包成一个 Range，按 clientRect 的 top 聚簇成"行"。 */
    const text = el.textContent ?? ''
    const node = [...el.childNodes].find((n) => n.nodeType === 3)
    if (!node || text.length === 0) return { lines: 0, charsPerLine: [], textLines: [] }
    const range = document.createRange()
    const clusters = new Map()
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const box = range.getClientRects()[0]
      if (!box) continue
      const key = Math.round(box.top)
      if (!clusters.has(key)) clusters.set(key, { count: 0, text: '', left: box.left, right: box.right })
      const entry = clusters.get(key)
      entry.count += 1
      entry.text += text[i]
      entry.left = Math.min(entry.left, box.left)
      entry.right = Math.max(entry.right, box.right)
    }
    const ordered = [...clusters.entries()].sort((a, b) => a[0] - b[0])
    return {
      lines: ordered.length,
      charsPerLine: ordered.map(([, v]) => v.count),
      textLines: ordered.map(([, v]) => v.text),
    }
  }
  const overflowAncestor = (el) => {
    /* 找出真正把 el 裁掉的那个祖先（overflow != visible），用于解释"看不到溢出"。 */
    let node = el.parentElement
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        return { tag: node.tagName, cls: node.className, overflowX: style.overflowX, overflowY: style.overflowY }
      }
      node = node.parentElement
    }
    return null
  }
  if (!row || !card) return { missing: true }
  const cardRect = rectOf(card)
  const rowStyle = getComputedStyle(row)
  const toolsRect = rectOf(row.querySelector('[class*="tools"]'))
  const ellipsisContract = (el) => getComputedStyle(el).textOverflow === 'ellipsis'
  const chips = [...row.querySelectorAll('button')]
    .filter((b) => b.className.includes('productChip'))
  const chipData = chips.map((chip) => {
    const r = rectOf(chip)
    const layers = layersOf(chip)
    const style = getComputedStyle(chip)
    /* 被容器查询收起的 chip 是 display:none：rect 全 0 且落在原点，
       它们既不可见也不占位，**不能**算进"越出卡片"的判定（否则 0×0 的
       矩形会被判成"在卡片左上角之外"）。收起 = 正确的降级，不是缺陷。 */
    const rendered = r.w > 0 && r.h > 0
    return {
      text: chip.textContent.trim(),
      rendered,
      rect: r,
      lines: layers.lines,
      charsPerLine: layers.charsPerLine,
      textLines: layers.textLines,
      /* 单字成列：>=2 行且每行只有 1 个字符 */
      verticalStack: rendered && layers.lines >= 2 && layers.charsPerLine.every((n) => n === 1),
      whiteSpace: style.whiteSpace,
      flexShrink: style.flexShrink,
      flexBasis: style.flexBasis,
      overflowYOverCard: +(r.bottom - cardRect.bottom).toFixed(2),
      overflowXOverCard: +(r.right - cardRect.right).toFixed(2),
      outsideCardBottom: rendered && r.bottom > cardRect.bottom + 0.5,
      outsideCardRight: rendered && r.right > cardRect.right + 0.5,
      outsideCardLeft: rendered && r.left < cardRect.left - 0.5,
      outsideCardTop: rendered && r.top < cardRect.top - 0.5,
      /* 是否越出了自己所在的 .tools 组（可见性诊断用；验收线是"越出卡片边框"）。 */
      outsideToolsRight: rendered && r.right > (toolsRect?.right ?? 0) + 0.5,
    }
  })
  const groupRect = (cls) => rectOf(row.querySelector('[class*="' + cls + '"]'))
  const attach = row.querySelector('[class*="add"]')
  const named = (sel) => rectOf(row.querySelector(sel))
  const cs = getComputedStyle(row)
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
  const rowRect = rectOf(row)
  /* 这一行真正能放控件的宽度：border-box 宽 − 左右内边距（.row 是 content-box）。 */
  const rowContentWidth = +(rowRect.w - padX).toFixed(2)
  /* 右侧组的"自然宽度"：把它的子项按各自不可再压的宽度加总（含 6px 间距），
     用来解释"留给左侧还剩多少"，是判定断点阈值的直接依据。 */
  const naturalOf = (group) => {
    if (!group) return null
    const kids = [...group.children].filter((k) => getComputedStyle(k).display !== 'none')
    let sum = 0
    let visible = 0
    for (const kid of kids) { sum += kid.getBoundingClientRect().width; visible += 1 }
    const gap = parseFloat(getComputedStyle(group).gap) || 0
    return {
      count: visible,
      gap,
      /* 可见子项的宽度之和 = 这一组的**真实内容宽度**（不用组自身的 rect：
         组是 flex 子项、会被拉伸/收缩，rect 不等于内容宽）。 */
      contentWidth: +sum.toFixed(2),
      withGaps: +(sum + gap * Math.max(0, visible - 1)).toFixed(2),
      kids: kids.map((k) => ({
        text: (k.textContent ?? '').trim().slice(0, 14),
        tag: k.tagName.toLowerCase(),
        cls: String(k.className).slice(0, 40),
        w: +k.getBoundingClientRect().width.toFixed(2),
        minContentW: (() => {
          /* 最小内容宽：把元素按 "width: min-content" 试算一次（克隆节点，不动真实 DOM）。 */
          const clone = k.cloneNode(true)
          clone.style.cssText = 'position:absolute;visibility:hidden;width:min-content;left:-9999px'
          group.appendChild(clone)
          const w = clone.getBoundingClientRect().width
          clone.remove()
          return +w.toFixed(2)
        })(),
        maxW: getComputedStyle(k).maxWidth,
      })),
    }
  }
  /* ── 「任何可见控件都不被裁掉」的实测判定 ─────────────────────────────
     这是本轮新增的**硬约束**：chip 变成 flex:none 之后，"放不下"不再
     表现为压扁，而是表现为溢出；而 .row 的 overflow-x:clip 会把溢出
     **安静裁掉**——用户在界面上看到的是"某个按钮缺一块"，比看得见的竖排更糟。
     所以每个可见控件都要能证明它完整体现在框内。

     判定分两层：
       ① 自身内容是否被自己裁掉：scrollWidth 减 clientWidth（元素自己
          overflow:hidden 时的截断，例如超长模型名/投递方式）；
       ② 是否越出**卡片边框**（.row 的 clip 就在这里生效）。
     clientWidth 是整数、getBoundingClientRect() 是小数，所以留 1px 容差。 */
  const controlSelectors = {
    add: '[class*="add"]',
    delivery: 'select[class*="deliverySelect"]',
    send: '[class*="primary"]',
    model: '[class*="trigger"]',
    voice: '[data-composer-voice] > *',
  }
  const controls = []
  for (const [name, selector] of Object.entries(controlSelectors)) {
    for (const el of row.querySelectorAll(selector)) {
      const r = rectOf(el)
      /* 宽度小于 2px 的元素不算"控件"：实测里抓到一个 0.44px 宽的折叠提示
         （模型名旁边的 caption 徽标，自带 overflow:hidden），它的 scrollWidth
         是设计如此、不是被裁。只统计真正占位的控件。 */
      if (r === null || r.w < 2 || r.h < 2) continue
      controls.push({
        name,
        text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20),
        rect: r,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        contentClippedPx: Math.max(0, +(el.scrollWidth - el.clientWidth).toFixed(2)),
        /* 该元素或其后代是否带 text-overflow:ellipsis 的截断契约 */
        ellipsis: ellipsisContract(el) || [...el.querySelectorAll('*')].some(ellipsisContract),
        outsideCardRight: r.right > cardRect.right + 0.5,
        outsideCardLeft: r.left < cardRect.left - 0.5,
        outsideCardBottom: r.bottom > cardRect.bottom + 0.5,
        outsideCardTop: r.top < cardRect.top - 0.5,
      })
    }
  }
  for (const chip of chipData) {
    if (!chip.rendered) continue
    controls.push({
      name: 'chip',
      text: chip.text,
      rect: chip.rect,
      clientWidth: null,
      scrollWidth: null,
      contentClippedPx: 0,
      outsideCardRight: chip.outsideCardRight,
      outsideCardLeft: chip.outsideCardLeft,
      outsideCardBottom: chip.outsideCardBottom,
      outsideCardTop: chip.outsideCardTop,
    })
  }
  /* 区分两种"看起来被裁"：
     ① **设计如此的可读截断**：元素自己声明了 text-overflow:ellipsis
        （模型名、投递方式），文字被截成"DeepSeek-V4…"是预期行为，
        不是缺陷——这是"先窄后收"的降级，用户仍看得懂；
     ② **真·裁切**：元素**没有**省略号契约，却被容器裁掉，
        或者元素的盒子本身越出了卡片边框（row 的 overflow-x:clip 生效）。
     验收只看 ②。 */
  const clipped = controls.filter((c) => c.contentClippedPx > 1 && c.ellipsis !== true)
  const truncatedByDesign = controls.filter((c) => c.contentClippedPx > 1 && c.ellipsis === true)
  const outside = controls.filter((c) => c.outsideCardRight || c.outsideCardLeft || c.outsideCardBottom || c.outsideCardTop)

  const chipsHidden = [...row.querySelectorAll('button')]
    .filter((b) => b.className.includes('productChip'))
    .map((b) => ({
      text: b.textContent.trim(),
      display: getComputedStyle(b).display,
      w: +b.getBoundingClientRect().width.toFixed(2),
    }))
  const containerQueryHit = (() => {
    /* 直接读"当前命中了哪些容器查询"：把每条 CSSContainerRule 的 conditionText
       与容器的 inline-size 对照，避免"以为命中了其实没命中"。 */
    const containerWidth = rowRect.w
    const rules = []
    const walk = (list) => {
      for (const rule of list) {
        if (rule.cssRules) walk(rule.cssRules)
        else if (rule.conditionText !== undefined && String(rule.constructor.name).includes('Container')) {
          rules.push({ condition: rule.conditionText, matches: null, containerWidth })
        }
      }
    }
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules) } catch { /* cross-origin sheet */ }
    }
    return rules
  })()
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    row: {
      rect: rowRect,
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      clientHeight: row.clientHeight,
      scrollHeight: row.scrollHeight,
      height: rowStyle.height,
      padding: cs.padding,
      paddingX: padX,
      rowContentWidth,
      containerType: cs.containerType,
      containerWidthForQueries: rowRect.w,
      overflowX: rowStyle.overflowX,
      horizontalOverflowPx: +(row.scrollWidth - row.clientWidth).toFixed(2),
      verticalOverflowPx: +(row.scrollHeight - row.clientHeight).toFixed(2),
    },
    card: { rect: cardRect, radius: getComputedStyle(card).borderRadius },
    groups: {
      tools: groupRect('tools'),
      chips: groupRect('productChips'),
      trailing: groupRect('trailing'),
      add: rectOf(attach),
      delivery: named('select[class*="deliverySelect"]'),
      model: named('[class*="select"]:not([class*="deliverySelect"])'),
      send: named('[class*="primary"]'),
    },
    natural: {
      trailing: naturalOf(row.querySelector('[class*="trailing"]')),
      tools: naturalOf(row.querySelector('[class*="tools"]')),
      chips: naturalOf(row.querySelector('[class*="productChips"]')),
    },
    chips: chipData,
    chipCount: chipData.length,
    chipsHidden,
    controls,
    clippedControls: clipped,
    truncatedByDesign,
    controlsOutsideCard: outside,
    /* 缺陷判定（两条硬约束）——只统计**可见**的 chip */
    verdict: {
      visibleChips: chipData.filter((c) => c.rendered).length,
      hiddenChips: chipData.filter((c) => !c.rendered).map((c) => c.text),
      anyVerticalStack: chipData.some((c) => c.verticalStack),
      anyOutsideCard: chipData.some((c) => c.outsideCardBottom || c.outsideCardRight || c.outsideCardLeft || c.outsideCardTop),
      anyChipOutsideToolsGroup: chipData.some((c) => c.outsideToolsRight),
      anyThroughBottomBorder: chipData.some((c) => c.outsideCardBottom),
      pageHorizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clippedControlCount: clipped.length,
      truncatedByDesignCount: truncatedByDesign.length,
      controlsOutsideCardCount: outside.length,
      rowHorizontalOverflowPx: +(row.scrollWidth - row.clientWidth).toFixed(2),
      rowVerticalOverflowPx: +(row.scrollHeight - row.clientHeight).toFixed(2),
      rowHeightPx: row.getBoundingClientRect().height,
    },
    clipAncestor: chipData.length > 0 ? overflowAncestor(chips[0]) : null,
    titles: document.title,
  }
})()`

/* 打开页面：走一次真实加载，等 composer 出现。 */
await S('Emulation.setDeviceMetricsOverride', { width: Math.round(1488 * 1), height: 960, deviceScaleFactor: 1, mobile: false })
await S('Page.navigate', { url: URL_UNDER_TEST })
await wait(3500)

/* ── 缩放闸门（这条是必须的，不是装饰）────────────────────────────────
   浏览器把**每个 host 的页面缩放**持久化在 profile 里（Preferences →
   partition.per_host_zoom_levels）。一个被设过缩放的调试实例会让
   `Emulation.setDeviceMetricsOverride(width: N)` **不等于** 布局视口 N px：
   我们第一次跑 before 时，1488 的 override 实际只得到 1353px 布局视口
   （1353×1.1 = 1488），所有测量还被额外乘了 0.99986 的缩放因子——
   于是"994 CSS px 窗口"根本没被测到，断点区间也会被判定错。
   所以这里**先解析缩放因子再按它反推 override 宽度**，让布局视口精确等于目标。 */
const measureZoom = async () => ev(`(() => {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:10px'
  document.body.appendChild(el)
  const w = el.getBoundingClientRect().width
  el.remove()
  return { zoom: 1000 / w, innerWidth: window.innerWidth }
})()`)
const zoomState = await measureZoom()
const ZOOM = zoomState.zoom
/* 布局视口 = override 宽度 / zoom ⇒ override 宽度 = 目标 × zoom */
await S('Emulation.setDeviceMetricsOverride', {
  width: Math.round(1488 * ZOOM), height: Math.round(960 * ZOOM), deviceScaleFactor: 1, mobile: false,
})
await wait(400)
const zoomCheck = await measureZoom()

/* 等 composer 真正挂载：首屏渲染受 bundle 加载影响，固定等待偶尔会早到
   （实测出现过 `[data-composer-actions]` 还没出现的空采样）。 */
let booted = { hasRow: false, text: '' }
for (let attempt = 0; attempt < 20 && booted.hasRow !== true; attempt += 1) {
  booted = await ev(`(() => {
    const row = document.querySelector('[data-composer-actions]')
    return { hasRow: !!row, text: document.body.innerText.slice(0, 60) }
  })()`)
  if (booted.hasRow === true) break
  await wait(500)
}

/* 会话（active）形态：宽视口 → 打开侧栏 → 点一条既有会话 → 再开始逐宽度量。
   全程只读：只点侧栏里的会话行，不新建会话、不发送任何消息。 */
let variantState = { requested: VARIANT, opened: false }
if (VARIANT === 'docked') {
  await S('Emulation.setDeviceMetricsOverride', {
    width: Math.round(OPEN_WIDTH * ZOOM), height: Math.round(OPEN_HEIGHT * ZOOM), deviceScaleFactor: 1, mobile: false,
  })
  await wait(800)
  variantState = await ev(`(() => {
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim()
    const sidebar = document.querySelector('button[aria-label="打开侧边栏"]')
    if (sidebar && (sidebar.getAttribute('aria-expanded') !== 'true')) sidebar.click()
    return { requested: 'docked', opened: false, sidebarFound: !!sidebar }
  })()`)
  await wait(1200)
  const opened = await ev(`(() => {
    const rows = [...document.querySelectorAll('[class*=sessionRow]')]
      .filter((row) => !String(row.className).includes('select'))
    if (rows.length === 0) return { clicked: false, rows: 0 }
    const target = rows[0]
    const hit = target.querySelector('button,a,[role=button]') ?? target
    const text = (target.textContent || '').trim().slice(0, 40)
    hit.click()
    return { clicked: true, rows: rows.length, text }
  })()`)
  await wait(3000)
  variantState = { ...variantState, ...opened, phase: await ev(`(() => {
    const root = document.querySelector('[data-phase]')
    const row = document.querySelector('[data-composer-actions]')
    return {
      rootPhase: root ? root.getAttribute('data-phase') : null,
      hasModelSelect: !!(row && row.querySelector('[class*=trigger]')),
      hasVoice: !!(row && row.querySelector('[data-composer-voice]')),
      rowChildren: row ? [...row.children].map((k) => String(k.className).slice(0, 30)) : [],
    }
  })()`) }
}

const report = {
  label: LABEL,
  variant: VARIANT,
  variantState,
  url: URL_UNDER_TEST,
  chrome: version.Browser,
  zoom: { factor: ZOOM, before: zoomState, after: zoomCheck, note: '布局视口 = override 宽度 / zoom 因子' },
  booted,
  runs: [],
}

/* 目标宽度按 zoom 反推，保证布局视口精确等于用户/规格里说的 CSS px。 */
const overrideFor = (width, height) => ({
  width: Math.round(width * ZOOM),
  height: Math.round(height * ZOOM),
  deviceScaleFactor: 1,
  mobile: false,
})

for (const { width, height } of WIDTHS) {
  await S('Emulation.setDeviceMetricsOverride', overrideFor(width, height))
  await wait(650)
  const sample = await ev(MEASURE)
  if (sample.missing === true) {
    console.log(`${LABEL} ${width}x${height} 未找到 composer（body 开头：${String(sample.body).slice(0, 40)}）`)
    report.runs.push({ width, height, missing: true, body: sample.body })
    continue
  }
  let shot = null
  if (SHOTS) {
    /* 截图用设备像素坐标：布局视口 × zoom 才是截图里的 CSS px。 */
    const clip = sample.card ? {
      x: Math.max(0, (sample.card.rect.x - 12) * ZOOM),
      y: Math.max(0, (sample.card.rect.y - 12) * ZOOM),
      width: Math.min(width * ZOOM, (sample.card.rect.w + 24) * ZOOM),
      height: Math.min(height * ZOOM, (sample.card.rect.h + 24) * ZOOM),
      scale: 1,
    } : undefined
    const captured = await S('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })
    shot = `${OUT}/${LABEL}-card-${width}x${height}.png`
    writeFileSync(shot, Buffer.from(captured.data, 'base64'))
  }
  report.runs.push({
    width,
    height,
    variantProbe: sample.variantProbe,
    layoutViewport: sample.viewport,
    layoutWidthMatchesTarget: Math.abs((sample.viewport?.w ?? -1) - width) <= 1,
    ...sample,
    shot,
    chips: sample.chips,
  })
  const v = sample.verdict ?? {}
  console.log(`${LABEL} ${width}x${height}(实际布局 ${sample.viewport?.w}) 可见chip=${v.visibleChips}/${sample.chipCount} 竖排=${v.anyVerticalStack} 穿下边框=${v.anyThroughBottomBorder} 越卡=${v.controlsOutsideCardCount} 被裁控件=${v.clippedControlCount} row横向溢出=${v.rowHorizontalOverflowPx} row纵向溢出=${v.rowVerticalOverflowPx} 行高=${v.rowHeightPx?.toFixed(2)}`)
}

/* 顺带记录构建产物指纹，保证"测的是哪份产物"可追溯。 */
const artifact = await ev(`(() => {
  const links = [...document.querySelectorAll('link[rel=stylesheet], script[src]')].map((n) => n.href || n.src)
  return { assets: links.slice(0, 12) }
})()`)
report.artifact = artifact

writeFileSync(`${OUT}/${LABEL}-measure.json`, JSON.stringify(report, null, 2))
console.log(`\nJSON → ${OUT}/${LABEL}-measure.json`)
console.log(`截图 → ${OUT}/${LABEL}-card-*.png`)
await send('Target.closeTarget', { targetId })
ws.close()
