/**
 * 同源手机端静态服务的契约测试。
 *
 * 为什么这是一件**产品功能**而不是运维小事：手机端的订阅通道**只在同源时启用**。
 * 非同源（遥控/配对形态）带的是别人那台电脑的凭据，用它调订阅通道会**把费用记到
 * 那台电脑的账号上**——一个不会报错、只会悄悄记错账的 bug。而同源不能靠嘴说：
 * 手机页面必须真的由工作台自己提供。实测过这个缺口：工作台上的 `/mobile/` 曾是 404，
 * 于是"同源时能用"这句话一直没有依据。
 *
 * 安全边界是这个文件的重点：路径来自请求，一次目录穿越就能读到仓库里任何文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMobileStaticRoute, resolveStaticPath } from '../src/mobile-static.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个假的手机端产物目录。 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianshou-mobile-dist-'))
  dirs.push(root)
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div><script src="/mobile/assets/index-abc.js"></script>')
  writeFileSync(join(root, 'assets', 'index-abc.js'), 'console.log(1)')
  return root
}

describe('目录穿越：靠不变式，不靠逐个输入猜', () => {
  /**
   * 一开始我把断言写成"这些输入应该被挡住"，但那一批输入里**没有一个真能穿越**：
   * `/../package.json` 在 Node 的路径语义里等价于 `/package.json`（`..` 在根处停住），
   * 所以"放行"是对的。逐个猜输入只会写出错断言。真正该断言的是不变式：
   * **无论给什么，结果要么是 null，要么落在根目录内。**
   */
  const PROBES = [
    '/index.html', '/../package.json', '/../../../etc/passwd', '/%2e%2e/package.json',
    '/..%2fpackage.json', '/....//package.json', '/assets/../../package.json',
    '////etc/passwd', '/../'.repeat(40) + 'etc/passwd', '/~/.ssh/id_rsa',
    '/%2e%2e%2f%2e%2e%2fetc/passwd', '/.env', '/assets/../../../../../../etc/hosts',
    '/\\..\\..\\package.json', '/%c0%ae%c0%ae/etc/passwd', '/a/b/c/../../../../../../x',
  ]

  it('任何探测输入都不会解析到根目录之外', () => {
    const root = fixture()
    for (const probe of PROBES) {
      const result = resolveStaticPath(root, probe)
      if (result === null) continue
      expect(result === root || result.startsWith(`${root}/`)).toBe(true)
    }
  })

  it('坏的百分号转义被拒绝（那是攻击面，不是可恢复错误）', () => {
    expect(resolveStaticPath(fixture(), '/%zz')).toBeNull()
  })

  it('正常路径解析到根目录内的文件', () => {
    const root = fixture()
    expect(resolveStaticPath(root, '/index.html')).toBe(join(root, 'index.html'))
  })
})

describe('静态服务：能服务页面，且不透出不该给的东西', () => {
  /** 起一条路由并直接调用它，返回状态与正文。 */
  async function fetchThrough(root: string, url: string): Promise<{ status: number; type: string | undefined; body: string }> {
    const route = createMobileStaticRoute({ prefix: '/mobile', root })
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未能取得端口')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`)
      return { status: response.status, type: response.headers.get('content-type') ?? undefined, body: await response.text() }
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }

  it('根路径回 HTML', async () => {
    const { status, type, body } = await fetchThrough(fixture(), '/mobile/')
    expect(status).toBe(200)
    expect(type).toContain('text/html')
    expect(body).toContain('/mobile/assets/')
  })

  it('带哈希的资源被长缓存，index.html 不缓存', async () => {
    const route = createMobileStaticRoute({ prefix: '/mobile', root: fixture() })
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未能取得端口')
    try {
      // 产物名带内容哈希 → 可以长缓存；index.html 不带哈希 → 必须每次校验，
      // 否则用户会一直看到旧版本，而"清缓存"这种事不该由用户来做。
      const js = await fetch(`http://127.0.0.1:${address.port}/mobile/assets/index-abc.js`)
      expect(js.headers.get('cache-control')).toContain('immutable')
      const html = await fetch(`http://127.0.0.1:${address.port}/mobile/`)
      expect(html.headers.get('cache-control')).toBe('no-cache')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('前端子路由回退到 index.html（不 404）', async () => {
    const { status, type } = await fetchThrough(fixture(), '/mobile/some/deep/route')
    expect(status).toBe(200)
    expect(type).toContain('text/html')
  })

  it('不存在的资源回 404，不透出目录结构', async () => {
    const { status } = await fetchThrough(fixture(), '/mobile/assets/nope.js')
    expect(status).toBe(404)
  })

  it('目录不存在时回 404 而不是崩', async () => {
    const missing = join(tmpdir(), `qianshou-nonexistent-${String(Date.now())}`)
    const { status } = await fetchThrough(missing, '/mobile/')
    expect(status).toBe(404)
  })
})
