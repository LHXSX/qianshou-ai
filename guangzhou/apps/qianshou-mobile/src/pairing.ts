/**
 * 扫码配对：**扫一下电脑上显示的二维码，这台手机就获得遥控权**。
 *
 * 为什么必须由人扫：绑定不能由手机自己发起。《P0-4 报告》里写得很清楚——
 * `registerBinding` 是 host 侧程序化 API、**故意不暴露成 HTTP**，因为
 * 「手机不能自己授权自己」。二维码就是那个「人在电脑前授权」的动作。
 *
 * 二维码里装的是什么：**配对票据**（一次性、默认 5 分钟、按来源限次），
 * 由电脑签发并显示。手机把票交给宿主的引导接口换取绑定——票用掉即作废，
 * 因为二维码会被拍照、被截图转发，能重复用的票等于长期口令。
 *
 * 摄像头前提：浏览器只在**安全上下文**下给摄像头。我们的同源部署是 HTTPS，
 * 所以可用（实测 `isSecureContext: true`、`mediaDevices` 与 `BarcodeDetector` 都在）。
 * 不满足时如实说明并给出替代路径，不假装能用。
 */

/** 扫码失败的原因；每一种对应不同的处置。 */
export type ScanFailureKind =
  | 'insecure-context'
  | 'unsupported'
  | 'denied'
  | 'no-camera'
  | 'busy'

/** 面向用户的说明；直接展示，不再二次翻译。 */
export const SCAN_COPY: Readonly<Record<ScanFailureKind, string>> = {
  'insecure-context': '浏览器只在 HTTPS 下给摄像头。请用 https 打开这个页面。',
  unsupported: '这个浏览器不支持扫码识别。可以手动输入配对码。',
  denied: '没有摄像头权限。请在浏览器设置里允许后重试。',
  'no-camera': '找不到摄像头。可以手动输入配对码。',
  busy: '摄像头被其它程序占用了，关掉再试。',
}

/** 一次扫码会话。 */
export interface ScanSession {
  /** 停止扫码并释放摄像头。 */
  readonly stop: () => void
}

/** 环境是否具备扫码条件。 */
export interface ScanSupport {
  readonly ok: boolean
  readonly reason: ScanFailureKind | null
}

/**
 * 判断这台设备现在能不能扫码。
 *
 * **先看安全上下文再看接口**：http 下即使 `mediaDevices` 存在，`getUserMedia` 也会直接失败，
 * 那时报「不支持扫码」是误导——真实原因是协议不对，处置也不同。
 * @param environment - 可注入的环境，便于测试。
 * @returns 支持与否及原因。
 */
export function scanSupport(environment: {
  readonly isSecureContext?: boolean
  readonly mediaDevices?: unknown
  readonly barcodeDetector?: unknown
} = {}): ScanSupport {
  const secure = environment.isSecureContext
    ?? (typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : false)
  if (!secure) return { ok: false, reason: 'insecure-context' }
  const devices = environment.mediaDevices ?? (globalThis.navigator as { mediaDevices?: unknown } | undefined)?.mediaDevices
  if (devices === undefined || devices === null) return { ok: false, reason: 'unsupported' }
  const detector = environment.barcodeDetector
    ?? (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  if (detector === undefined) return { ok: false, reason: 'unsupported' }
  return { ok: true, reason: null }
}

/** `BarcodeDetector` 的最小形状（浏览器原生，不引第三方）。 */
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<readonly { readonly rawValue: string }[]>
}
interface BarcodeDetectorCtor {
  new (options?: { readonly formats?: readonly string[] }): BarcodeDetectorLike
}

/**
 * 开始扫码。每识别到一个二维码就回调一次并**自动停止**——配对只需要一次，
 * 继续占着摄像头是没必要的资源占用与隐私负担。
 * @param options - 视频元素、成功回调、失败回调与检测间隔。
 * @returns 可停止的会话；环境不支持时抛出的错误信息是可展示的。
 */
export async function startScan(options: {
  readonly video: HTMLVideoElement
  readonly onCode: (value: string) => void
  readonly onFailure: (kind: ScanFailureKind) => void
  /** 检测间隔；默认 300ms。再密只是白烧电。 */
  readonly intervalMs?: number
}): Promise<ScanSession> {
  const support = scanSupport()
  if (!support.ok) {
    options.onFailure(support.reason ?? 'unsupported')
    return { stop: () => { /* 没开始就没有要停的 */ } }
  }
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector as BarcodeDetectorCtor
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    options.onFailure(name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'no-camera' : 'busy')
    return { stop: () => { /* 摄像头没开成 */ } }
  }

  const detector = new Detector({ formats: ['qr_code'] })
  const video = options.video
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  await video.play().catch(() => { /* 自动播放被拦：下一帧仍会渲染 */ })

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    globalThis.clearInterval(handle)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  const handle = globalThis.setInterval(() => {
    if (stopped) return
    void detector.detect(video).then((codes) => {
      const first = codes[0]
      if (first === undefined || first.rawValue.length === 0) return
      // 只认第一个：继续报后面的会让调用方拿到一串互相矛盾的票。
      stop()
      options.onCode(first.rawValue)
    }).catch(() => { /* 单帧识别失败（画面还没就绪）不值得打扰用户 */ })
  }, options.intervalMs ?? 300)

  return { stop }
}
