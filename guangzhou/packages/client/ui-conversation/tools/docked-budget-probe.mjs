/**
 * 会话（active）形态右组预算的**注入式实测**。
 *
 * ── 为什么是注入，而不是"真的开一条会话" ──────────────────────────────
 * 实测环境里进不去 active 形态：本机 dsh web 的会话行必须点开才能把 composer
 * 切到 `data-phase="active"`，而在这个 CDP 探针实例里点会话行不生效（已试过
 * `.click()`、完整 pointer 序列、在行元素上直接派发 click；侧栏在宽视口下渲染，
 * 行存在、`role="treeitem"`，但 composer 始终停在 `hero`）。
 * 因此"active 形态的真实截图/几何"**没有拿到**，这一条如实记在报告里。
 *
 * 本脚本改用**注入法**补上"容器宽度 → 右组占用 → chip 能显示几个"的关系：
 * 它在真实的 `.row` 里（真实 CSS、真实 flex 环境）临时拼出 active 形态的右组——
 *   投递方式（真实 <select>，取 active 态实测最坏宽度 104px）
 *   + 模型选择器占位（宽 220px，= ModelSelect.module.css 的 `max-width: 220px`）
 *   + 语音入口占位（宽 46px，= ComposerVoiceEntry.module.css 的 28 + 1 + 18 - 1）
 *   + 发送（真实按钮 34px）
 * 然后逐宽度量：可见 chip 数、是否有 chip 越出卡片、`.row` 是否横向溢出。
 *
 * **注入物不是产品 DOM**：它只用于量"这一行在剩余空间里能放下几个 chip"，
 * 不能当作"active 形态已验证"。真实 active 形态仍需人工开一条会话复核。
 *
 * 用法：
 *   node packages/client/ui-conversation/tools/docked-budget-probe.mjs \
 *     [--cdp http://127.0.0.1:9233] [--url http://127.0.0.1:3099/] \
 *     [--out /tmp] [--widths 1488x960,994x642,...]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const CDP = arg('cdp', 'http://127.0.0.1:9233')
const URL_UNDER_TEST = arg('url', 'http://127.0.0.1:3099/')
const OUT = arg('out', '/tmp')
/* `measured`：模型选择器按**实测宽度**注入（贴近真实 active 形态）。
   数字：注入一个固定宽度的模型占位（最坏情况，用它定阈值上限）。 */
const MODEL_W = arg('model-width', 'measured')
const WIDTHS = arg('widths', '1488x960,1440x900,1200x800,1100x800,1000x700,994x642,900x700,820x642,760x642,700x620')
  .split(',').map((pair) => {
    const [width, height] = pair.split('x').map(Number)
    return { width, height }
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}

await S('Emulation.setDeviceMetricsOverride', { width: 1488, height: 960, deviceScaleFactor: 1, mobile: false })
await S('Page.navigate', { url: URL_UNDER_TEST })
await wait(3500)

/* 注入 active 形态右组，量完立刻恢复原样（try/finally 在页面里）。 */
const MEASURE = `(() => {
  const row = document.querySelector('[data-composer-actions]')
  if (!row) return { missing: true, body: document.body.innerText.slice(0, 60) }
  const card = row.closest('[data-composer-card]')
  const trail = row.querySelector('[class*="trailing"]')
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2), right:+r.right.toFixed(2), bottom:+r.bottom.toFixed(2) } }
  const cardRect = rectOf(card)
  const chips = [...row.querySelectorAll('button')].filter((b) => b.className.includes('productChip'))
  /* 注入前：真实 chip 宽度（用于对照） */
  const before = {
    rowW: +row.getBoundingClientRect().width.toFixed(2),
    trailingW: trail ? +trail.getBoundingClientRect().width.toFixed(2) : null,
    visibleChips: chips.filter((c) => c.getBoundingClientRect().width > 0).length,
  }
  /* 注入 active 形态右组（真实元素 + 定宽占位） */
  const markers = []
  const mk = (w, h, tag) => {
    const el = document.createElement(tag ?? 'div')
    el.style.cssText = 'flex:none;box-sizing:border-box;width:' + w + 'px;height:' + h + 'px;background:transparent'
    return el
  }
  const MODEL_W_ARG = ${JSON.stringify(MODEL_W)}
  const model = mk(MODEL_W_ARG === 'measured' ? 0 : Number(MODEL_W_ARG), 28)
  if (MODEL_W_ARG === 'measured') {
    /* 用**实测到的**真实模型选择器宽度：它 flex-shrink:1000、min-width:0，
       是 active 形态里唯一"能缩"的控件；把它钉成 220px 会算出假的最坏情况。 */
    const real = document.querySelector('[class*="trigger"]')
    const realW = real ? real.getBoundingClientRect().width : 193
    model.style.width = realW + 'px'
    model.style.flexShrink = '0'
  }
  const voice = mk(46, 28)
  const delivery = trail ? trail.querySelector('select[class*="deliverySelect"]') : null
  const sendBtn = trail ? trail.querySelector('[class*="primary"]') : null
  try {
    if (delivery) delivery.style.maxWidth = '104px'
    trail.insertBefore(model, sendBtn)
    trail.insertBefore(voice, sendBtn)
    markers.push(model, voice)
    void row.offsetWidth
    /* 给模型占位换成"无最小宽度、可无限收缩"的版本，模拟真实模型选择器
       在真实 CSS 下的收缩能力：测量"收缩后是否仍有溢出"。 */
    if (MODEL_W_ARG === 'measured') model.style.minWidth = '0'
    void row.offsetWidth
    const chipData = chips.map((c) => {
      const r = rectOf(c)
      const rendered = r.w > 0 && r.h > 0
      return {
        text: c.textContent.trim(),
        rendered,
        w: r.w,
        h: r.h,
        outsideCardRight: rendered && r.right > cardRect.right + 0.5,
        outsideCardBottom: rendered && r.bottom > cardRect.bottom + 0.5,
      }
    })
    const controls = [...(trail ? trail.querySelectorAll('select,button,[style*="width:220px"],[style*="width:46px"]') : [])]
      .map((el) => { const r = rectOf(el); return { text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 16), w: r.w, right: r.right } })
      .filter((c) => c.w > 1)
    return {
      before,
      after: {
        /* .row 是 content-box，去掉左右各 8px 内边距才是真正能放控件的宽度 */
        rowContentWidth: +(row.getBoundingClientRect().width - 16).toFixed(2),
        trailingW: trail ? +trail.getBoundingClientRect().width.toFixed(2) : null,
        toolsW: row.querySelector('[class*="tools"]') ? +row.querySelector('[class*="tools"]').getBoundingClientRect().width.toFixed(2) : null,
        visibleChips: chipData.filter((c) => c.rendered).length,
        chipWidths: chipData.filter((c) => c.rendered).map((c) => ({ t: c.text, w: c.w })),
        chipClipped: chipData.filter((c) => c.outsideCardRight || c.outsideCardBottom),
        rowHorizontalOverflowPx: +(row.scrollWidth - row.clientWidth).toFixed(2),
      },
      card: cardRect,
      controls,
    }
  } finally {
    for (const marker of markers) marker.remove()
    if (delivery) delivery.style.maxWidth = ''
  }
})()`

const report = { url: URL_UNDER_TEST, chrome: version.Browser, modelWidth: MODEL_W, note: '注入式 active 预算实测；注入的不是产品 DOM', runs: [] }
for (const { width, height } of WIDTHS) {
  await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await wait(600)
  const sample = await ev(MEASURE)
  report.runs.push({ width, height, ...sample })
  if (sample.missing) {
    console.log(`${width}x${height} MISSING: ${sample.body}`)
    continue
  }
  const after = sample.after
  console.log(`${width} hero右组=${sample.before.trailingW} → 注入active右组=${after.trailingW} | 可见chip ${sample.before.visibleChips}→${after.visibleChips} | chip越界=${after.chipClipped.length} row横向溢出=${after.rowHorizontalOverflowPx}`)
}
writeFileSync(`${OUT}/docked-budget.json`, JSON.stringify(report, null, 2))
console.log(`\nJSON → ${OUT}/docked-budget.json`)
await send('Target.closeTarget', { targetId })
ws.close()
