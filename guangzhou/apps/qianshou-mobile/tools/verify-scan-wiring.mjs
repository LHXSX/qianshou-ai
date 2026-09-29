/**
 * 扫码接线的端到端探针（真实 Chrome + CDP）。
 *
 * 为什么不能只用 `/tmp/repro-scan.mjs` 那版：它有两处会让结论失真，
 * 而这两处恰好都会把**已经修好**的页面判成「没反应」。
 *
 * 1. **状态文案的选择器错了。**
 *    `.pc-link-head span` 命中的是**第一个** span，也就是放地球图标的
 *    `<span class="glyph blue">`——它的 textContent 恒为空，所以 `statusBefore`
 *    永远是 `"(空)"`，哪怕页面明明写着「把电脑上显示的地址整段粘到这里」。
 *    状态文案有自己的类：`.pc-link-status`。
 * 2. **合成事件绕过了命中测试。**
 *    `element.dispatchEvent(new PointerEvent(...))` 直接投给目标元素，就算按钮被
 *    别的元素盖住也照样"点得动"。这里走 `Input.dispatchTouchEvent`，
 *    也就是用户的真实手指路径（先命中测试，再派发）。
 *
 * 用法：
 *   node tools/verify-scan-wiring.mjs <页面地址>                     # 无相机 / 无权限
 *   node tools/verify-scan-wiring.mjs <页面地址> --camera            # 需要带假摄像头的 Chrome
 *   node tools/verify-scan-wiring.mjs <页面地址> --fake-code         # 假摄像头 + 替身识别器
 *
 * 三种模式：
 * - 默认（无相机 / 无权限）：点完必须是 `SCAN_COPY.denied`，且取景框收起；
 * - `--camera`（Chrome 加 `--use-fake-device-for-media-stream`）：点完取景框必须在，
 *   `.scan-overlay video` 必须挂着流（真实合成画面）；
 * - `--fake-code`：在相机模式之上，把 `window.BarcodeDetector` 换成固定返回一张票的替身，
 *   于是能验「识别到内容之后」那半条链（`onCode` → `finishScan` → `redeemPairing`）：
 *   取景框必须收起、相机必须释放、票必须真的出现在 POST 出去的身体里。
 *   **它不验证识别本身**——真二维码解码在无相机的机器上验不了。
 *
 * 退出码：0 = 全部断言通过；1 = 有断言不通过（输出里有 failures 数组）。
 */
import { writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const url = args.find(a => !a.startsWith('--'))
const fakeCode = args.includes('--fake-code')
const withCamera = args.includes('--camera') || fakeCode
const readFlag = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const cdp = readFlag('--cdp', withCamera ? 'http://127.0.0.1:9333' : 'http://127.0.0.1:9222')
const screenshot = readFlag('--screenshot', null)
if (url === undefined) {
  console.error('用法: node tools/verify-scan-wiring.mjs <页面地址> [--camera|--fake-code] [--cdp URL] [--screenshot out.png]')
  process.exit(2)
}

/** 期望出现的失败文案（与 `src/pairing.ts` 的 SCAN_COPY 同源，改文案时这里要跟着改）。 */
const DENIED = '没有摄像头权限。请在浏览器设置里允许后重试。'
const IDLE_HINT = '把电脑上显示的地址整段粘到这里'
const PLACE_HINT = '把二维码放进取景框'
/** 替身识别器"扫到"的票；它只用来证明值走到了兑换那一步。 */
const STUB_TICKET = 'probe-ticket-not-real'

const version = await (await fetch(`${cdp}/json/version`)).json()
const ws = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const events = []
const redeemRequests = []
ws.addEventListener('message', (message) => {
  const parsed = JSON.parse(message.data)
  if (parsed.id && pending.has(parsed.id)) { pending.get(parsed.id)(parsed.result); pending.delete(parsed.id) }
  if (parsed.method === 'Runtime.exceptionThrown') events.push(`EXC ${parsed.params.exceptionDetails?.exception?.description ?? ''}`.slice(0, 300))
  if (parsed.method === 'Runtime.consoleAPICalled') events.push(`LOG ${(parsed.params.args ?? []).map(a => String(a.value ?? a.description)).join(' ')}`.slice(0, 200))
  if (parsed.method === 'Network.requestWillBeSent' && String(parsed.params.request.url).includes('pc-window/bootstrap')) {
    redeemRequests.push({ url: parsed.params.request.url, body: parsed.params.request.postData ?? '' })
  }
})
await new Promise(resolve => ws.addEventListener('open', resolve))
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++nextId
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params = {}) => send(method, params, sessionId)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { returnByValue: true, expression, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description).slice(0, 300))
  return result.result.value
}

await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
const origin = new URL(url).origin
// 两种环境用权限本身来区分：不给 = 被拒（走失败分支），给 = 有相机（走取景框分支）。
await call('Browser.grantPermissions', { permissions: withCamera ? ['videoCapture'] : [], origin })
await call('Page.navigate', { url })
await sleep(5000)

const report = { mode: fakeCode ? 'fake-code' : withCamera ? 'camera' : 'no-permission' }
report.environment = await evaluate(`({
  secure: window.isSecureContext,
  mediaDevices: !!navigator.mediaDevices,
  barcodeDetector: !!window.BarcodeDetector,
  bundle: [...document.querySelectorAll('script')].map(s => s.src.split('/').pop()).join(','),
})`)
if (fakeCode) {
  // 替身识别器：只替换「解码」这一步，相机与取景框都是真的。
  await call('Network.enable')
  report.decoder = await evaluate(`(() => {
    window.BarcodeDetector = class {
      static getSupportedFormats() { return Promise.resolve(['qr_code']) }
      detect() { return Promise.resolve([{ rawValue: 'qianshou-pair:${STUB_TICKET}' }]) }
    }
    return 'stubbed'
  })()`)
}

await evaluate(`(() => { const t = [...document.querySelectorAll('.tab')].find(n => (n.textContent||'').trim() === '我的'); t && t.click() })()`)
await sleep(900)
report.before = {
  status: await evaluate(`(document.querySelector('.pc-link-status')?.textContent || '(空)').trim()`),
  overlay: await evaluate(`!!document.querySelector('.scan-overlay')`),
  // 记录一下"那个会骗人的选择器"此刻读到什么，省得下次再被它绊倒。
  misleadingSelector: await evaluate(`(document.querySelector('.pc-link-head span')?.textContent || '(空)').trim()`),
}
const target = await evaluate(`(() => { const b = document.querySelector('.pc-link-scan'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, top: document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)?.className } })()`)
report.hitTest = target.top
await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y }] })
await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await sleep(fakeCode ? 4500 : withCamera ? 3500 : 2500)

report.after = await evaluate(`(() => {
  const overlay = document.querySelector('.scan-overlay')
  const video = overlay?.querySelector('video')
  return {
    status: (document.querySelector('.pc-link-status')?.textContent || '(空)').trim(),
    overlay: !!overlay,
    video: !!video,
    streamAttached: video ? video.srcObject !== null : null,
    videoSize: video ? [video.videoWidth, video.videoHeight] : null,
    hint: overlay?.querySelector('p')?.textContent ?? null,
  }
})()`)

const failures = []
if (report.before.status !== IDLE_HINT) failures.push(`点击前状态文案应为「${IDLE_HINT}」，实际「${report.before.status}」`)
if (report.hitTest !== 'pc-link-scan') failures.push(`按钮中心被 ${report.hitTest} 占着，真实点击落不到按钮上`)
if (fakeCode) {
  // 解码之后那半条链：取景框收起 → 相机释放 → 票真的发出去 → 结果如实上屏。
  report.redeemRequests = redeemRequests
  const posted = redeemRequests.filter(request => request.body.includes(STUB_TICKET))
  if (report.after.overlay) failures.push('扫到票之后取景框应收起（配对只需要扫一次）')
  if (posted.length === 0) failures.push(`扫到的票没有走到兑换请求里（期望 POST 身体含 ${STUB_TICKET}）`)
  if (report.after.status === IDLE_HINT || report.after.status === PLACE_HINT) {
    failures.push(`扫码结果必须如实上屏，实际停在「${report.after.status}」`)
  }
} else if (withCamera) {
  if (report.after.status !== PLACE_HINT) failures.push(`点击后状态文案应为「${PLACE_HINT}」，实际「${report.after.status}」`)
  if (!report.after.overlay || !report.after.video) failures.push('有相机时取景框必须留在屏幕上并含 <video>')
  else if (!report.after.streamAttached || (report.after.videoSize?.[0] ?? 0) === 0) failures.push('取景框的 video 没有真的挂上视频流')
} else {
  if (report.after.status !== DENIED) failures.push(`点击后状态文案应为「${DENIED}」，实际「${report.after.status}」`)
  if (report.after.overlay) failures.push('拿不到权限时取景框应已收起，不该留一个黑屏弹层')
}
report.failures = failures
report.events = events.slice(-8)
if (screenshot !== null) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'))
  report.screenshot = screenshot
}
console.log(JSON.stringify(report, null, 2))
await send('Target.closeTarget', { targetId })
ws.close()
process.exit(failures.length === 0 ? 0 : 1)
