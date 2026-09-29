/**
 * 上游密钥管理接口的**端到端**测试（真 HTTP + 真文件 + 打桩上游）。
 *
 * 这一组用例存在的理由只有一个：把"安全硬要求"变成**能被跑出来的事实**，
 * 而不是文档里的一句话。每一条都对应需求里的一条硬要求：
 *
 * | 硬要求 | 对应用例 |
 * | --- | --- |
 * | 值绝不回显、绝不进日志、绝不进审计 | 「不回显」整组 |
 * | 只有 super-admin 可改（接口层强制） | 「权限」整组 |
 * | 写入前连通性测试失败 → 拒绝写入 | 「连通性」整组 |
 * | 备份 + 原子替换 + 失败回滚 | 「备份与回滚」整组 |
 * | 审计只记指纹 | 「审计」整组 |
 *
 * 上游（账号服务与模型上游）**全部打桩**：测试绝不拿真密钥发请求，
 * 也不把用例成败绑在外部服务的可用性上。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { API_PREFIX, createAdminService, type AdminConfig, type AdminService } from '../src/server.ts'
import { fingerprintOf } from '../src/upstream-keys.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

/** 明显的假密钥 —— 报告与日志里都只会出现这一个形状。 */
const FAKE_GOOD = 'sk-fake-good-for-test-0001'
const FAKE_BAD = 'sk-invalid-for-test'
/** 第二把"有效"的假密钥：用来验证连续两次改动各自留备份。 */
const FAKE_SECOND = 'sk-fake-good-second-0002'

/** 凭据文件的真实形状（值替换成假值）。 */
const CREDENTIALS = [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: fake-browser-session-secret',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-old-fake-value',
  '',
].join('\n')

/** 上游打桩：账号服务按既有约定；模型上游按"密钥对不对"给结论。 */
function stubEverything(): typeof fetch {
  let probeCalls = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    // 账号服务（复用 server.spec.ts 里那套打桩的形状）。
    if (url.endsWith('/auth/login') && method === 'POST') {
      if (body['password'] !== '正确口令') return json(401, { message: '账号或密码不对。' })
      // `other` 映射到 200：用例里用它在**另一个管理员记录**下登录，
      // 这样"非 super-admin"才是真的另一个账号，而不是换个角色名。
      const id = body['username'] === 'other' ? 200 : 167
      return json(200, {
        tokens: { access_token: `access-${id}`, refresh_token: `refresh-${id}` },
        account: { id, username: String(body['username']) },
      })
    }
    if (url.endsWith('/auth/me')) {
      const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
      const id = authorization.replace('Bearer access-', '')
      return json(200, { account: { id, username: 'admin' } })
    }
    if (url.endsWith('/auth/logout')) return json(200, { ok: true })

    // 模型上游的连通性探测。
    if (url.includes('api.deepseek.com')) {
      probeCalls += 1
      const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
      if (authorization === `Bearer ${FAKE_GOOD}` || authorization === `Bearer ${FAKE_SECOND}`) {
        return json(200, { model: 'deepseek-chat', choices: [] })
      }
      return json(401, { error: { message: 'Authentication Fails, Your api key is invalid' } })
    }
    return json(404, { message: 'not stubbed' })
  }) as typeof fetch
}

/** 能查探测次数的打桩（用来证明"失败时根本没走到写入"）。 */
function stubWithProbeCounter(): { readonly fetch: typeof fetch; readonly probeCalls: () => number } {
  let probeCalls = 0
  const base = stubEverything()
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('api.deepseek.com')) probeCalls += 1
    return await base(input, init)
  }) as typeof fetch
  return { fetch: wrapped, probeCalls: () => probeCalls }
}

interface Harness {
  readonly service: AdminService
  readonly dataDir: string
  readonly dshHome: string
  readonly credentialsPath: string
  readonly backupDir: string
  readonly base: string
  readonly server: Server
  readonly close: () => Promise<void>
}

const started: Harness[] = []

async function startHarness(options: { readonly fetch?: typeof fetch } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'admin-credential-e2e-'))
  const dataDir = join(root, 'data')
  const dshHome = join(root, 'dsh')
  const webRoot = join(root, 'web')
  await mkdir(dataDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(webRoot, { recursive: true })
  const credentialsPath = join(dshHome, '.credentials.yaml')
  await writeFile(credentialsPath, CREDENTIALS, { mode: 0o600 })

  const config: AdminConfig = {
    dataDir,
    webRoot,
    origin: 'https://admin.test',
    accountBaseUrl: 'https://accounts.test',
    dshHome,
    tiersPath: fileURLToPath(new URL('../../model-gateway/src/tiers.ts', import.meta.url)),
    trustProxy: true,
    fetch: stubEverything(),
    // 探测走**同一套打桩**，且不真的 sleep。
    probe: { fetch: options.fetch ?? stubEverything(), sleep: async () => { /* 不睡 */ } },
  }
  const service = createAdminService(config)
  // 回环永远放行，所以默认不需要白名单；这里仍显式开一条测试网段以走真实路径。
  await service.components.whitelist.save({
    version: 1,
    enabled: true,
    entries: [{ cidr: '203.0.113.0/24', note: '测试来源', addedBy: 'test', addedAt: 0 }],
  })
  const server = createServer((request, response) => { void service.handle(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const port = (server.address() as AddressInfo).port
  const harness: Harness = {
    service,
    dataDir,
    dshHome,
    credentialsPath,
    backupDir: join(dataDir, 'credential-backups'),
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
  } = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown>; readonly raw: string; readonly cookie: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.cookie !== undefined) headers['cookie'] = options.cookie
  if (options.ip !== undefined) headers['x-real-ip'] = options.ip
  headers['origin'] = 'https://admin.test'
  const response = await fetch(`${harness.base}${API_PREFIX}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  })
  const raw = await response.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = { _raw: raw }
  }
  return { status: response.status, body: parsed, raw, cookie: response.headers.get('set-cookie') }
}

/** 直接写管理员表（等价于 CLI `admin grant`）。 */
async function grantAdmin(harness: Harness, accountId: string, roleId: string): Promise<void> {
  const file = await harness.service.components.admins.load()
  const record: AdminRecord = {
    accountId, displayName: `账号 ${accountId}`, roleId, scope: 'all',
    enabled: true, createdAt: 0, createdBy: 'test',
  }
  await harness.service.components.admins.save({
    version: 1,
    admins: [...file.admins.filter(admin => admin.accountId !== accountId), record],
  })
}

/** 登录并拿 cookie。 */
async function login(harness: Harness, username = 'admin'): Promise<string> {
  const result = await api(harness, '/session/login', { body: { username, password: '正确口令' }, ip: '203.0.113.7' })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return (result.cookie ?? '').split(';')[0] ?? ''
}

/** 建一个 super-admin 会话。 */
async function superAdminSession(harness: Harness): Promise<string> {
  await grantAdmin(harness, '167', 'super-admin')
  return await login(harness)
}

/** 走完两步确认（preflight → apply）。 */
async function applyKey(
  harness: Harness,
  cookie: string,
  value: string,
  ref = 'DEEPSEEK_API_KEY',
): Promise<{ readonly preflight: Awaited<ReturnType<typeof api>>; readonly apply: Awaited<ReturnType<typeof api>> }> {
  const preflight = await api(harness, '/credential/preflight', { body: { ref, value }, cookie, ip: '203.0.113.7' })
  const token = (preflight.body['confirm'] as Record<string, unknown> | undefined)?.['token'] as string | undefined
  const apply = await api(harness, '/credential/apply', {
    body: { ref, value, token: token ?? '', reason: '更换上游密钥（测试）' },
    cookie,
    ip: '203.0.113.7',
  })
  return { preflight, apply }
}

describe('权限：只有 super-admin 能改（接口层强制，不是前端藏按钮）', () => {
  it('非 super-admin 即使被授予了 credential.manage 也不能改（403，且被审计）', async () => {
    const harness = await startHarness()
    // 造一个"有权限键、但不是 super-admin"的角色：这正是要挡住的情形 ——
    // 权限键可以授权给自定义角色，而改上游密钥不该靠加一个勾选就能扩散。
    const role: RoleRecord = {
      id: 'ops-can-manage-credentials',
      name: '运维（含密钥权限）',
      kind: 'custom',
      surface: 'ai-admin',
      description: '有 credential.manage 权限，但**不是** super-admin —— 正是要被挡住的那种角色。',
      scopeDefault: 'all',
      permissions: ['credential.read', 'credential.manage'],
    }
    await harness.service.components.roles.save({ version: 1, roles: [role] })
    await grantAdmin(harness, '200', role.id)
    const cookie = await login(harness, 'other')

    const result = await api(harness, '/credential/apply', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD, token: 'whatever', reason: '尝试' },
      cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(403)
    expect(result.body['code']).toBe('forbidden')
    expect(result.body['need']).toBe('super-admin')
    expect(result.body['message']).toContain('super-admin')

    // 文件一个字节都没变。
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)

    // 越权尝试必须留痕（"有人在敲门"是最有价值的那部分审计）。
    const audit = await harness.service.components.audit.query({ actionPrefix: 'credential.apply' })
    expect(audit.entries.some(entry => entry.result === 'deny' && entry.reason === 'not_super_admin')).toBe(true)
  })

  it('没有 credential.manage 权限的角色被权限层挡住（need 是权限键）', async () => {
    const harness = await startHarness()
    const role: RoleRecord = {
      id: 'ops-readonly', name: '只读运维', kind: 'custom', surface: 'ai-admin',
      description: '只有读权限。',
      scopeDefault: 'all', permissions: ['credential.read'],
    }
    await harness.service.components.roles.save({ version: 1, roles: [role] })
    await grantAdmin(harness, '200', role.id)
    const cookie = await login(harness, 'other')

    const result = await api(harness, '/credential/apply', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD, token: 'x', reason: '尝试' },
      cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(403)
    expect(result.body['need']).toBe('credential.manage')
  })

  it('未登录访问被拒（接口不是"公开"的）', async () => {
    const harness = await startHarness()
    const result = await api(harness, '/credential/list', { ip: '203.0.113.7' })
    expect(result.status).toBe(401)
  })

  it('super-admin 能读列表；列表里出现新权限模块与两个权限键', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const result = await api(harness, '/credential/list', { cookie, ip: '203.0.113.7' })
    expect(result.status).toBe(200)
    expect(result.body['ok']).toBe(true)
    const keys = result.body['keys'] as readonly Record<string, unknown>[]
    expect(keys.some(key => key['ref'] === 'DEEPSEEK_API_KEY' && key['configured'] === true)).toBe(true)
  })
})

describe('不回显：值在任何响应体、审计、错误正文里都搜不到', () => {
  it('列表只给指纹与元数据，**没有值字段**', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const result = await api(harness, '/credential/list', { cookie, ip: '203.0.113.7' })
    // 文件里真实存在的那把旧值：任何形式的回显都不可接受。
    expect(result.raw).not.toContain('sk-old-fake-value')
    const keys = result.body['keys'] as readonly Record<string, unknown>[]
    const deepseek = keys.find(key => key['ref'] === 'DEEPSEEK_API_KEY') as Record<string, unknown>
    expect(deepseek['fingerprint']).toBe(fingerprintOf('sk-old-fake-value'))
    expect(deepseek['configured']).toBe(true)
    // 键集合里根本不该有 value/fingerprint 之外能装明文的东西。
    expect(Object.keys(deepseek).sort()).toEqual([
      'configured', 'fingerprint', 'previousFingerprint', 'ref', 'restartCommand',
      'restartRequired', 'restartService', 'shadowedByEnvironment', 'updatedAt', 'updatedBy',
    ])
  })

  it('preflight 的预览只含指纹，**不含提交上来的明文**', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const preflight = await api(harness, '/credential/preflight', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status).toBe(200)
    expect(preflight.raw).not.toContain(FAKE_GOOD)
    const diff = preflight.body['confirm'] as Record<string, unknown>
    const after = diff['diff'] as Record<string, unknown>
    expect((after['after'] as Record<string, unknown>)['fingerprint']).toBe(fingerprintOf(FAKE_GOOD))
  })

  it('apply 成功后响应里只有指纹，**没有明文**', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_GOOD)
    expect(apply.status).toBe(200)
    expect(apply.raw).not.toContain(FAKE_GOOD)
    const result = apply.body['result'] as Record<string, unknown>
    expect(result['fingerprint']).toBe(fingerprintOf(FAKE_GOOD))
    expect(result['previousFingerprint']).toBe(fingerprintOf('sk-old-fake-value'))
  })

  it('审计里只有指纹，**搜不到明文**（明文进审计等于把密钥抄了一份）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await applyKey(harness, cookie, FAKE_GOOD)

    const auditFile = await readFile(join(harness.dataDir, 'audit.jsonl'), 'utf8')
    expect(auditFile).not.toContain(FAKE_GOOD)
    expect(auditFile).not.toContain('sk-old-fake-value')
    // 指纹要在（否则审计说明不了"改成了什么"）。
    expect(auditFile).toContain(fingerprintOf(FAKE_GOOD))
    expect(auditFile).toContain(fingerprintOf('sk-old-fake-value'))

    const audit = await harness.service.components.audit.query({ actionPrefix: 'credential.apply' })
    const allowed = audit.entries.find(entry => entry.result === 'allow')
    expect(allowed).toBeDefined()
    expect(JSON.stringify(allowed)).not.toContain(FAKE_GOOD)
  })

  it('连通性失败时返回的正文里也不含提交的明文', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_BAD)
    expect(apply.status).toBe(400)
    expect(apply.raw).not.toContain(FAKE_BAD)
    expect(apply.body['written']).toBe(false)
  })

  it('明文不落进管理台的任何数据文件（元数据只存指纹）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await applyKey(harness, cookie, FAKE_GOOD)

    for (const name of await readdir(harness.dataDir)) {
      const info = await stat(join(harness.dataDir, name))
      if (!info.isFile()) continue
      const content = await readFile(join(harness.dataDir, name), 'utf8').catch(() => '')
      expect(content, `数据文件 ${name} 里不该出现明文密钥`).not.toContain(FAKE_GOOD)
    }
    // 元数据文件里应当只有指纹 + 谁改的。
    const meta = JSON.parse(await readFile(join(harness.dataDir, 'upstream-key-meta.json'), 'utf8')) as {
      keys: Record<string, { fingerprint: string; updatedBy: string }>
    }
    expect(meta.keys['DEEPSEEK_API_KEY']?.fingerprint).toBe(fingerprintOf(FAKE_GOOD))
    expect(meta.keys['DEEPSEEK_API_KEY']?.updatedBy).toBe('167')
  })
})

describe('连通性：写入前真打一次上游，失败不写入', () => {
  it('密钥无效（上游 401）→ 拒绝写入，文件逐字节不变，并返回明确原因', async () => {
    const counters = stubWithProbeCounter()
    const harness = await startHarness({ fetch: counters.fetch })
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_BAD)

    expect(apply.status).toBe(400)
    expect(apply.body['code']).toBe('credential_rejected')
    expect(apply.body['probeKind']).toBe('credential_rejected')
    expect(apply.body['written']).toBe(false)
    // 真的打了上游（否则"失败不写入"就无从谈起）。
    expect(counters.probeCalls()).toBeGreaterThan(0)
    // 文件一个字节都没变。
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    // 也没有留下备份（拒绝发生在动盘之前）。
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
  })

  it('上游 5xx → 不回"密钥无效"，而是"无法确认"（分类不能误导管理员）', async () => {
    const upstreamDown = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.deepseek.com')) return new Response('upstream boom', { status: 503 })
      return await stubEverything()(input, init)
    }) as typeof fetch
    const harness = await startHarness({ fetch: upstreamDown })
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_GOOD)
    expect(apply.status).toBe(502)
    expect(apply.body['code']).toBe('upstream_unavailable')
    expect(String(apply.body['message'])).toMatch(/不能证明/)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('连通性失败也会留审计（拒绝也是一种结果，必须可追溯）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await applyKey(harness, cookie, FAKE_BAD)
    const audit = await harness.service.components.audit.query({ actionPrefix: 'credential.apply' })
    const denied = audit.entries.find(entry => entry.result === 'deny')
    expect(denied).toBeDefined()
    expect(denied?.summary).toContain('连通性测试未通过')
    expect(denied?.reason).toBe('credential_rejected')
  })
})

describe('备份与回滚：改之前留回滚点，改之后可还原', () => {
  it('成功写入后留下备份，备份内容是**改之前**的完整文档', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_GOOD)
    expect(apply.status).toBe(200)
    const result = apply.body['result'] as Record<string, unknown>
    const backupPath = result['backupPath'] as string
    expect(backupPath).toContain('credential-backups')
    // 备份里是旧内容（回滚点），而不是新内容。
    expect(await readFile(backupPath, 'utf8')).toBe(CREDENTIALS)
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600)
    // 落盘的是新值，且 records 段没被动过。
    const after = await readFile(harness.credentialsPath, 'utf8')
    expect(after).toContain(`DEEPSEEK_API_KEY: ${FAKE_GOOD}`)
    expect(after).toContain('      secret: fake-browser-session-secret')
    expect((await stat(harness.credentialsPath)).mode & 0o777).toBe(0o600)
  })

  it('用备份回滚能把文件还原成改动之前的样子（回滚路径真的可用）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await applyKey(harness, cookie, FAKE_GOOD)
    const backupPath = (apply.body['result'] as Record<string, unknown>)['backupPath'] as string
    expect(await readFile(harness.credentialsPath, 'utf8')).not.toBe(CREDENTIALS)

    // 运维的还原动作就是"把备份拷回去"（管理台不提供自动回滚接口，
    // 因为回滚也要经过连通性判断，不该是一条悄悄改密钥的旁路）。
    await writeFile(harness.credentialsPath, await readFile(backupPath, 'utf8'), { mode: 0o600 })
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('两次改动各自留备份，互不覆盖（时间戳命名）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await applyKey(harness, cookie, FAKE_GOOD)
    await applyKey(harness, cookie, FAKE_SECOND)
    // 两次改动必须留下**两份各自独立**的回滚点：时间戳只到秒，同一秒里改两次
    // 会撞名，撞名时必须追加序号而不是覆盖（覆盖掉的那份正好是回滚点）。
    const backups = (await readdir(harness.backupDir)).filter(name => name.includes('.bak'))
    expect(backups.length).toBeGreaterThanOrEqual(2)
    // 两份备份内容不同（第一份是最初的，第二份是第一次改完的）。
    const contents = await Promise.all(backups.map(async name => await readFile(join(harness.backupDir, name), 'utf8')))
    expect(new Set(contents).size).toBe(2)
  })

  it('文档结构不可接受时拒绝写入并说明原因（宁可不改，也不写坏工作台）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    // 直接塞一份凭据体系会拒绝的文档（未知顶层键）。
    await writeFile(harness.credentialsPath, `${CREDENTIALS}unknown_section: 1\n`, { mode: 0o600 })
    const { preflight, apply } = await applyKey(harness, cookie, FAKE_GOOD)
    expect(preflight.status).toBe(200) // 预览只算差异，不动盘
    expect(apply.status).toBe(500)
    expect(String(apply.body['message'])).toContain('顶层键')
    expect(apply.body['written']).toBe(false)
    // 文件仍是"带未知键"的原样（我们既没修它，也没写坏它）。
    expect(await readFile(harness.credentialsPath, 'utf8')).toContain('unknown_section: 1')
  })
})

describe('两步确认：跳过确认或载荷不符一律拒绝', () => {
  it('缺少令牌 → 409 confirm_required，且不写文件', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const result = await api(harness, '/credential/apply', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD, reason: '想直接改' }, cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(409)
    expect(result.body['code']).toBe('confirm_required')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('令牌与载荷不符（预览的是 A、提交的是 B）→ 拒绝', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const preflight = await api(harness, '/credential/preflight', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD }, cookie, ip: '203.0.113.7',
    })
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token'] as string
    const apply = await api(harness, '/credential/apply', {
      body: { ref: 'DEEPSEEK_API_KEY', value: 'sk-fake-swapped-value', token, reason: '换了内容' },
      cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(409)
    expect(apply.body['code']).toBe('confirm_mismatch')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('原因太短 → 400（将来对账的人要知道为什么改）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const preflight = await api(harness, '/credential/preflight', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD }, cookie, ip: '203.0.113.7',
    })
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token'] as string
    const apply = await api(harness, '/credential/apply', {
      body: { ref: 'DEEPSEEK_API_KEY', value: FAKE_GOOD, token, reason: '改' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(400)
    expect(String(apply.body['message'])).toContain('原因')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })
})

describe('生效机制如实暴露：必须重启才是真的生效', () => {
  it('列表与写入结果都带 restartRequired 与重启命令', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const list = await api(harness, '/credential/list', { cookie, ip: '203.0.113.7' })
    const activation = list.body['activation'] as Record<string, unknown>
    expect(activation['restartRequired']).toBe(true)
    expect(activation['restartCommand']).toBe('systemctl restart qianshou-workbench')
    expect(String(activation['note'])).toContain('必须重启')

    const { apply } = await applyKey(harness, cookie, FAKE_GOOD)
    const result = apply.body['result'] as Record<string, unknown>
    expect(result['restartRequired']).toBe(true)
    expect(result['restartCommand']).toBe('systemctl restart qianshou-workbench')
  })
})

describe('写出来的文档，凭据体系自己的解析器必须读得懂（防止写坏工作台）', () => {
  it('改完之后文件能被真正的 parseCredentialsDocument 接受，且值正确', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await applyKey(harness, cookie, FAKE_GOOD)

    const module_ = await import(
      pathToFileURL(join(process.cwd(), 'packages/credentials/credentials-local/src/index.ts')).href,
    ) as { parseCredentialsDocument: (text: string, filename: string) => { refs: Map<string, string>; records: Map<string, unknown> } }
    const parsed = module_.parseCredentialsDocument(await readFile(harness.credentialsPath, 'utf8'), harness.credentialsPath)
    expect(parsed.refs.get('DEEPSEEK_API_KEY')).toBe(FAKE_GOOD)
    // records 段（登录会话）也必须还在。
    expect(parsed.records.size).toBe(1)
  })
})
