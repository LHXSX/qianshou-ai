/**
 * 工作台连接层的测试。
 *
 * 用**真实的 node:http 服务端**扮演工作台（不是 fetch 打桩）：验证 token 换 cookie、
 * cookie 复用、RPC 信封、以及会话投影的字段过滤。打桩会把这些全绕过去，
 * 而真实故障恰恰出在这些边界上。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkbenchClient, WorkbenchFailure, WORKBENCH_COPY, parseEntryUrl,
} from '../src/workbench.ts'

const servers: Server[] = []
afterEach(() => { for (const s of servers) s.close() })

/** 起一个扮演工作台的真实服务端。 */
async function fakeWorkbench(options: {
  /** 正确 token；`null` 表示任何 token 都拒绝。 */
  goodToken?: string | null
  /** 记录收到的请求，供断言。 */
  log?: { path: string; cookie: string | undefined; body: string }[]
  /** 各 RPC 的返回体。 */
  routes?: Record<string, unknown>
  /** 对 RPC 一律返回鉴权失败。 */
  rejectRpc?: boolean
} = {}): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://x')
    const parts: Buffer[] = []
    request.on('data', part => parts.push(part))
    request.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8')
      options.log?.push({ path: url.pathname, cookie: request.headers.cookie, body })

      // 入口：token 换 cookie
      if (url.pathname === '/') {
        const token = url.searchParams.get('token') ?? ''
        if (options.goodToken !== null && token === (options.goodToken ?? '__NO__')) {
          response.writeHead(303, { 'set-cookie': 'dsh-auth-test=v1.payload.sig; Path=/; HttpOnly', location: '/' })
          response.end()
          return
        }
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false }))
        return
      }

      if (options.rejectRpc === true || request.headers.cookie?.includes('dsh-auth-test') !== true) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }

      const method = url.pathname.replace('/api/', '')
      const value = options.routes?.[method]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value === undefined
        ? { result: { ok: false, error: { message: `no route ${method}` } } }
        : { result: { ok: true, value } }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未取得端口')
  return `http://127.0.0.1:${address.port}`
}

describe('入口地址解析', () => {
  it('从带 token 的地址里抽出根地址与 token', () => {
    expect(parseEntryUrl('http://127.0.0.1:3091/?token=abc123'))
      .toEqual({ origin: 'http://127.0.0.1:3091', token: 'abc123' })
  })

  it('只有根地址时 token 为空串，仍可用（cookie 可能已在浏览器里）', () => {
    expect(parseEntryUrl('http://192.168.1.5:3091/')).toEqual({ origin: 'http://192.168.1.5:3091', token: '' })
  })

  it('https 地址同样接受', () => {
    expect(parseEntryUrl('https://203.0.113.20:18443/?token=xyz')?.origin).toBe('https://203.0.113.20:18443')
  })

  it('空串、乱码与非 http 协议都被拒绝', () => {
    expect(parseEntryUrl('')).toBeNull()
    expect(parseEntryUrl('随便写的字')).toBeNull()
    expect(parseEntryUrl('ftp://host/')).toBeNull()
  })
})

describe('连接与鉴权', () => {
  it('用入口 token 换到 cookie，并在后续 RPC 里复用', async () => {
    const log: { path: string; cookie: string | undefined; body: string }[] = []
    const origin = await fakeWorkbench({ goodToken: 'tok-1', log, routes: { 'session/list': { items: [] } } })
    const client = new WorkbenchClient({ origin, token: 'tok-1' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    await client.sessions(controller.signal)
    const rpcCall = log.find(entry => entry.path === '/api/session/list')
    expect(rpcCall?.cookie).toContain('dsh-auth-test')
  })

  it('token 错时报 unauthorized，并给出可操作的中文说明', async () => {
    const origin = await fakeWorkbench({ goodToken: 'right' })
    const client = new WorkbenchClient({ origin, token: 'wrong' })
    await expect(client.connect(new AbortController().signal)).rejects.toMatchObject({
      kind: 'unauthorized', message: WORKBENCH_COPY.unauthorized,
    })
  })

  it('RPC 返回 401 时报 unauthorized，不静默返回空列表', async () => {
    const origin = await fakeWorkbench({ goodToken: 'tok', rejectRpc: true })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    await expect(client.sessions(controller.signal)).rejects.toBeInstanceOf(WorkbenchFailure)
  })

  it('地址不可达时报 unreachable', async () => {
    const client = new WorkbenchClient({ origin: 'http://127.0.0.1:1', token: 'x' })
    await expect(client.connect(new AbortController().signal)).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('每个失败原因都有中文说明', () => {
    for (const kind of Object.keys(WORKBENCH_COPY)) {
      expect(WORKBENCH_COPY[kind as keyof typeof WORKBENCH_COPY].trim().length).toBeGreaterThan(0)
    }
  })
})

describe('会话投影', () => {
  it('抽取真实字段并按最近更新倒序', async () => {
    const origin = await fakeWorkbench({
      goodToken: 'tok',
      routes: {
        'session/list': {
          items: [
            { sessionId: 's-old', updatedAt: 100, running: false, cwd: '/a', projections: { values: { title: '旧会话' } } },
            { sessionId: 's-new', updatedAt: 900, running: true, cwd: '/b', projections: { values: { title: '新会话' } } },
          ],
        },
      },
    })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    const sessions = await client.sessions(controller.signal)
    expect(sessions.map(s => s.sessionId)).toEqual(['s-new', 's-old'])
    expect(sessions[0]).toMatchObject({ running: true, cwd: '/b', title: '新会话' })
  })

  it('标题为空或缺失时给 null，不编造名字', async () => {
    const origin = await fakeWorkbench({
      goodToken: 'tok',
      routes: {
        'session/list': {
          items: [
            { sessionId: 'a', updatedAt: 1, projections: { values: { title: null } } },
            { sessionId: 'b', updatedAt: 2, projections: { values: { title: '   ' } } },
            { sessionId: 'c', updatedAt: 3 },
          ],
        },
      },
    })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    expect((await client.sessions(controller.signal)).every(s => s.title === null)).toBe(true)
  })

  it('缺 sessionId 的脏条目被丢弃，不影响其余条目', async () => {
    const origin = await fakeWorkbench({
      goodToken: 'tok',
      routes: {
        'session/list': { items: [{ sessionId: 'ok', updatedAt: 5 }, { 乱码: true }, null, 'string'] },
      },
    })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    expect((await client.sessions(controller.signal)).map(s => s.sessionId)).toEqual(['ok'])
  })

  it('空会话列表返回空数组（真实情况，不是错误）', async () => {
    const origin = await fakeWorkbench({ goodToken: 'tok', routes: { 'session/list': { items: [] } } })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    expect(await client.sessions(controller.signal)).toEqual([])
  })
})

describe('子智能体与命令', () => {
  it('子智能体条目缺 id 时被丢弃', async () => {
    const origin = await fakeWorkbench({
      goodToken: 'tok',
      routes: { 'subagents/list': { entries: [{ id: 'a1', label: '研究员', state: 'running' }, { label: '无 id' }] } },
    })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    const entries = await client.subagents('s1', controller.signal)
    expect(entries).toEqual([{ id: 'a1', label: '研究员', state: 'running' }])
  })

  it('命令清单抽取 name 与 description', async () => {
    const origin = await fakeWorkbench({
      goodToken: 'tok',
      routes: { 'commands/list': [{ name: 'compact', description: '压缩历史' }, { name: 'export' }] },
    })
    const client = new WorkbenchClient({ origin, token: 'tok' })
    const controller = new AbortController()
    await client.connect(controller.signal)
    const commands = await client.commands('agent-1', controller.signal)
    expect(commands).toEqual([{ name: 'compact', description: '压缩历史' }, { name: 'export', description: '' }])
  })
})
