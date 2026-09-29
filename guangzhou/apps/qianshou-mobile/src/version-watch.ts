/**
 * 版本检查：**手机上装了新版本要让用户知道，但不能打断正在进行的对话**。
 *
 * 为什么用「比较入口 HTML 引用的 bundle 名」而不是自建版本接口：
 * 构建产物本来就带内容哈希（`assets/index-XXXX.js`），`index.html` 又是 `no-cache` 的，
 * 所以拉一次 `index.html` 看它引用谁，就等于问「现在线上是哪个版本」。这样不需要
 * 后端配合、不需要协议、也不会因为接口挂了而误报——**少一个会坏的部件**。
 *
 * 三条刻意的取舍：
 *
 * 1. **不自动刷新**。自动刷新会在用户正在等回复时把对话清掉。只提示，由用户点。
 * 2. **拉取失败什么都不做**。检查版本失败绝不能在界面上冒出错误——用户没要求这件事，
 *    网络抖一下不该变成一条红字。
 * 3. **冷启动只记基线，不提示**。刚打开就提示「有新版本」很奇怪；先记下当前版本，
 *    之后发生变化才算新版本。
 */

/** 从一段 HTML 里取出入口脚本的资源名；取不到返回 `null`。 */
export function bundleOf(html: string): string | null {
  // 匹配 `<script type="module" ... src="/assets/index-XXXX.js">` 这类入口脚本。
  // 只看第一个 module 脚本：那正是 Vite 的入口。
  const module = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(html)
  if (module !== null) return module[1] ?? null
  const anyScript = /<script[^>]*src=["']([^"']+\.js)["']/i.exec(html)
  return anyScript?.[1] ?? null
}

/** 版本检查的可注入项。 */
export interface VersionWatchOptions {
  /** 检查的地址；默认当前页面地址（同源，不产生跨域）。 */
  readonly url?: string
  /** 检查间隔；默认 60 秒。太频繁没有意义，构建不会那么快。 */
  readonly intervalMs?: number
  /** 取 HTML 的实现；测试注入。 */
  readonly fetchHtml?: (url: string) => Promise<string>
  /** 定时器注入；测试用。 */
  readonly setInterval?: (handler: () => void, ms: number) => number
  readonly clearInterval?: (handle: number) => void
}

/** 一个正在运行的版本监测。 */
export interface VersionWatch {
  /** 停止监测。 */
  readonly stop: () => void
  /**
   * 立刻检查一次。
   * @returns 发现新版本返回 `true`；没有变化或检查失败返回 `false`。
   */
  readonly check: () => Promise<boolean>
}

/**
 * 开始监测线上版本。
 * @param options - 地址、间隔与注入项。
 * @param onUpdate - 发现新版本时回调；**调用方负责提示，不要在这里自动刷新**。
 * @returns 可停止的监测句柄。
 */
export function watchVersion(options: VersionWatchOptions, onUpdate: () => void): VersionWatch {
  const url = options.url ?? (typeof globalThis.location === 'undefined' ? '' : globalThis.location.href)
  const intervalMs = options.intervalMs ?? 60_000
  const fetchHtml = options.fetchHtml ?? (async (target: string) => {
    // `cache: 'no-store'`：要的就是线上**此刻**的入口，命中缓存等于白问。
    const response = await fetch(target, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  })
  const start = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as number)
  const stopTimer = options.clearInterval ?? ((handle) => { globalThis.clearInterval(handle) })

  /** 冷启动的基线；第一次成功检查后才有值。 */
  let baseline: string | null = null
  let stopped = false
  let announced = false

  const check = async (): Promise<boolean> => {
    if (stopped || url.length === 0) return false
    let current: string | null
    try {
      current = bundleOf(await fetchHtml(url))
    } catch {
      // 检查失败什么都不做：用户没要求这件事，网络抖一下不该变成界面上的红字。
      return false
    }
    if (current === null) return false
    if (baseline === null) {
      baseline = current
      return false
    }
    if (current === baseline || announced) return false
    announced = true
    onUpdate()
    return true
  }

  const handle = start(() => { void check() }, intervalMs)
  return {
    stop: () => { stopped = true; stopTimer(handle) },
    check,
  }
}
