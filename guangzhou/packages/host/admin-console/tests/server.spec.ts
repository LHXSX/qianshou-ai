/**
 * 端到端（真 HTTP + 真文件 + 打桩账号上游）的验收测试。
 *
 * 为什么用真服务器而不是直接调 handler：这一版的价值几乎全在**链路上**——
 * 白名单 → 同源 → 会话 → 权限 → 两步确认 → 审计。只测函数会让"某一环没接上"
 * 这种最可能出错的情形漏掉。所以每个用例都是：起 `node:http`、发真请求、
 * 读真响应、必要时读磁盘上的真实文件。
 *
 * 上游账号服务用打桩 fetch：它的实现不在本任务范围内（复用既有账号体系），
 * 但我们**必须**证明自己的分类逻辑是对的（口令错 ≠ 不是管理员 ≠ 上游挂了）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { API_PREFIX, createAdminService, type AdminConfig, type AdminService } from '../src/server.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

/** 上游账号服务的打桩实现（只实现我们用到的四条路径）。 */
function stubUpstream(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith('/auth/login') && method === 'POST') {
      if (body['password'] === '需要两步验证') {
        return json(200, { two_factor_required: true, challenge_token: 'challenge-1' })
      }
      if (body['password'] !== '正确口令') return json(401, { message: '账号或密码不对。' })
      const id = body['username'] === 'nobody' ? 999 : body['username'] === 'other' ? 200 : 167
      return json(200, {
        tokens: { access_token: `access-${id}`, refresh_token: `refresh-${id}` },
        account: { id, username: String(body['username']) },
      })
    }
    if (url.endsWith('/auth/login/totp') && method === 'POST') {
      if (body['code'] !== '123456') return json(401, { message: '验证码不对。' })
      return json(200, { tokens: { access_token: 'access-167', refresh_token: 'refresh-167' }, account: { id: 167, username: 'admin' } })
    }
    if (url.endsWith('/auth/me')) {
      const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
      if (!authorization.startsWith('Bearer access-')) return json(401, { message: '会话失效' })
      const id = authorization.replace('Bearer access-', '')
      return json(200, { account: { id, username: 'admin' } })
    }
    if (url.endsWith('/auth/logout')) return json(200, { ok: true })
    return json(404, { message: 'not stubbed' })
  }
}

/** 起一个被测服务。 */
interface Harness {
  readonly service: AdminService
  readonly dataDir: string
  readonly dshHome: string
  readonly webRoot: string
  readonly base: string
  readonly server: Server
  readonly close: () => Promise<void>
}

const started: Harness[] = []

async function startHarness(options: {
  /** 白名单里预置的来源段；默认放行测试用的两个文档网段（TEST-NET-3 / TEST-NET-2）。 */
  readonly allowIps?: readonly string[]
  readonly enableWhitelist?: (service: AdminService) => Promise<void>
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'admin-console-e2e-'))
  const dataDir = join(root, 'data')
  const dshHome = join(root, 'dsh')
  const webRoot = join(root, 'web')
  await mkdir(dataDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(webRoot, { recursive: true })
  const config: AdminConfig = {
    dataDir,
    webRoot,
    origin: 'https://admin.test',
    accountBaseUrl: 'https://accounts.test',
    dshHome,
    tiersPath: fileURLToPath(new URL('../../model-gateway/src/tiers.ts', import.meta.url)),
    trustProxy: true,
    fetch: stubUpstream(),
  }
  const service = createAdminService(config)
  if (options.enableWhitelist !== undefined) {
    await options.enableWhitelist(service)
  } else {
    // 绝大多数用例关心的是"进门之后"的行为，所以默认把测试网段放进白名单；
    // 关心白名单本身的用例显式传 allowIps（空数组 = 默认拒绝一切）。
    const allowIps = options.allowIps ?? ['203.0.113.0/24', '198.51.100.0/24']
    await service.components.whitelist.save({
      version: 1,
      enabled: true,
      entries: allowIps.map(cidr => ({ cidr, note: '测试来源', addedBy: 'test', addedAt: 0 })),
    })
  }
  const server = createServer((request, response) => { void service.handle(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const port = (server.address() as AddressInfo).port
  const harness: Harness = {
    service,
    dataDir,
    dshHome,
    webRoot,
    base: `http://127.0.0.1:${port}`,
    server,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
  started.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of started.splice(0)) await harness.close()
})

/** 发一次接口请求。 */
async function api(
  harness: Harness,
  path: string,
  options: {
    readonly body?: Record<string, unknown>
    readonly cookie?: string
    readonly ip?: string
    readonly origin?: string | null
  } = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown>; readonly cookie: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.cookie !== undefined) headers['cookie'] = options.cookie
  // 模拟 nginx：socket 永远是回环，真实来源在 X-Real-IP 里。
  if (options.ip !== undefined) headers['x-real-ip'] = options.ip
  if (options.origin !== null) headers['origin'] = options.origin ?? 'https://admin.test'
  const response = await fetch(`${harness.base}${API_PREFIX}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  })
  const text = await response.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { _raw: text }
  }
  return { status: response.status, body: parsed, cookie: response.headers.get('set-cookie') }
}

/** 直接写管理员表（等价于 CLI `admin grant`）。 */
async function grantAdmin(harness: Harness, accountId: string, roleId: string, scope: 'all' | 'self' = 'all'): Promise<void> {
  const file = await harness.service.components.admins.load()
  const record: AdminRecord = {
    accountId,
    displayName: `账号 ${accountId}`,
    roleId,
    scope,
    enabled: true,
    createdAt: 0,
    createdBy: 'test',
  }
  await harness.service.components.admins.save({
    version: 1,
    admins: [...file.admins.filter(admin => admin.accountId !== accountId), record],
  })
}

/** 直接写自定义角色表。 */
async function putRoles(harness: Harness, roles: readonly RoleRecord[]): Promise<void> {
  await harness.service.components.roles.save({ version: 1, roles })
}

/** 登录并返回 cookie。 */
async function login(harness: Harness, username = 'admin', password = '正确口令', ip = '203.0.113.7'): Promise<string> {
  const result = await api(harness, '/session/login', { body: { username, password }, ip })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return (result.cookie ?? '').split(';')[0] ?? ''
}

/** 造一份账本快照（形状与模型网关一致）。 */
async function writeLedger(harness: Harness): Promise<void> {
  await writeFile(join(harness.dshHome, '.qianshou-ledger.json'), JSON.stringify({
    version: 1,
    savedAt: 1_700_000_000_000,
    grants: [{ accountId: '167', tier: 'plus', microSp: 990_000_000, periodStart: 1 }],
    partialCharges: [],
    reservations: [{ callId: 'r1', accountId: '167', tier: 'plus', microSp: 2_000_000, at: 1 }],
    records: [{
      callId: 'c1', accountId: '167', tier: 'plus', publishedName: '千手·迅捷', backendKey: 'deepseek',
      at: 1_700_000_000_000, inputTokens: 100, outputTokens: 50, microSp: 1_000_000,
    }],
  }), { mode: 0o600 })
}

describe('文件层面的改动对运行中的进程立刻生效（逃生路径的生命线）', () => {
  it('用 CLI（另一个进程）加白名单后，不需要重启服务就放行', async () => {
    const harness = await startHarness({ allowIps: [] })
    expect((await api(harness, '/health', { ip: '203.0.113.7' })).status).toBe(403)
    // **只写文件，不碰内存**：这才是"另一个进程（CLI）改了配置"的真实形态。
    await writeFile(join(harness.dataDir, 'whitelist.json'), JSON.stringify({
      version: 1,
      enabled: true,
      entries: [{ cidr: '203.0.113.7/32', note: '紧急放行', addedBy: 'cli', addedAt: 0 }],
    }), { mode: 0o600 })
    const allowed = await api(harness, '/health', { ip: '203.0.113.7' })
    expect(allowed.status).toBe(200)
  })
})

describe('第一道门：IP 白名单（默认拒绝 + 逃生路径）', () => {
  it('不在白名单的来源连接口都进不去（403 ip_not_allowed），并且被审计', async () => {
    const harness = await startHarness({ allowIps: [] })
    const denied = await api(harness, '/health', { ip: '203.0.113.7' })
    expect(denied.status).toBe(403)
    expect(denied.body['code']).toBe('ip_not_allowed')

    const audit = await harness.service.components.audit.query({})
    expect(audit.entries.some(entry => entry.action === 'access.whitelist.reject' && entry.ip === '203.0.113.7')).toBe(true)
  })

  it('白名单为空时本机回环仍然可以访问（逃生路径：SSH 里就能把自己加回来）', async () => {
    const harness = await startHarness({ allowIps: [] })
    const ok = await api(harness, '/health')
    expect(ok.status).toBe(200)
    expect(ok.body['service']).toBe('qianshou-admin-console')
  })

  it('把来源加进白名单之后就放行了', async () => {
    const harness = await startHarness({
      enableWhitelist: async (service) => {
        await service.components.whitelist.save({
          version: 1,
          enabled: true,
          entries: [{ cidr: '203.0.113.0/24', note: '办公出口', addedBy: 'cli', addedAt: 0 }],
        })
      },
    })
    expect((await api(harness, '/health', { ip: '203.0.113.7' })).status).toBe(200)
    expect((await api(harness, '/health', { ip: '198.51.100.7' })).status).toBe(403)
  })

  it('白名单只管门：进了门没有会话照样 401', async () => {
    const harness = await startHarness({
      enableWhitelist: async (service) => {
        await service.components.whitelist.save({ version: 1, enabled: true, entries: [{ cidr: '203.0.113.7/32', note: '', addedBy: 'cli', addedAt: 0 }] })
      },
    })
    const result = await api(harness, '/session/me', { ip: '203.0.113.7' })
    expect(result.status).toBe(401)
    expect(result.body['code']).toBe('unauthenticated')
  })

  it('删掉正在放行自己的那条规则会被拒绝（防止把自己锁在门外）', async () => {
    const harness = await startHarness({
      enableWhitelist: async (service) => {
        await service.components.whitelist.save({ version: 1, enabled: true, entries: [{ cidr: '203.0.113.0/24', note: '', addedBy: 'cli', addedAt: 0 }] })
      },
    })
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness, 'admin', '正确口令', '203.0.113.7')
    const preflight = await api(harness, '/whitelist/entries/preflight', {
      body: { op: 'remove', cidr: '203.0.113.0/24' }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status).toBe(409)
    expect(String(preflight.body['message'])).toContain('锁在外面')
  })

  it('从回环地址操作时允许删除（逃生路径是唯一能自救的地方）', async () => {
    const harness = await startHarness({
      enableWhitelist: async (service) => {
        await service.components.whitelist.save({ version: 1, enabled: true, entries: [{ cidr: '203.0.113.0/24', note: '', addedBy: 'cli', addedAt: 0 }] })
      },
    })
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness, 'admin', '正确口令')
    const preflight = await api(harness, '/whitelist/entries/preflight', { body: { op: 'remove', cidr: '203.0.113.0/24' }, cookie })
    expect(preflight.status).toBe(200)
  })
})

describe('登录与身份：三种失败必须分开', () => {
  it('口令错 → 401 invalid_credentials', async () => {
    const harness = await startHarness()
    const result = await api(harness, '/session/login', { body: { username: 'admin', password: '错误口令' } })
    expect(result.status).toBe(401)
    expect(result.body['code']).toBe('invalid_credentials')
  })

  it('账号对但不是管理员 → 403 not_an_admin，且**必须留痕**', async () => {
    const harness = await startHarness()
    const result = await api(harness, '/session/login', { body: { username: 'nobody', password: '正确口令' } })
    expect(result.status).toBe(403)
    expect(result.body['code']).toBe('not_an_admin')
    const audit = await harness.service.components.audit.query({ result: 'deny' })
    expect(audit.entries.some(entry => entry.actorId === '999' && entry.reason === 'not_an_admin')).toBe(true)
  })

  it('授权之后登录成功，cookie 带 HttpOnly/Secure/SameSite=Strict', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const result = await api(harness, '/session/login', { body: { username: 'admin', password: '正确口令' } })
    expect(result.status).toBe(200)
    expect(result.body['twoFactor']).toBe(false)
    expect(result.cookie ?? '').toContain('HttpOnly')
    expect(result.cookie ?? '').toContain('Secure')
    expect(result.cookie ?? '').toContain('SameSite=Strict')
  })

  it('同一来源连续失败 10 次后被限流（429），不再继续打上游', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await api(harness, '/session/login', { body: { username: 'admin', password: '错误口令' }, ip: '203.0.113.7' })
      expect(failed.status, `第 ${attempt + 1} 次`).toBe(401)
    }
    const throttled = await api(harness, '/session/login', { body: { username: 'admin', password: '错误口令' }, ip: '203.0.113.7' })
    expect(throttled.status).toBe(429)
    expect(throttled.body['code']).toBe('rate_limited')
    // 换一个来源不受影响（限流按来源，不是全局）。
    expect((await api(harness, '/session/login', { body: { username: 'admin', password: '错误口令' }, ip: '198.51.100.9' })).status).toBe(401)
  })

  it('两步验证走第二步（challenge → totp）', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const first = await api(harness, '/session/login', { body: { username: 'admin', password: '需要两步验证' } })
    expect(first.status).toBe(200)
    expect(first.body['twoFactor']).toBe(true)
    const challenge = (first.body['challenge'] as Record<string, unknown>)['challengeToken']
    const second = await api(harness, '/session/login-totp', { body: { challengeToken: challenge, code: '123456' } })
    expect(second.status).toBe(200)
    expect(second.cookie ?? '').toContain('qianshou_admin_sid=')
  })

  it('会话可以取到自己的身份、菜单与就绪度', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'support', 'self')
    const cookie = await login(harness)
    const me = await api(harness, '/session/me', { cookie })
    expect(me.status).toBe(200)
    const admin = me.body['admin'] as Record<string, unknown>
    expect(admin['accountId']).toBe('167')
    expect(admin['roleId']).toBe('support')
    expect(admin['scope']).toBe('self')
    expect(admin['surface']).toBe('ai-admin')
    // 客服看不到权限管理菜单（菜单由服务端过滤）。
    const menuKeys = (me.body['menu'] as readonly { key: string }[]).map(item => item.key)
    expect(menuKeys).not.toContain('rbac')
    expect(menuKeys).toContain('overview')
  })

  it('退出登录后旧 cookie 立刻失效', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    expect((await api(harness, '/session/logout', { cookie })).status).toBe(200)
    const after = await api(harness, '/session/me', { cookie })
    expect(after.status).toBe(401)
  })
})

describe('服务端强制 RBAC（不是前端藏按钮）', () => {
  it('客服调用权限管理接口 → 403，并说明缺哪个权限', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'support')
    const cookie = await login(harness)
    const result = await api(harness, '/rbac/roles/preflight', {
      body: { op: 'create', id: 'tmp', name: '临时', permissions: ['account.read'] }, cookie,
    })
    expect(result.status).toBe(403)
    expect(result.body['code']).toBe('forbidden')
    expect(result.body['need']).toBe('rbac.manage')
    // 越权尝试必须留痕。
    const audit = await harness.service.components.audit.query({ actionPrefix: 'access.denied' })
    expect(audit.total).toBeGreaterThan(0)
  })

  it('撤权后旧会话立刻失效（按账号吊销）', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    expect((await api(harness, '/session/me', { cookie })).status).toBe(200)
    // 模拟"另一个管理员把他撤了"：直接改授权表并吊销会话。
    await harness.service.components.admins.save({ version: 1, admins: [] })
    const after = await api(harness, '/session/me', { cookie })
    expect(after.status).toBe(403)
    expect(after.body['code']).toBe('not_an_admin')
  })

  it('角色权限是每次请求现算的：改了权限不用重新登录就生效', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'support')
    const cookie = await login(harness)
    expect((await api(harness, '/rbac/roles/list', { cookie })).status).toBe(403)
    await putRoles(harness, [{
      id: 'custom-audit', name: '自定义审计', kind: 'custom', surface: 'ai-admin', description: '',
      permissions: ['rbac.read', 'audit.read'], scopeDefault: 'all',
    }])
    await harness.service.components.admins.save({
      version: 1,
      admins: [{ accountId: '167', displayName: '账号 167', roleId: 'custom-audit', scope: 'all', enabled: true, createdAt: 0, createdBy: 'test' }],
    })
    expect((await api(harness, '/rbac/roles/list', { cookie })).status).toBe(200)
  })

  it('算力台面的角色在读取时就被丢弃，不能被授予（两套角色表分开）', async () => {
    const harness = await startHarness()
    // 直接往磁盘里塞一个 compute 面的角色，模拟"有人手工把算力台角色拷过来"。
    await mkdir(harness.dataDir, { recursive: true })
    await writeFile(join(harness.dataDir, 'roles.json'), JSON.stringify({
      version: 1,
      roles: [{
        id: 'eco-ops', name: '算力运营', kind: 'custom', surface: 'compute', description: '',
        permissions: ['account.read'], scopeDefault: 'all',
      }],
    }), { mode: 0o600 })

    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const list = await api(harness, '/rbac/roles/list', { cookie })
    expect(list.status).toBe(200)
    const ids = (list.body['roles'] as readonly { id: string }[]).map(role => role.id)
    expect(ids).not.toContain('eco-ops')

    const grant = await api(harness, '/rbac/admins/preflight', {
      body: { op: 'grant', accountId: '200', roleId: 'eco-ops' }, cookie,
    })
    // 读取时就丢弃 → 这里表现为"角色不存在"；无论哪条路径，结果都不是被授予。
    expect(grant.status).toBe(400)
    expect(String(grant.body['message'])).toContain('角色')
    const admins = await harness.service.components.admins.load()
    expect(admins.admins.some(admin => admin.accountId === '200')).toBe(false)
  })
})

describe('高危操作：两步确认 + 改前值→改后值', () => {
  it('不带令牌直接 apply → 409 confirm_required', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const result = await api(harness, '/rbac/roles/apply', {
      body: { op: 'create', id: 'tmp', name: '临时', permissions: ['account.read'], reason: '测试创建' }, cookie,
    })
    expect(result.status).toBe(409)
    expect(result.body['code']).toBe('confirm_required')
  })

  it('preflight → apply 走通，写入生效且审计里有 before → after', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const preflight = await api(harness, '/rbac/roles/preflight', {
      body: { op: 'create', id: 'tmp-role', name: '临时角色', permissions: ['account.read', 'audit.read'], scopeDefault: 'all' }, cookie,
    })
    expect(preflight.status).toBe(200)
    const confirm = preflight.body['confirm'] as Record<string, unknown>
    expect((confirm['diff'] as Record<string, unknown>)['before']).toBeNull()

    const apply = await api(harness, '/rbac/roles/apply', {
      body: { op: 'create', id: 'tmp-role', name: '临时角色', permissions: ['account.read', 'audit.read'], scopeDefault: 'all', token: confirm['token'], reason: '新同事要查审计' },
      cookie,
    })
    expect(apply.status).toBe(200)
    expect(apply.body['auditId']).toBeTruthy()

    const rolesFile = JSON.parse(await readFile(join(harness.dataDir, 'roles.json'), 'utf8')) as { roles: readonly { id: string }[] }
    expect(rolesFile.roles.map(role => role.id)).toContain('tmp-role')

    const audit = await harness.service.components.audit.query({ actionPrefix: 'rbac.roles.create' })
    expect(audit.total).toBe(1)
    expect(audit.entries[0]?.after).toMatchObject({ id: 'tmp-role' })
  })

  it('预览的是 A、提交的是 B → 409 confirm_mismatch（防"看到的和执行的不是一件事"）', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const preflight = await api(harness, '/flags/preflight', {
      body: { key: 'demo.flag', enabled: true, rolloutPercent: 10 }, cookie,
    })
    expect(preflight.status).toBe(200)
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token']
    const apply = await api(harness, '/flags/apply', {
      body: { key: 'demo.flag', enabled: true, rolloutPercent: 100, token, reason: '偷偷全量' }, cookie,
    })
    expect(apply.status).toBe(409)
    expect(apply.body['code']).toBe('confirm_mismatch')
  })

  it('原因太短会被拒（将来对账的人要知道为什么改）', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const preflight = await api(harness, '/flags/preflight', { body: { key: 'demo.flag', enabled: true }, cookie })
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token']
    const apply = await api(harness, '/flags/apply', {
      body: { key: 'demo.flag', enabled: true, token, reason: 'ok' }, cookie,
    })
    expect(apply.status).toBe(400)
  })

  it('功能开关走通后能读回来', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const preflight = await api(harness, '/flags/preflight', { body: { key: 'demo.flag', title: '演示开关', enabled: true, rolloutPercent: 50 }, cookie })
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token']
    const apply = await api(harness, '/flags/apply', {
      body: { key: 'demo.flag', title: '演示开关', enabled: true, rolloutPercent: 50, token, reason: '灰度一半用户' }, cookie,
    })
    expect(apply.status).toBe(200)
    const list = await api(harness, '/flags/list', { cookie })
    expect((list.body['flags'] as readonly { key: string }[])[0]?.key).toBe('demo.flag')
  })
})

describe('数据范围：self 只看自己经办的', () => {
  it('self 范围看不到别人的审计详情', async () => {
    const harness = await startHarness()
    await putRoles(harness, [{
      id: 'self-auditor', name: '自助审计', kind: 'custom', surface: 'ai-admin', description: '',
      permissions: ['audit.read'], scopeDefault: 'self',
    }])
    // 先由另一个管理员产生一条审计（super-admin 登录）。
    await grantAdmin(harness, '200', 'super-admin')
    await login(harness, 'other', '正确口令', '198.51.100.9')
    const otherEntries = await harness.service.components.audit.query({ actorId: '200' })
    const otherId = otherEntries.entries[0]?.id as string
    expect(otherId).toBeTruthy()

    // 再把 167 变成 self 范围的审计员。
    await harness.service.components.admins.save({
      version: 1,
      admins: [{ accountId: '167', displayName: '账号 167', roleId: 'self-auditor', scope: 'self', enabled: true, createdAt: 0, createdBy: 'test' }],
    })
    const cookie = await login(harness, 'admin', '正确口令', '203.0.113.7')
    const detail = await api(harness, '/audit/detail', { body: { id: otherId }, cookie })
    expect(detail.status).toBe(403)
    expect(detail.body['need']).toBe('audit.read')

    const list = await api(harness, '/audit/list', { cookie })
    expect(list.status).toBe(200)
    const entries = list.body['entries'] as readonly { actorId: string }[]
    expect(entries.every(entry => entry.actorId === '167')).toBe(true)
  })
})

describe('六个业务模块：真实可读的读真的，未就绪的如实说', () => {
  it('账号与额度：读真实账本快照（额度、已用、预留、流水）', async () => {
    const harness = await startHarness()
    await writeLedger(harness)
    await grantAdmin(harness, '167', 'finance')
    const cookie = await login(harness)

    const list = await api(harness, '/account/list', { cookie })
    expect(list.status).toBe(200)
    const account = (list.body['accounts'] as readonly Record<string, unknown>[])[0] as Record<string, unknown>
    expect(account['accountId']).toBe('167')
    expect(account['tier']).toBe('plus')
    expect(account['grantedSp']).toBe(990)
    expect(account['usedSp']).toBe(1)
    expect(account['reservedSp']).toBe(2)
    expect(account['remainingSp']).toBe(987)

    const ledger = await api(harness, '/account/ledger', { body: { accountId: '167' }, cookie })
    expect(ledger.status).toBe(200)
    const entry = (ledger.body['entries'] as readonly Record<string, unknown>[])[0] as Record<string, unknown>
    expect(entry['model']).toBe('千手·迅捷')
    expect(entry['sp']).toBe(1)
  })

  it('账号与额度：异常扣费处理如实返回"依赖未就绪"，不假装改了钱', async () => {
    const harness = await startHarness()
    await writeLedger(harness)
    await grantAdmin(harness, '167', 'finance')
    const cookie = await login(harness)
    const result = await api(harness, '/account/adjustment/preflight', {
      body: { accountId: '167', deltaSp: 10, reason: '补偿' }, cookie,
    })
    expect(result.status).toBe(503)
    expect(result.body['code']).toBe('dependency_unavailable')
    expect((result.body['missing'] as readonly unknown[]).length).toBeGreaterThan(0)
  })

  it('订阅与档位：读真实订阅快照与档位目录（目录来自模型网关的 tiers.ts）', async () => {
    const harness = await startHarness()
    await writeFile(join(harness.dshHome, '.qianshou-subscriptions.json'), JSON.stringify({
      version: 1,
      savedAt: 1,
      subscriptions: [{ accountId: '167', tier: 'plus', from: 1, to: null, grantedBy: 'cli', reason: '内部账号' }],
    }), { mode: 0o600 })
    await grantAdmin(harness, '167', 'finance')
    const cookie = await login(harness)

    const list = await api(harness, '/subscription/list', { cookie })
    expect(list.status).toBe(200)
    expect((list.body['entries'] as readonly { accountId: string }[])[0]?.accountId).toBe('167')

    const tiers = await api(harness, '/subscription/tiers', { cookie })
    expect(tiers.status).toBe(200)
    expect(tiers.body['available']).toBe(true)
    const ids = (tiers.body['tiers'] as readonly { id: string }[]).map(tier => tier.id)
    expect(ids).toContain('plus')
  })

  it('开通订阅（写）也如实返回依赖未就绪', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'finance')
    const cookie = await login(harness)
    const result = await api(harness, '/subscription/manage/preflight', { body: { accountId: '167', tier: 'max' }, cookie })
    expect(result.status).toBe(503)
    expect(result.body['module']).toBe('subscription')
  })

  it('市场 / 发现页 / 订单：占位模块返回 503 且列出缺哪些接口', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    for (const path of ['/market/overview', '/discovery/overview', '/order/overview', '/models/overview']) {
      const result = await api(harness, path, { cookie })
      expect(result.status, path).toBe(503)
      expect(result.body['code']).toBe('dependency_unavailable')
      const missing = result.body['missing'] as readonly { interface: string; owner: string }[]
      expect(missing.length, path).toBeGreaterThan(0)
      expect(missing[0]?.interface.length).toBeGreaterThan(0)
      expect(missing[0]?.owner.length).toBeGreaterThan(0)
    }
  })

  it('占位模块同样先过权限：没有 market.read 的人是 403，不是"依赖未就绪"的 503', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'auditor')
    const cookie = await login(harness)
    const forbidden = await api(harness, '/market/overview', { cookie })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body['need']).toBe('market.read')
    const modelsForbidden = await api(harness, '/models/overview', { cookie })
    expect(modelsForbidden.status).toBe(403)
    expect(modelsForbidden.body['need']).toBe('models.read')
    // 有权限但依赖未就绪才是 503（对照）。
    await harness.service.components.admins.save({
      version: 1,
      admins: [{ accountId: '167', displayName: '账号 167', roleId: 'ops', scope: 'all', enabled: true, createdAt: 0, createdBy: 'test' }],
    })
    expect((await api(harness, '/market/overview', { cookie })).status).toBe(503)
  })

  it('异常扣费同样是"先权限、后依赖"：没有权限的人拿不到 503 里的接口清单', async () => {
    const harness = await startHarness()
    await writeLedger(harness)
    await grantAdmin(harness, '167', 'ops')
    const cookie = await login(harness)
    const forbidden = await api(harness, '/account/adjustment/preflight', { body: { accountId: '167', deltaSp: 10 }, cookie })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body['need']).toBe('account.charge.adjust')
  })

  it('就绪度接口把六个模块的状态说清楚', async () => {
    const harness = await startHarness()
    await grantAdmin(harness, '167', 'super-admin')
    const cookie = await login(harness)
    const result = await api(harness, '/modules', { cookie })
    expect(result.status).toBe(200)
    const modules = result.body['modules'] as readonly { key: string; status: string; missing: readonly unknown[] }[]
    const byKey = new Map(modules.map(module => [module.key, module]))
    expect(byKey.get('rbac')?.status).toBe('ready')
    expect(byKey.get('audit')?.status).toBe('ready')
    expect(byKey.get('whitelist')?.status).toBe('ready')
    expect(byKey.get('account')?.status).toBe('read-only')
    expect(byKey.get('market')?.status).toBe('dependency-unavailable')
    expect(byKey.get('discovery')?.status).toBe('dependency-unavailable')
    expect(byKey.get('order')?.status).toBe('dependency-unavailable')
    expect(byKey.get('models')?.status).toBe('dependency-unavailable')
    const modelsMissing = byKey.get('models')?.missing as readonly { interface: string }[] | undefined
    expect(modelsMissing?.some(item => item.interface.includes('/admin/names'))).toBe(true)
  })
})

describe('其他边界', () => {
  it('跨站请求被拒（SameSite 之外的第二道）', async () => {
    const harness = await startHarness()
    const result = await api(harness, '/health', { origin: 'https://evil.example' })
    expect(result.status).toBe(403)
    const audit = await harness.service.components.audit.query({ actionPrefix: 'access.origin.reject' })
    expect(audit.total).toBe(1)
  })

  it('不存在的接口是 404，非 POST 是 405', async () => {
    const harness = await startHarness()
    expect((await api(harness, '/nope')).status).toBe(404)
    const get = await fetch(`${harness.base}${API_PREFIX}/health`, { method: 'GET' })
    expect(get.status).toBe(405)
  })

  it('前端产物没部署时给出明确的 503 说明，而不是空白页', async () => {
    const harness = await startHarness()
    const response = await fetch(`${harness.base}/`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('前端产物还没部署')
  })

  it('前端产物存在时根路径返回 index.html，SPA 路由也回落到它', async () => {
    const harness = await startHarness()
    await writeFile(join(harness.webRoot, 'index.html'), '<!doctype html><title>管理台</title>')
    const root = await fetch(`${harness.base}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('管理台')
    const spa = await fetch(`${harness.base}/audit`)
    expect(spa.status).toBe(200)
  })
})
