/**
 * 把手机端页面挂在工作台的**同源**路径下（默认 `/mobile`）。
 *
 * 为什么这件事必须做：手机端的**订阅通道只在同源时才启用**——非同源（遥控/配对形态）
 * 带的是别人那台电脑的凭据，用它调订阅通道会把费用记到那台电脑的账号上。
 * 而"同源"不能靠嘴说：手机页面必须**真的由工作台自己提供**，否则它永远停在
 * "独立预览"形态，订阅通道永远不启用——功能写着能跑，实际一次都没跑过。
 * 实测过这个缺口：工作台上的 `/mobile/` 是 404。
 *
 * 三条纪律：
 * 1. **目录穿越必须挡住**。路径来自请求，`../` 一穿就能读到仓库里任何文件（包括凭据）。
 *    这里用"解析后必须以目标根目录开头"来判定，而不是靠字符串里有没有 `..`——
 *    后者能被编码绕过。
 * 2. **只服务白名单扩展名**。这个目录里只该有页面产物；放开任意扩展名等于把
 *    宿主文件系统的一角暴露出去。
 * 3. **未配置就不注册**。没配 `mobileStaticDir` 的部署不该凭空多出一条路由，
 *    更不该因为目录不存在而起不来。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** 静态资源的扩展名白名单与类型。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 把请求路径解析成磁盘上的真实文件，越界一律返回 `null`。
 *
 * 判定方式是"解析后的绝对路径必须落在根目录内"，而不是检查路径里有没有 `..`——
 * 后者挡不住编码变形。`resolve` 会把 `..` 与编码都归一化掉，所以这一步是可靠的。
 * @param root - 静态根目录（绝对路径）。
 * @param pathname - 请求路径（已去掉前缀）。
 * @returns 可安全读取的绝对路径，或 `null`。
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // 坏的百分号转义是攻击面，不是可恢复错误。
    return null
  }
  // 前导斜杠会让 `join` 把它当绝对路径，先削掉再拼接。
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolve(root, relative)
  const rootResolved = resolve(root)
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${sep}`)) return null
  return candidate
}

/** 一条静态服务路由。 */
export interface MobileStaticRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * 建一条手机端静态服务路由。
 * @param options - 挂载前缀与静态根目录。
 * @returns 可直接交给 `webServer.register` 的路由。
 */
export function createMobileStaticRoute(options: {
  readonly prefix: string
  readonly root: string
}): MobileStaticRoute {
  /** 去掉尾部斜杠，避免出现 `//`。 */
  const prefix = options.prefix.replace(/\/+$/, '')
  const root = resolve(options.root)

  /**
   * index.html 的内容在单页应用里要能处理子路径，所以非资源请求回退到它。
   *
   * **必须显式 `no-cache`**。这是实测抓到的一个真缺陷：早先这里只设了 content-type，
   * 于是 HTML 进了浏览器缓存——而 HTML 里引用的资源名带内容哈希，一旦缓存住，
   * 用户会一直加载**旧哈希**的资源，表现为"改了、发了，但界面没变"。
   * 而"让用户清缓存"不该是交付方式。带哈希的静态资源可以长缓存，HTML 不行。
   */
  const serveIndex = async (res: ServerResponse): Promise<void> => {
    const indexPath = join(root, 'index.html')
    try {
      const info = await stat(indexPath)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('手机端页面尚未构建。')
      return
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES['.html'] as string,
      // 页面的更新机制就靠这一行。
      'cache-control': 'no-cache',
    })
    createReadStream(indexPath).pipe(res)
  }

  return {
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      const raw = req.url ?? '/'
      const questionMark = raw.indexOf('?')
      const pathname = questionMark === -1 ? raw : raw.slice(0, questionMark)
      const rest = pathname.slice(prefix.length)
      const target = resolveStaticPath(root, rest.length === 0 ? '/' : rest)
      if (target === null) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const type = CONTENT_TYPES[extname(target).toLowerCase()]
      if (type === undefined) {
        // 不是白名单里的资源：当成单页应用的路由，回 index.html。
        // 这样 `/mobile/任何前端路由` 都能打开，而不会 404。
        await serveIndex(res)
        return
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) throw new Error('not a file')
      } catch {
        // 资源不存在：可能是构建产物换了哈希，也可能是有人在探路径。
        // 两种都回 404，不透出目录结构。
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': type,
        // 产物文件名带内容哈希，可以长缓存；index.html 不带哈希，必须每次校验。
        'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      })
      createReadStream(target).pipe(res)
    },
  }
}
