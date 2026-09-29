/**
 * 独立复核用的测试台架（**不属于交付代码**）。
 *
 * 为什么复核要自带一份台架而不是 import `tests/server.spec.ts`：
 * 那份文件里已经有 `describe`，import 它等于顺带注册了交付方的测试，
 * "我自己的对抗性用例"就和"被复核对象的用例"混在一起，红绿都说不清是谁的。
 * 这里刻意只依赖 `src/` 的公开接口与 node 内置模块。
 *
 * 台架形状与部署一致：socket 永远是回环（相当于 nginx），真实来源放在
 * `X-Real-IP` 里；这一点很关键——白名单判定采信代理头的前提是"socket 是回环"。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, createAdminService, type AdminConfig, type AdminService } from '../src/server.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

/** 打桩上游账号服务：只实现管理台用到的四条路径。 */
export function stubUpstream(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/auth/login') && method === 'POST') {
      if (body['password'] !== '正确口令') return json(401, { message: '账号或密码不对。' })
      const id = body['username'] === 'other' ? 200 : body['username'] === 'nobody' ? 999 : 167
      return json(200, {
        tokens: { access_token: `access-${id}`, refresh_token: `refresh-${id}` },
        account: { id, username: String(body['username']) },
      })
    }
    if (url.endsWith('/auth/me')) {
      const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
      if (!authorization.startsWith('Bearer access-')) return json(401, { message: '会话失效' })
      return json(200, { account: { id: authorization.replace('Bearer access-', ''), username: 'admin' } })
    }
    if (url.endsWith('/auth/logout')) return json(200, { ok: true })
    return json(404, { message: 'not stubbed' })
  }
}

/** 台架。 */
export interface Harness {
  readonly service: AdminService
  readonly dataDir: string
  readonly webRoot: string
  readonly base: string
  readonly origin: string
  readonly close: () => Promise<void>
  /** 发一次真实 HTTP 请求（走 socket，模拟 nginx 写在 X-Real-IP 里的来源）。 */
  readonly api: (path: string, options?: {
    readonly body?: Record<string, unknown>
    readonly cookie?: string
    readonly ip?: string
    readonly origin?: string | null
    readonly method?: string
    readonly rawPath?: string
  }) => Promise<ApiResult>
}

/** 一次接口调用的结果。 */
export interface ApiResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly cookie: string | null
  readonly headers: Headers
}

/** 台架收集器（用完统一关闭）。 */
export const startedHarnesses: Harness[] = []

/** 起一个被测服务。 */
export async function startHarness(options: {
  /** 白名单内容（默认放行 TEST-NET-2 段）。空数组 = 默认拒绝一切。 */
  readonly allowEntries?: readonly string[]
  readonly enabled?: boolean
  /** 直接落一份管理员表（等价于 CLI `admin grant`）。 */
  readonly admins?: readonly AdminRecord[]
  /** 直接落一份自定义角色表。 */
  readonly roles?: readonly RoleRecord[]
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'admin-console-review-'))
  const dataDir = join(root, 'data')
  const dshHome = join(root, 'dsh')
  const webRoot = join(root, 'web')
  await mkdir(dataDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(webRoot, { recursive: true })
  const origin = 'https://admin.review'
  const config: AdminConfig = {
    dataDir,
    webRoot,
    origin,
    accountBaseUrl: 'https://accounts.test',
    dshHome,
    tiersPath: fileURLToPath(new URL('../../model-gateway/src/tiers.ts', import.meta.url)),
    trustProxy: true,
    fetch: stubUpstream(),
  }
  const service = createAdminService(config)
  const entries = options.allowEntries ?? ['198.51.100.0/24']
  await service.components.whitelist.save({
    version: 1,
    enabled: options.enabled ?? true,
    entries: entries.map(cidr => ({ cidr, note: 'review', addedBy: 'review', addedAt: 0 })),
  })
  if (options.admins !== undefined) await service.components.admins.save({ version: 1, admins: options.admins })
  if (options.roles !== undefined) await service.components.roles.save({ version: 1, roles: options.roles })
  const server = createServer((request, response) => { void service.handle(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const harness: Harness = {
    service,
    dataDir,
    webRoot,
    base,
    origin,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
    api: async (path, requestOptions = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (requestOptions.cookie !== undefined) headers['cookie'] = requestOptions.cookie
      // 模拟 nginx：socket 永远是回环，真实来源在 X-Real-IP 里。
      headers['x-real-ip'] = requestOptions.ip ?? '198.51.100.7'
      if (requestOptions.origin !== null) headers['origin'] = requestOptions.origin ?? origin
      const target = requestOptions.rawPath ?? `${API_PREFIX}${path}`
      const response = await fetch(`${base}${target}`, {
        method: requestOptions.method ?? 'POST',
        headers,
        ...(requestOptions.method === 'GET' ? {} : { body: JSON.stringify(requestOptions.body ?? {}) }),
      })
      const text = await response.text()
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        parsed = { _raw: text }
      }
      return { status: response.status, body: parsed, cookie: response.headers.get('set-cookie'), headers: response.headers }
    },
  }
  startedHarnesses.push(harness)
  return harness
}

/** 关闭全部台架。 */
export async function closeAllHarnesses(): Promise<void> {
  for (const harness of startedHarnesses.splice(0)) await harness.close()
}

/** 造一条管理员记录。 */
export function adminRecord(accountId: string, roleId: string, scope: 'all' | 'self' = 'all'): AdminRecord {
  return {
    accountId,
    displayName: `账号 ${accountId}`,
    roleId,
    scope,
    enabled: true,
    createdAt: 0,
    createdBy: 'review',
  }
}

/** 登录并返回 cookie（默认以 167 登录）。 */
export async function login(harness: Harness, username = 'admin', ip = '198.51.100.7'): Promise<string> {
  const result = await harness.api('/session/login', { body: { username, password: '正确口令' }, ip })
  if (result.status !== 200) throw new Error(`登录失败：${result.status} ${JSON.stringify(result.body)}`)
  return (result.cookie ?? '').split(';')[0] ?? ''
}

/** 走完一次两步确认（preflight → apply）。 */
export async function twoStep(
  harness: Harness,
  preflightPath: string,
  applyPath: string,
  body: Record<string, unknown>,
  cookie: string,
  options: { readonly reason?: string; readonly ip?: string } = {},
): Promise<{ readonly preflight: ApiResult; readonly apply: ApiResult }> {
  const preflight = await harness.api(preflightPath, { body, cookie, ...(options.ip === undefined ? {} : { ip: options.ip }) })
  const confirm = preflight.body['confirm'] as { token?: string } | undefined
  const apply = await harness.api(applyPath, {
    body: { ...body, token: confirm?.token ?? 'missing-token', reason: options.reason ?? '复核用例修改原因' },
    cookie,
    ...(options.ip === undefined ? {} : { ip: options.ip }),
  })
  return { preflight, apply }
}

/** 造一个"非回环 socket 直连"的请求（用来验证伪造代理头无效）。 */
export function fakeRequest(input: {
  readonly url: string
  readonly remoteAddress: string
  readonly headers: Record<string, string>
  readonly body?: Record<string, unknown>
}): IncomingMessage {
  const bodyText = JSON.stringify(input.body ?? {})
  const stream = Readable.from([Buffer.from(bodyText, 'utf8')])
  return Object.assign(stream, {
    url: input.url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...input.headers },
    socket: { remoteAddress: input.remoteAddress },
  }) as unknown as IncomingMessage
}

/** 接收一个响应的假对象（只够 `sendJson`/`sendText` 用）。 */
export function fakeResponse(): { readonly response: ServerResponse; readonly captured: () => { status: number; headers: Record<string, unknown>; body: string } } {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const response = {
    headersSent: false,
    writeHead: (status: number, headers?: Record<string, unknown>) => {
      state.status = status
      state.headers = headers ?? {}
      return response
    },
    end: (chunk?: string | Buffer) => {
      state.body = typeof chunk === 'string' ? chunk : chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
      return response
    },
  }
  return { response: response as unknown as ServerResponse, captured: () => state }
}

/** 读一份数据文件（复核要看的真实落盘内容）。 */
export async function readDataFile(harness: Harness, name: string): Promise<string> {
  return await readFile(join(harness.dataDir, name), 'utf8')
}

/** 直接覆盖一份数据文件（模拟另一个进程/CLI 的写入）。 */
export async function writeDataFile(harness: Harness, name: string, value: unknown): Promise<void> {
  await writeFile(join(harness.dataDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** 关掉一个直连服务器（给需要非回环 socket 的用例用）。 */
export type { Server, ServerResponse }
