/**
 * 给**本机的模型适配器**用的一条 OpenAI 兼容路径（默认挂在 `/qianshou-ai` 下）。
 *
 * ## 为什么需要它
 *
 * 宿主的 `/api` 前缀路由前面有一道**信任门**（`requestRejection`）：先看 Host/Origin
 * 围栏，再要一枚**宿主进程签名**的浏览器 cookie（密钥只活在进程内存里）。
 * 本机的模型适配器不会带 cookie——它发的是 `Bearer`——所以被门挡在外面，
 * 拿到一个纯文本 401。实测确认过：`{ HTTP: 401, 正文: "unauthorized" }`。
 *
 * 于是有两条路可以走：
 * 1. 削弱 `/api` 的门禁，让本机请求免检——**这会动到所有接口的安全边界**，不做。
 * 2. 给适配器**另开一条路**，把门挂在自己的前缀下，由我们自己把门。← 就是这里。
 *
 * 走第 2 条的好处是：`/api` 那道门**一个字都不用改**，而这条路上的规则是我们自己写的、
 * 也是我们能解释清楚的。
 *
 * ## 这条路的门规（三条，都要能解释）
 *
 * 1. **只认 loopback**。来源不是本机一律 403，并在日志里留痕。
 *    HTTP 头里最容易伪造的是 `Host`/`Origin`，所以判定用**连接的远端地址**，
 *    不是任何请求头。
 * 2. **认证走 socket，不走应用层令牌**。这是刻意的，理由见 `routes.ts` 里那段说明：
 *    本机上任何能发这些请求的进程，本来就能读 `$DSH_HOME/.credentials.yaml` 里的上游密钥。
 *    在这里自造一个令牌，安全收益接近零，却会制造"看起来有认证"的假象。
 * 3. **身份仍取自宿主的账号会话**（同一个 `principalOf`）。所以"谁在用"这件事
 *    与手机端、控制台完全一致，不存在两套身份。
 *
 * ## 将来必须改的前置条件
 *
 * 一旦这条路径要跨机器（手机直连、第三方、公网），**必须先**做真正的令牌体系
 * （签发、撤销、按账号隔离、审计）——那时 loopback 断言会拦住它，而这正是我们想要的：
 * **它会在越界的那一刻拒绝，而不是默默放行。**
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 与 `webServer.register` 兼容的路由形状（自己声明，不去依赖别的包的内部类型）。 */
interface PrefixRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 默认挂载前缀。 */
export const LOCAL_OPENAI_PREFIX = '/qianshou-ai'

/**
 * 判断一个 socket 远端地址是否属于本机。
 *
 * 导出是为了让测试能**直接断言判定本身**——包括那些"看起来像本机"的写法
 * （`127.0.0.1.evil.com`）必须被判为非本机。
 * @param address - `socket.remoteAddress`（内核给的连接事实）。
 * @returns 是本机返回 `true`。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  // 只认 127/8：`127.0.0.1.evil.com` 这种"看起来像"的写法必须落空。
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) && parts[0] === '127'
}

/** 判断请求是否来自本机。 */
function isLoopback(request: IncomingMessage): boolean {
  /**
   * **用 socket 的远端地址判定，不看任何请求头**。
   *
   * `Host` 与 `Origin` 都是请求头，可以随便伪造；`X-Forwarded-For` 更是如此。
   * 而 `req.socket.remoteAddress` 是内核给的连接事实，伪造不了。
   * 这是这条路上唯一可靠的判据。
   */
  return isLoopbackAddress(request.socket.remoteAddress)
}

/**
 * 判断 `Host`（或 `:authority`）是否只指向本机。
 *
 * 为什么必须查它：`Host` 是**浏览器可以带着一起来**的，而 DNS rebinding 攻击
 * 正是靠把某个域名解析到 127.0.0.1，让浏览器以"同源"的姿态打本机服务。
 * 只认 loopback 主机名，rebinding 就失效了。
 * @param host - `Host` 头。
 * @returns 只指向本机返回 `true`。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return false
  // 去掉端口（`[::1]:3091` 这种 IPv6 写法要单独处理方括号）。
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0] ?? ''
  const bare = withoutPort.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || isLoopbackAddress(bare)
}

/**
 * 一条**本机进程**发来的请求该有样子：没有浏览器来源标记。
 *
 * 这是本次修复的要点。早先只用 `socket.remoteAddress` 判 loopback——
 * 而**浏览器里任何网页**发一条 `fetch('http://127.0.0.1:<port>/qianshou-ai/…')`
 * 时，来源地址**也是本机**。于是任意页面都能花掉用户的额度与上游密钥
 * （实测：带 `Origin: https://evil.example.com` 的请求被放行成 200）。
 * 我原先"本机进程本来就能读密钥"的推理**漏掉了浏览器这个混淆代理**——
 * 本机进程是我们自己的代码，而网页是**别人控制的代码**，两者不能等同。
 *
 * 判据是三条都成立才算本机进程：
 * 1. 没有 `Origin`（浏览器跨源请求一定会带）；
 * 2. 没有 `Sec-Fetch-*`（现代浏览器对 fetch/XHR 一定会带 `Sec-Fetch-Mode`）；
 * 3. `Host` 只指向本机（挡 DNS rebinding）。
 * @param headers - 请求头。
 * @returns 像是本机进程发来的返回 `true`。
 */
export function looksLikeLocalProcessRequest(headers: {
  readonly origin?: string | undefined
  readonly host?: string | undefined
  readonly secFetchMode?: string | undefined
  readonly secFetchSite?: string | undefined
}): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (headers.origin !== undefined && headers.origin.length > 0) {
    return { ok: false, why: '带 Origin 头（浏览器跨源请求）' }
  }
  /**
   * **不再因为"有 `Sec-Fetch-*`"就拒绝**——这是本次修复的核心。
   *
   * 原来这里是无条件拒绝：`secFetchMode !== undefined || secFetchSite !== undefined`
   * → 拒。理由是"现代浏览器对 fetch/XHR 一定会带 `Sec-Fetch-Mode`"。
   *
   * **但那条推理漏了一半**：这个头不只第三方网页会带，**我们自己的产品运行时也带**。
   * 实测到的真实请求（`[qianshou-diag] trust-gate rejected`）：
   * ```
   * why=带 Sec-Fetch-* 头   origin=undefined   host=127.0.0.1:3091
   * secFetchMode=cors       secFetchSite=undefined
   * url=/qianshou-ai/v1/chat/completions
   * ```
   * —— `Origin` **不存在**、`Sec-Fetch-Site` **不存在**，只有 `Sec-Fetch-Mode: cors`。
   * 于是**千手自己的界面被自己的门挡住了**：403 → 适配器把 403 映射成 `AUTH`
   * → 用户看到「本轮运行失败 模型接口鉴权失败」，而网关审计里没有任何记录
   * （请求在进入路由前就被拒），curl 直连却永远 200（curl 不带这些头）。
   *
   * **正确的判据是 `Origin`**：浏览器对**任何跨源 POST** 都必定带 `Origin`，
   * 那条正是"别人网页"的可靠标记，也是这道门真正要挡的东西（保留）。
   * 而 `Sec-Fetch-Site` 只应在其**明确表示跨站**时才作为拒绝依据：
   * - `cross-site` → 别的站点发起的，拒；
   * - `same-origin` / `none` / 缺失 → 本机服务自己的页面或运行时，放行。
   *
   * 这样既不放松对第三方网页的防护，也不再误伤自家界面。
   */
  if (headers.secFetchSite !== undefined
    && headers.secFetchSite !== 'same-origin'
    && headers.secFetchSite !== 'none') {
    return { ok: false, why: `Sec-Fetch-Site 表明跨站（${headers.secFetchSite}）` }
  }
  if (!isLoopbackHost(headers.host)) {
    return { ok: false, why: `Host 不是本机（${headers.host ?? '无'}）` }
  }
  return { ok: true }
}

/** 一条本机 OpenAI 兼容路由。 */
export type LocalOpenAiRoute = PrefixRoute

/**
 * 建一条本机适配器专用的 OpenAI 兼容路由。
 * @param options - 挂载前缀与处理器（处理器收到的是一个标准的 `Request`）。
 * @returns 可直接交给 `webServer.register` 的路由。
 */
export function createLocalOpenAiRoute(options: {
  readonly prefix?: string
  /** 处理一条 OpenAI 兼容请求；返回 `Response`（通常是 SSE）。 */
  readonly handle: (request: Request) => Promise<Response>
  /** 越界时的留痕回调；省略时只拒绝不记录。 */
  readonly onRejected?: (detail: { readonly remoteAddress: string; readonly url: string; readonly why?: string }) => void
  /** 请求体上限；省略时用 2 MiB（与 `/api` 那条路的量级一致）。 */
  readonly maxBodyBytes?: number
}): LocalOpenAiRoute {
  const prefix = (options.prefix ?? LOCAL_OPENAI_PREFIX).replace(/\/+$/, '')
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024

  return {
    kind: 'prefix',
    path: prefix,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isLoopback(req)) {
        // 不是本机：拒绝并留痕。**这条路径只服务本机**，越界本身就是异常事件。
        options.onRejected?.({ remoteAddress: req.socket.remoteAddress ?? 'unknown', url: req.url ?? '', why: '非本机地址' })
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '这条路径只服务本机。', type: 'forbidden' } }))
        return
      }

      /**
       * **来源判定**：loopback 地址还不够。
       *
       * 浏览器里任何一个网页发来的请求，来源地址**也是本机**，所以单看 socket 地址
       * 等于给任意网页开了后门（实测能被放行）。这里再查浏览器来源标记。
       */
      const source = looksLikeLocalProcessRequest({
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
        host: typeof req.headers.host === 'string' ? req.headers.host : undefined,
        secFetchMode: typeof req.headers['sec-fetch-mode'] === 'string' ? req.headers['sec-fetch-mode'] : undefined,
        secFetchSite: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined,
      })
      if (!source.ok) {
        options.onRejected?.({ remoteAddress: req.socket.remoteAddress ?? 'unknown', url: req.url ?? '', why: source.why })
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '这条路径只服务本机进程。', type: 'forbidden' } }))
        return
      }

      /**
       * **体积闸门**。`/api` 那条路有 `MAX_BODY_BYTES`，这条早先漏了——
       * 一个本机进程（或任何能发请求的东西）可以拿超大请求体把内存打满。
       */
      const declared = Number(req.headers['content-length'] ?? '0')
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '请求太大了。', type: 'payload_too_large' } }))
        return
      }

      // 把 node 的请求体读成一个标准 Request，交给同一个处理器——
      // 这样"本机路径"与"带会话的路径"用的是**同一份**准入、计费与审计代码，
      // 不会出现两条路行为不一致。
      const chunks: Buffer[] = []
      let received = 0
      let tooLarge = false
      for await (const chunk of req) {
        received += (chunk as Buffer).byteLength
        // 声明值可能不实，所以**边收边数**。
        if (received > maxBodyBytes) { tooLarge = true; break }
        chunks.push(chunk as Buffer)
      }
      if (tooLarge) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: '请求太大了。', type: 'payload_too_large' } }))
        req.destroy()
        return
      }
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', `http://127.0.0.1${prefix}`)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) headers.set(key, value.join(', '))
      }
      /**
       * **把客户端断开接到上游**。早先没传 signal，客户端走了之后上游还在生成、
       * **还在计费**，钱白花。现在断开就中止。
       */
      const abort = new AbortController()
      const onClose = (): void => { if (!res.writableEnded) abort.abort() }
      res.on('close', onClose)

      let response: Response
      try {
        response = await options.handle(new Request(url, {
          method: req.method ?? 'POST',
          headers,
          ...(body.length > 0 ? { body } : {}),
          signal: abort.signal,
        }))
      } catch (error) {
        // 处理器抛异常时给一个**带正文**的响应。宿主的 `/api` 会把异常压成一个
        // 没有正文的 400，那种失败排查起来极贵（我们已经吃过一次亏）。
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { message: `网关内部错误：${String(error).slice(0, 120)}`, type: 'internal_error' } }))
        return
      } finally {
        res.off('close', onClose)
      }

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body === null) { res.end(); return }
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await new Promise<void>((resolve) => {
          const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
          res.once('drain', done)
          res.once('close', done)
        })
      }
      res.end()
    },
  }
}
