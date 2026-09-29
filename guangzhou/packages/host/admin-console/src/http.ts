/**
 * HTTP 层的小工具。
 *
 * 用 `node:http` 而不是宿主那套 `Request`/`Response`：本服务是**独立进程**，
 * 不跑在 cordis 宿主里，也不该为了复用而把宿主插件面拖进来（那会让"管理台能不能
 * 单独启动"取决于工作台的内核）。这里只依赖 `node:http`、`node:fs`、`node:crypto`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { resolveClientAddress, type ClientAddress } from './client-ip.ts'

/** 请求体上限。管理台的请求都很小（一次一条记录），超过就是异常。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 读请求体。 */
export type BodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly code: 'bad_request' | 'too_large'; readonly message: string }

/**
 * 读并解析 JSON 请求体。
 * @param request - 原始请求。
 * @param maxBytes - 上限。
 * @returns 解析结果；非对象（数组/标量）一律按形状错误处理。
 */
export async function readJsonBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      return { ok: false, code: 'too_large', message: '请求体太大了。' }
    }
    chunks.push(buffer)
  }
  if (size === 0) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'bad_request', message: '请求体必须是 JSON 对象。' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, code: 'bad_request', message: '请求体不是合法 JSON。' }
  }
}

/** 统一的 JSON 响应头。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 管理台的数据一律不许被中间层或浏览器缓存。
  'cache-control': 'no-store, no-cache, must-revalidate',
  'x-content-type-options': 'nosniff',
  // 管理台是内部系统：禁止被任何站点内嵌。
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  // 管理台只走 HTTPS（会话 cookie 带 Secure）。不带 includeSubDomains：
  // 这条头部只约束发送它的主机（admin.*），不影响其他子域。
  'strict-transport-security': 'max-age=15552000',
} as const

/**
 * 发一个 JSON 响应。
 * @param response - 原始响应。
 * @param status - 状态码。
 * @param value - 响应体。
 * @param extraHeaders - 额外响应头（如 Set-Cookie）。
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string | readonly string[]> = {},
): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
  response.end(body)
}

/** 发一段纯文本。 */
export function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(text)
}

/**
 * 取来源地址。
 * @param request - 原始请求。
 * @param trustProxy - 是否采信代理头（部署在 nginx 之后为 `true`）。
 * @returns 地址与判据来源。
 */
export function clientAddressOf(request: IncomingMessage, trustProxy: boolean): ClientAddress {
  return resolveClientAddress(
    request.socket.remoteAddress ?? undefined,
    (name) => {
      const value = request.headers[name]
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    },
    trustProxy,
  )
}

/** MIME 表（只列我们会发的类型；未知一律 `application/octet-stream`）。 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 把 URL 路径安全地映射到根目录下的文件。
 *
 * 目录穿越（`/../../etc/passwd`）必须在这里被挡住：解析后再确认结果仍在根目录之内，
 * 而不是简单地"把 `..` 删掉"（那种做法面对编码变体会失效）。
 * @param root - 静态根目录。
 * @param pathname - URL 路径（已不含 query）。
 * @returns 绝对路径；越界返回 `null`。
 */
export function safeJoin(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // NUL 字节截断攻击（`/a\0.html`）。
  if (decoded.includes('\0')) return null
  const base = resolve(root)
  const target = normalize(join(base, decoded))
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null
  return target
}

/**
 * 发一个静态文件。
 * @param response - 原始响应。
 * @param filePath - 文件绝对路径。
 * @param options - 是否允许缓存（带哈希的资源可以长缓存）。
 * @returns 是否发送成功。
 */
export async function sendFile(
  response: ServerResponse,
  filePath: string,
  options: { readonly immutable?: boolean } = {},
): Promise<boolean> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    response.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'cache-control': options.immutable === true ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=15552000',
    })
    createReadStream(filePath).pipe(response)
    return true
  } catch {
    return false
  }
}

/**
 * `/api/...` 的路径判定与归一化。
 * @param url - `request.url`（可能带 query）。
 * @returns 路径部分（去掉末尾斜杠）。
 */
export function pathnameOf(url: string | undefined): string {
  const raw = url ?? '/'
  const queryIndex = raw.indexOf('?')
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

/**
 * 同源检查（防 CSRF 的第二道，`SameSite=Strict` 是第一道）。
 *
 * 判据：**带 `Origin` 就必须与本站一致**。不带 `Origin` 的请求（命令行 curl、
 * 服务端之间调用）放行——它们没有浏览器的 cookie 自动携带行为，
 * 伪造它们需要先拿到会话令牌，而拿到令牌的人本来就能直接用。
 * @param request - 原始请求。
 * @param expectedOrigin - 期望的来源（`https://admin.qianshousuanli.com`）。
 * @returns 允许返回 `null`，否则返回拒绝原因。
 */
export function checkOrigin(request: IncomingMessage, expectedOrigin: string): string | null {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    return origin === expectedOrigin ? null : `跨站请求被拒绝（Origin: ${origin}）。`
  }
  const referer = request.headers.referer
  if (typeof referer === 'string' && referer.length > 0) {
    return referer === expectedOrigin || referer.startsWith(`${expectedOrigin}/`)
      ? null
      : `跨站请求被拒绝（Referer: ${referer}）。`
  }
  return null
}
