/**
 * 手机端静态预览服务。
 *
 * 支持两种挂载方式：
 * - 根路径 `/`（vite base 为 `/` 时）
 * - `/mobile/` 前缀（vite base 为 `/mobile/` 时，工作台内嵌用）
 * 两种都指向同一个 dist，避免"构建配置一改、预览就白屏"。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 发哪份产物。
 *
 * 两种部署同时存在，产物的资源前缀不同，不能混用：
 * - `dist`：独立预览（`/` 前缀），手机现在在看的那个地址；
 * - `dist-mobile`：与工作台同源部署（`/mobile/` 前缀），为的是让手机调工作台接口不再跨域。
 */
const ROOT = process.env.SERVE_ROOT ?? fileURLToPath(new URL('../dist/', import.meta.url))
const PORT = Number(process.env.PORT ?? 3100)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/** 把请求路径映射到磁盘文件；未知路径回退到 index.html（SPA）。 */
function resolveFile(pathname) {
  // 去掉 /mobile 前缀后按根路径解析
  const stripped = pathname.replace(/^\/mobile(?=\/|$)/, '')
  const rel = stripped === '/' || stripped === '' ? 'index.html' : stripped.replace(/^\/+/, '')
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  return join(ROOT, safe)
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://x')
  let file = resolveFile(url.pathname)
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(ROOT, 'index.html')   // SPA 回退
  }
  try {
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    response.end(body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => console.log(`手机端预览: http://127.0.0.1:${PORT}/  （同时支持 /mobile/ 前缀）`))
