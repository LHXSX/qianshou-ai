/**
 * 上游号池接口的**端到端**测试（真 HTTP + 真文件 + 打桩 Cursor 上游）。
 *
 * 这组用例存在的理由与 `credential-routes.spec.ts` 一样：把"安全硬要求"变成
 * **能被跑出来的事实**。每一组对应需求里的一条硬要求：
 *
 * | 硬要求 | 对应用例 |
 * | --- | --- |
 * | 三种形态都要支持（含 `%3A%3A` 与 `::`） | 「形态识别」整组 |
 * | **剥包装**：整串发出去实测 401，只发 JWT 才是 200 | 「剥包装」整组（断言**实际发出的 Authorization 头**） |
 * | 写前真实探测，失败不写盘、不留备份 | 「写前探测」整组 |
 * | 探测失败分类照 §8.7 四类表 | 「分类」整组 |
 * | 三条去重判据各自生效 | 「去重」整组 |
 * | 二次确认绑载荷，不一致回 409 | 「两步确认」整组 |
 * | `credential.manage` 且必须 super-admin | 「权限」整组 |
 * | 值永不回显 | 「不回显」整组 |
 * | 复用既有 `valueRejectionReason` / `refRejectionReason` | 「校验复用」整组 |
 *
 * 上游**全部打桩**：测试绝不拿真凭据发请求，也不把用例成败绑在外部服务的可用性上。
 * 桩里刻意实现了"整串带 `::` 就回 401"这条实测事实 —— 否则"剥包装"这件事在测试里
 * 就没有对抗物，写成什么样都能过。
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { API_PREFIX, createAdminService, type AdminConfig, type AdminService } from '../src/server.ts'
import { fingerprintOf, refRejectionReason, valueRejectionReason } from '../src/upstream-keys.ts'
import { probeTargetFor } from '../src/connectivity.ts'
import {
  CURSOR_API_KEY_LENGTH,
  CURSOR_EXCHANGE_API_KEY_PATH,
  identifyCursorCredential,
  isCursorPoolRef,
  poolRefForAuthId,
  type CursorIdentity,
} from '../src/cursor-credential.ts'
import { duplicateBasisLabel, labelRejectionReason, planPoolChange, type PoolExistingEntry } from '../src/pool.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

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

/** 两个假账号：一个号池里已经有的号，和一个新号。 */
const ACCOUNT_A: CursorIdentity = {
  authId: 'auth0|user_aaaa1111',
  userId: 111,
  email: 'pool-a@example.com',
  firstName: '甲',
  lastName: '号',
}
const ACCOUNT_B: CursorIdentity = {
  authId: 'auth0|user_bbbb2222',
  userId: 222,
  email: 'pool-b@example.com',
  firstName: '乙',
  lastName: '号',
}

/** 造一枚**形状合法**的假 JWT（没有真签名，也不需要）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.${'s'.repeat(43)}`
}

const JWT_A = makeJwt({ type: 'session', sub: 'a' })
const JWT_A_SECOND = makeJwt({ type: 'session', sub: 'a-second-session' })
const JWT_A_WEB = makeJwt({ type: 'web', sub: 'a-web' })
const JWT_B = makeJwt({ type: 'session', sub: 'b' })
const JWT_OTHER_TYPE = makeJwt({ type: 'personal', sub: 'x' })

/** 一次被桩记录下来的上游调用。 */
interface UpstreamCall {
  readonly url: string
  readonly path: string
  readonly authorization: string
  readonly body: Record<string, unknown>
}

/** 打桩的上游（账号服务 + Cursor）。 */
function stubUpstream(options: {
  /** 已在池子里的 API key → 账号（模拟"这枚 key 还能用"）。 */
  readonly apiKeys?: ReadonlyMap<string, CursorIdentity>
  /** `GetMe` 强制返回这个状态码（造四类失败）。 */
  readonly getMeStatus?: number
  /** `GetMe` 返回 200 但正文里没有 `authId`。 */
  readonly getMeWithoutAuthId?: boolean
  /** 换票接口强制返回这个状态码（造"key 被拒"）。 */
  readonly exchangeStatus?: number
  /** `CreateUserApiKey` 强制返回这个状态码。 */
  readonly createKeyStatus?: number
  /** 归一化固定回这把 key（造"铸出来的值不合法"这种边界）。 */
  readonly fixedMintedKey?: string
} = {}): {
  readonly fetch: typeof fetch
  readonly calls: readonly UpstreamCall[]
  readonly mintCount: () => number
  /**
   * 让上游在中途翻脸：`GetMe` 从现在起回这个状态码（`undefined` = 恢复正常）。
   *
   * 这个开关是给"预览通过、写入时上游变了"这类用例用的 —— 那才是 **apply 的探测**
   * 真正要挡住的情形（预览时的结论不能当作写入时的许可）。
   */
  readonly failGetMeFromNowOn: (status: number | undefined) => void
} {
  const calls: UpstreamCall[] = []
  const minted = new Map<string, CursorIdentity>(options.apiKeys ?? new Map())
  /** 换来的票 → 账号。票是**一次性、1 小时过期**的，桩里只记"这张票属于谁"。 */
  const tickets = new Map<string, CursorIdentity>()
  const sessions = new Map<string, CursorIdentity>([
    [JWT_A, ACCOUNT_A],
    [JWT_A_SECOND, ACCOUNT_A],
    [JWT_A_WEB, ACCOUNT_A],
    [JWT_B, ACCOUNT_B],
  ])
  let mintCount = 0
  let ticketCount = 0
  let forcedGetMeStatus = options.getMeStatus

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    const authorization = headers['authorization'] ?? ''
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : authorization
    const path = new URL(url).pathname
    calls.push({ url, path, authorization, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} })
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    // 账号服务（与 server.spec.ts 同一套打桩形状）。
    if (path.endsWith('/auth/login')) {
      const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>
      if (body['password'] !== '正确口令') return json(401, { message: '账号或密码不对。' })
      const id = body['username'] === 'other' ? 200 : 167
      return json(200, {
        tokens: { access_token: `access-${id}`, refresh_token: `refresh-${id}` },
        account: { id, username: String(body['username']) },
      })
    }
    if (path.endsWith('/auth/me')) {
      const id = authorization.replace('Bearer access-', '')
      return json(200, { account: { id, username: 'admin' } })
    }
    if (path.endsWith('/auth/logout')) return json(200, { ok: true })

    // Cursor：换票 / GetMe / 归一化。
    //
    // 桩照**实测事实**办事（它就是这组用例的对抗物，写歪了整组就失去意义）：
    //   - `crsr_…` 直接打 GetMe，无论带什么头 → **401**；
    //   - 先在换票接口换票 → 200 `{ accessToken, refreshToken }`（票 1 小时过期）；
    //   - 用票打 GetMe → 200 身份。
    if (path.endsWith(CURSOR_EXCHANGE_API_KEY_PATH)) {
      if (options.exchangeStatus !== undefined) return json(options.exchangeStatus, { error: { message: 'stubbed exchange failure' } })
      const identity = minted.get(bearer)
      if (identity === undefined) return json(401, { error: { message: 'unauthorized (stub): unknown api key' } })
      ticketCount += 1
      const accessToken = `tkt_${String(ticketCount).padStart(4, '0')}_${'t'.repeat(24)}`
      tickets.set(accessToken, identity)
      return json(200, { accessToken, refreshToken: `rtk_${String(ticketCount).padStart(4, '0')}` })
    }
    if (path.endsWith('/GetMe')) {
      if (forcedGetMeStatus !== undefined) return json(forcedGetMeStatus, { error: { message: 'stubbed getMe failure' } })
      if (options.getMeWithoutAuthId === true) return json(200, { userId: 1 })
      // 只认会话 JWT 与换来的票 —— **不认原始 API key**（实测直接打恒 401）；
      // 整串（含 `::`）/ 只有 userId 也都不认。
      const identity = sessions.get(bearer) ?? tickets.get(bearer)
      if (identity === undefined) return json(401, { error: { message: 'unauthorized (stub)' } })
      return json(200, identity)
    }
    if (path.endsWith('/CreateUserApiKey')) {
      if (options.createKeyStatus !== undefined) return json(options.createKeyStatus, { error: { message: 'stubbed createKey failure' } })
      const identity = sessions.get(bearer)
      if (identity === undefined) return json(401, { error: { message: 'unauthorized (stub)' } })
      mintCount += 1
      // 69 字符的 `crsr_…`（与实测的真实长度一致），每次铸一把新的。
      const apiKey = options.fixedMintedKey ?? `crsr_${String(mintCount).padStart(64, '0')}`
      minted.set(apiKey, identity)
      return json(200, { apiKey })
    }
    return json(404, { message: 'not stubbed' })
  })

  return {
    fetch: fetchImpl,
    calls,
    mintCount: () => mintCount,
    failGetMeFromNowOn: (status) => { forcedGetMeStatus = status },
  }
}

interface Harness {
  readonly service: AdminService
  readonly dataDir: string
  readonly dshHome: string
  readonly credentialsPath: string
  readonly backupDir: string
  readonly poolPath: string
  readonly base: string
  readonly server: Server
  readonly calls: readonly UpstreamCall[]
  /** 直接拿打桩的 fetch（用例可以自己打一次，证明桩的判定与真实事实一致）。 */
  readonly stubFetch: typeof fetch
  /** 中途让上游翻脸（测 apply 的写前探测）。 */
  readonly failGetMeFromNowOn: (status: number | undefined) => void
  readonly close: () => Promise<void>
}

const started: Harness[] = []

async function startHarness(options: Parameters<typeof stubUpstream>[0] = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'admin-pool-e2e-'))
  const dataDir = join(root, 'data')
  const dshHome = join(root, 'dsh')
  const webRoot = join(root, 'web')
  await mkdir(dataDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(webRoot, { recursive: true })
  const credentialsPath = join(dshHome, '.credentials.yaml')
  await writeFile(credentialsPath, CREDENTIALS, { mode: 0o600 })

  const stub = stubUpstream(options)
  const config: AdminConfig = {
    dataDir,
    webRoot,
    origin: 'https://admin.test',
    accountBaseUrl: 'https://accounts.test',
    dshHome,
    tiersPath: fileURLToPath(new URL('../../model-gateway/src/tiers.ts', import.meta.url)),
    trustProxy: true,
    fetch: stub.fetch,
    // 号池的验活/归一化与 §8.7 的探测走**同一个**打桩，且不真的 sleep。
    probe: { fetch: stub.fetch, sleep: async () => { /* 不睡 */ } },
  }
  const service = createAdminService(config)
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
    poolPath: join(dataDir, 'pool.json'),
    base: `http://127.0.0.1:${port}`,
    server,
    calls: stub.calls,
    stubFetch: stub.fetch,
    failGetMeFromNowOn: stub.failGetMeFromNowOn,
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

/** 发起 add 的预览，返回 token。 */
async function previewAdd(
  harness: Harness,
  cookie: string,
  credential: string,
  label = '',
): Promise<{ readonly preflight: Awaited<ReturnType<typeof api>>; readonly token: string }> {
  const preflight = await api(harness, '/pool/preflight', {
    body: { credential, label }, cookie, ip: '203.0.113.7',
  })
  const confirm = preflight.body['confirm'] as Record<string, unknown> | undefined
  return { preflight, token: (confirm?.['token'] as string | undefined) ?? '' }
}

/** 走完两步确认把一枚凭据加进号池。 */
async function addCredential(
  harness: Harness,
  cookie: string,
  credential: string,
  label = '',
): Promise<{ readonly preflight: Awaited<ReturnType<typeof api>>; readonly apply: Awaited<ReturnType<typeof api>> }> {
  const { preflight, token } = await previewAdd(harness, cookie, credential, label)
  const apply = await api(harness, '/pool/apply', {
    body: { credential, label, token, reason: '往号池加一个号（测试）' }, cookie, ip: '203.0.113.7',
  })
  return { preflight, apply }
}

/** 读号池元数据文件。 */
async function readPoolMeta(harness: Harness): Promise<{ readonly keys: Readonly<Record<string, Record<string, unknown>>> }> {
  const raw = JSON.parse(await readFile(harness.poolPath, 'utf8')) as { entries: Record<string, Record<string, unknown>> }
  return { keys: raw.entries }
}

describe('形态识别：三种写法都要认，第四种明确拒绝（不猜）', () => {
  it('`crsr_…` → api-key，且原样就是要发给上游的那一份', () => {
    const apiKey = `crsr_${'a'.repeat(64)}`
    const reading = identifyCursorCredential(apiKey)
    expect(reading.shape).toBe('api-key')
    expect(reading.bearer).toBe(apiKey)
    expect(reading.wrapped).toBe(false)
    expect(reading.problem).toBeNull()
  })

  it('裸 JWT（type = session / web）→ session', () => {
    for (const jwt of [JWT_A, JWT_A_WEB]) {
      const reading = identifyCursorCredential(jwt)
      expect(reading.shape).toBe('session')
      expect(reading.bearer).toBe(jwt)
      expect(reading.sessionType).toBe(jwt === JWT_A ? 'session' : 'web')
    }
  })

  it('`userId::jwt` 与 `userId%3A%3Ajwt` 都认，且**只留 JWT**', () => {
    for (const input of [`userId::${JWT_A}`, `userId%3A%3A${JWT_A}`, `userId%3a%3a${JWT_A}`]) {
      const reading = identifyCursorCredential(input)
      expect(reading.shape, input.slice(0, 24)).toBe('session-wrapped')
      expect(reading.wrapped).toBe(true)
      // 这就是"剥包装"：发给上游的绝不能是整串。
      expect(reading.bearer).toBe(JWT_A)
      expect(reading.bearer).not.toContain('::')
      expect(reading.bearer).not.toContain('userId')
    }
  })

  it('粘贴带的首尾空白是噪声，不算凭据的一部分', () => {
    expect(identifyCursorCredential(`  \n${JWT_A}\n  `).bearer).toBe(JWT_A)
  })

  it('JWT 的 type 不是 session / web 时明确拒绝，并把看到的 type 说出来', () => {
    const reading = identifyCursorCredential(JWT_OTHER_TYPE)
    expect(reading.shape).toBe('unknown')
    expect(reading.problem).toContain('personal')
  })

  it('认不出来的串与空串都拒绝，理由可读', () => {
    expect(identifyCursorCredential('随便一串东西').shape).toBe('unknown')
    expect(identifyCursorCredential('   ').shape).toBe('unknown')
    expect(identifyCursorCredential('   ').problem).toContain('没有粘进任何内容')
  })

  it('号池 ref 的命名规则：由 authId 派生、稳定、不含 PII、满足凭据体系的键名严格度', () => {
    const ref = poolRefForAuthId(ACCOUNT_A.authId)
    // 规则就是 `CURSOR_CK_` + `sha256(authId)` 的前 8 位十六进制。
    const expectedDigest = createHash('sha256').update(ACCOUNT_A.authId).digest('hex').slice(0, 8)
    expect(ref).toBe(`CURSOR_CK_${expectedDigest}`)
    expect(isCursorPoolRef(ref)).toBe(true)
    // 同一个账号永远是同一个 ref（这就是"天然去重"）。
    expect(poolRefForAuthId(ACCOUNT_A.authId)).toBe(ref)
    // 不同账号不同 ref。
    expect(poolRefForAuthId(ACCOUNT_B.authId)).not.toBe(ref)
    // 键名严格度**复用既有校验**，不是另写一套。
    expect(refRejectionReason(ref)).toBeNull()
    // 不含 PII：邮箱与 authId 都不出现在 ref 里。
    expect(ref).not.toContain('@')
    expect(ref).not.toContain('auth0')
    // 别的 ref 不会被误认成号池的号（这条判据挡着"从号池里删网关密钥"）。
    expect(isCursorPoolRef('DEEPSEEK_API_KEY')).toBe(false)
    expect(isCursorPoolRef('CURSOR_CK_zzzz')).toBe(false)
  })
})

describe('剥包装：真正发出去的必须是裸 JWT（断言实际发出的 Authorization 头）', () => {
  it('`userId::jwt` 的输入：上游收到的是裸 JWT，且预览通过', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, `userId::${JWT_A}`, '甲号')

    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const cursorCalls = harness.calls.filter(call => call.url.includes('cursor.sh'))
    expect(cursorCalls.length).toBeGreaterThan(0)
    // 认身份（GetMe）打出去的必须是**剥过包装的裸 JWT**。
    expect(cursorCalls.find(call => call.path.endsWith('/GetMe'))?.authorization).toBe(`Bearer ${JWT_A}`)
    // 预览**不铸新 key**：归一化是对 Cursor 账号的持久副作用，只能发生在 apply。
    expect(cursorCalls.some(call => call.path.endsWith('/CreateUserApiKey'))).toBe(false)
    // 上游**一次都没收到**带包装的东西。
    for (const call of cursorCalls) {
      expect(call.authorization).not.toContain('::')
      expect(call.authorization).not.toContain('%3A')
      expect(call.authorization).not.toContain('userId')
    }
    expect(preflight.body['ok']).toBe(true)
  })

  it('`userId%3A%3Ajwt` 的输入：同样只发裸 JWT（百分号编码也要剥）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, `userId%3A%3A${JWT_A}`)

    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const cursorCalls = harness.calls.filter(call => call.url.includes('cursor.sh'))
    expect(cursorCalls.length).toBeGreaterThan(0)
    expect(cursorCalls.find(call => call.path.endsWith('/GetMe'))?.authorization).toBe(`Bearer ${JWT_A}`)
    expect(cursorCalls.some(call => call.authorization.includes('::') || call.authorization.includes('%3A'))).toBe(false)
  })

  it('桩对"整串"回 401、对裸 JWT 回 200（先把对抗物本身钉住）', async () => {
    const harness = await startHarness()
    const probe = async (bearer: string): Promise<number> => {
      const response = await harness.stubFetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: '{}',
      })
      return response.status
    }
    // 这四行就是实测矩阵在测试里的化身：整串 401、`userId::jwt` 401、只发 userId 401、只发 JWT 200。
    expect(await probe(`userId%3A%3A${JWT_A}`)).toBe(401)
    expect(await probe(`userId::${JWT_A}`)).toBe(401)
    expect(await probe('userId')).toBe(401)
    expect(await probe(JWT_A)).toBe(200)
  })

  it('因此走通整条链路本身就证明剥了包装（整串会被上游拒）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, `userId::${JWT_A}`)
    expect(apply.status, JSON.stringify(apply.body)).toBe(200)
    // 第一次 GetMe 打的是裸 JWT；上游全程没收到带包装的东西。
    const cursorCalls = harness.calls.filter(item => item.url.includes('cursor.sh'))
    expect(cursorCalls.find(call => call.path.endsWith('/GetMe'))?.authorization).toBe(`Bearer ${JWT_A}`)
    for (const call of cursorCalls) {
      expect(call.authorization).not.toContain('::')
      expect(call.authorization).not.toContain('userId')
    }
    expect(await readFile(harness.credentialsPath, 'utf8')).not.toContain('userId')
  })
})

describe('API key 形态必须两步：先换票、再用票取身份（实测：直接打 GetMe 恒 401）', () => {
  const apiKeyA = `crsr_${'m'.repeat(64)}`

  it('调用序列：先 POST /auth/exchange_user_api_key，再带**换来的票**打 GetMe', async () => {
    const harness = await startHarness({ apiKeys: new Map([[apiKeyA, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, apiKeyA)

    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const cursorCalls = harness.calls.filter(call => call.url.includes('cursor.sh'))
    // 序列是硬的：换票在前、GetMe 在后，中间不许插别的。
    expect(cursorCalls.map(call => call.path)).toEqual([
      '/auth/exchange_user_api_key',
      '/aiserver.v1.DashboardService/GetMe',
    ])
    // 换票带的是**用户给的 key**；取身份带的是**换来的票**，绝不是原 key。
    expect(cursorCalls[0]?.authorization).toBe(`Bearer ${apiKeyA}`)
    const ticket = String(cursorCalls[1]?.authorization).replace('Bearer ', '')
    expect(ticket.startsWith('tkt_')).toBe(true)
    expect(ticket).not.toBe(apiKeyA)
    expect(cursorCalls[1]?.authorization).not.toContain(apiKeyA)
    // 换票的 body 是空对象（实测就是这个形状）。
    expect(cursorCalls[0]?.body).toEqual({})
    // 预览里"打了哪个接口"要如实写出来，不能只说 GetMe；状态码也要是真的那一个。
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    const probe = diff['probe'] as Record<string, unknown>
    expect(probe['endpoint']).toBe('exchange_user_api_key → GetMe')
    expect(probe['status']).toBe(200)
    expect(typeof probe['latencyMs']).toBe('number')
  })

  it('换来的票**绝不落盘**：文件里只有用户那把长期 key，没有票、也没有票的类型标记', async () => {
    const harness = await startHarness({ apiKeys: new Map([[apiKeyA, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, apiKeyA, '甲号')
    expect(apply.status, JSON.stringify(apply.body)).toBe(200)

    // 找出这次换来的票（桩里的形状固定）。
    const ticket = String(harness.calls.find(call => call.path.endsWith('/GetMe'))?.authorization).replace('Bearer ', '')
    const text = await readFile(harness.credentialsPath, 'utf8')
    // 落盘的就是用户给的那把长期 key —— 票只有 1 小时，落盘等于埋一个"一小时后 401"的雷。
    expect(text).toContain(`${poolRefForAuthId(ACCOUNT_A.authId)}: ${apiKeyA}`)
    expect(text).not.toContain(ticket)
    expect(text).not.toContain('tkt_')
    expect(text).not.toContain('api_key_token')
    expect(text).not.toContain('refreshToken')
    // 管理台的任何数据文件里也不能有票。
    for (const name of await readdir(harness.dataDir)) {
      const info = await stat(join(harness.dataDir, name))
      if (!info.isFile()) continue
      const content = await readFile(join(harness.dataDir, name), 'utf8').catch(() => '')
      expect(content, `数据文件 ${name} 里不该出现 1 小时票`).not.toContain(ticket)
    }
    // 响应与审计里同样只有指纹。
    expect(apply.raw).not.toContain(ticket)
    const auditFile = await readFile(join(harness.dataDir, 'audit.jsonl'), 'utf8')
    expect(auditFile).not.toContain(ticket)
  })

  it('会话形态的完整序列：验活 JWT → 铸 key → 换票 → 用票取身份（落盘值被真验过一次）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    expect(apply.status, JSON.stringify(apply.body)).toBe(200)
    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(await readFile(harness.credentialsPath, 'utf8'))?.[1] as string

    // 只看 apply 这一段（preflight 只做第一步验活）。
    const applyCalls = harness.calls.filter(call => call.url.includes('cursor.sh')).slice(1)
    expect(applyCalls.map(call => call.path)).toEqual([
      '/aiserver.v1.DashboardService/GetMe',
      '/aiserver.v1.DashboardService/CreateUserApiKey',
      '/auth/exchange_user_api_key',
      '/aiserver.v1.DashboardService/GetMe',
    ])
    // 前两步拿的是会话 JWT；后两步是对**将要落盘的那把新 key** 做的两步写前探测。
    expect(applyCalls[0]?.authorization).toBe(`Bearer ${JWT_A}`)
    expect(applyCalls[1]?.authorization).toBe(`Bearer ${JWT_A}`)
    expect(applyCalls[2]?.authorization).toBe(`Bearer ${stored}`)
    expect(String(applyCalls[3]?.authorization).replace('Bearer ', '').startsWith('tkt_')).toBe(true)
  })

  it('API key 形态不做多余的重复探测（落盘值就是刚验过的那一串）', async () => {
    const harness = await startHarness({ apiKeys: new Map([[apiKeyA, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, apiKeyA)
    expect(apply.status).toBe(200)
    // 预览两步 + 执行两步 = 4 次，不能是"再换一张票再取一次身份"的 6 次。
    const cursorCalls = harness.calls.filter(call => call.url.includes('cursor.sh'))
    expect(cursorCalls.length).toBe(4)
    expect(cursorCalls.filter(call => call.path.endsWith(CURSOR_EXCHANGE_API_KEY_PATH)).length).toBe(2)
  })
})

describe('归一化：落盘的是不过期的 `crsr_…`，不是粘贴进来的那一串', () => {
  it('会话凭据加进池子后，文件里是 69 字符的长期 key，JWT 一个字都不落盘', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A, '甲号')

    expect(apply.status, JSON.stringify(apply.body)).toBe(200)
    const result = apply.body['result'] as Record<string, unknown>
    const ref = result['ref'] as string
    expect(ref).toBe(poolRefForAuthId(ACCOUNT_A.authId))

    const text = await readFile(harness.credentialsPath, 'utf8')
    expect(text).toContain(`${ref}: crsr_`)
    // 会话 JWT 会过期，落盘等于埋一个"过几天全线 401"的雷。
    expect(text).not.toContain(JWT_A)
    expect(text).not.toContain('::')
    // 落盘的值长度与实测的 `crsr_…` 一致（69 字符），且是裸标量。
    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(text)?.[1] as string
    expect(stored.length).toBe(CURSOR_API_KEY_LENGTH)
    expect(valueRejectionReason(stored)).toBeNull()
    // 凭据文件权限仍是 0600（写坏权限会让工作台重启后加载不了凭据插件）。
    expect((await stat(harness.credentialsPath)).mode & 0o777).toBe(0o600)
    // 别的内容一个字节都没被动。
    expect(text).toContain('  DEEPSEEK_API_KEY: sk-old-fake-value')
    expect(text).toContain('      secret: fake-browser-session-secret')
  })

  it('贴进来的已经是 `crsr_…` 时不再铸新 key，落盘的就是它本身', async () => {
    const existing = `crsr_${'b'.repeat(64)}`
    const harness = await startHarness({ apiKeys: new Map([[existing, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, existing)

    expect(apply.status, JSON.stringify(apply.body)).toBe(200)
    const text = await readFile(harness.credentialsPath, 'utf8')
    expect(text).toContain(`${poolRefForAuthId(ACCOUNT_A.authId)}: ${existing}`)
  })

  it('写出来的文档，凭据体系自己的解析器必须读得懂（防止写坏工作台）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await addCredential(harness, cookie, JWT_A)

    const module_ = await import(
      pathToFileURL(join(process.cwd(), 'packages/credentials/credentials-local/src/index.ts')).href,
    ) as { parseCredentialsDocument: (text: string, filename: string) => { refs: Map<string, string>; records: Map<string, unknown> } }
    const parsed = module_.parseCredentialsDocument(await readFile(harness.credentialsPath, 'utf8'), harness.credentialsPath)
    expect(parsed.refs.get(poolRefForAuthId(ACCOUNT_A.authId))).toMatch(/^crsr_/)
    // 网关自己的密钥与登录会话都还在（我们只动了自己那一行）。
    expect(parsed.refs.get('DEEPSEEK_API_KEY')).toBe('sk-old-fake-value')
    expect(parsed.records.size).toBe(1)
  })
})

describe('去重：三条判据各自生效（只比对前两条会让同一个号重复入库）', () => {
  const apiKeyA = `crsr_${'c'.repeat(64)}`
  const apiKeyB = `crsr_${'d'.repeat(64)}`
  const existing: readonly PoolExistingEntry[] = [
    { ref: 'CURSOR_CK_11111111', value: apiKeyA, fingerprint: fingerprintOf(apiKeyA), authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, label: '甲号' },
    { ref: 'CURSOR_CK_22222222', value: apiKeyB, fingerprint: fingerprintOf(apiKeyB), authId: ACCOUNT_B.authId, email: ACCOUNT_B.email, label: '乙号' },
  ]

  it('判据三（最硬）：值相同 → duplicate，且不需要任何身份信息就能成立', () => {
    // authId 与 ref 都被刻意改成"认不出来"的样子，只有值是一样的。
    const plan = planPoolChange(
      { ref: 'CURSOR_CK_99999999', value: apiKeyA, authId: 'auth0|someone-else', email: null, label: '' },
      existing,
    )
    expect(plan.action).toBe('duplicate')
    expect(plan.basis).toBe('value')
    expect(plan.existingRef).toBe('CURSOR_CK_11111111')
  })

  it('判据二：ref 名相同、值不同 → replace（同一个账号换了新 key，不是重复入库）', () => {
    const plan = planPoolChange(
      { ref: 'CURSOR_CK_11111111', value: `crsr_${'e'.repeat(64)}`, authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, label: '' },
      existing,
    )
    expect(plan.action).toBe('replace')
    expect(plan.basis).toBe('ref')
    expect(plan.existingRef).toBe('CURSOR_CK_11111111')
    expect(plan.previousFingerprint).toBe(fingerprintOf(apiKeyA))
  })

  it('判据一：ref 与值都不同、只有 authId 相同 → replace（ref 规则变过/历史 ref 被改过时只有它还能认出来）', () => {
    const plan = planPoolChange(
      { ref: 'CURSOR_CK_33333333', value: `crsr_${'f'.repeat(64)}`, authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, label: '' },
      existing,
    )
    expect(plan.action).toBe('replace')
    expect(plan.basis).toBe('auth_id')
    expect(plan.existingRef).toBe('CURSOR_CK_11111111')
  })

  it('三条都不命中才是 add', () => {
    const plan = planPoolChange(
      { ref: 'CURSOR_CK_44444444', value: `crsr_${'g'.repeat(64)}`, authId: 'auth0|user_cccc3333', email: null, label: '' },
      existing,
    )
    expect(plan).toEqual({ action: 'add', basis: null, existingRef: null, previousFingerprint: null })
  })

  it('removed 的条目（只剩元数据）不会因为"值是 null"被当成重复', () => {
    const plan = planPoolChange(
      { ref: 'CURSOR_CK_11111111', value: apiKeyA, authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, label: '' },
      [{ ref: 'CURSOR_CK_11111111', value: null, fingerprint: fingerprintOf(apiKeyA), authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, label: '' }],
    )
    expect(plan.action).toBe('replace')
    expect(plan.basis).toBe('ref')
  })

  it('同一枚 key 贴两次：第二次只回 duplicate，**文件逐字节不变**', async () => {
    const existingKey = `crsr_${'h'.repeat(64)}`
    const harness = await startHarness({ apiKeys: new Map([[existingKey, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const first = await addCredential(harness, cookie, existingKey)
    expect(first.apply.status, JSON.stringify(first.apply.body)).toBe(200)
    const afterFirst = await readFile(harness.credentialsPath, 'utf8')

    const second = await addCredential(harness, cookie, existingKey)
    expect(second.apply.status).toBe(200)
    const result = second.apply.body['result'] as Record<string, unknown>
    expect(result['action']).toBe('duplicate')
    expect(result['written']).toBe(false)
    expect(result['duplicateBasis']).toBe('value')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(afterFirst)

    // 没有第二次写入 → 没有第二份备份。
    const backups = (await readdir(harness.backupDir)).filter(name => name.includes('.bak'))
    expect(backups.length).toBe(1)
    // 但"有人试图重复加号"这件事必须留痕（否则事后看不见）。
    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.add' })
    expect(audit.entries.some(entry => entry.summary.includes('未重复写入'))).toBe(true)
  })

  it('同一个账号换个会话再来一次：ref 相同 → 替换，池子里始终只有一个号', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const first = await addCredential(harness, cookie, JWT_A)
    const second = await addCredential(harness, cookie, JWT_A_SECOND)
    expect(first.apply.status).toBe(200)
    expect(second.apply.status, JSON.stringify(second.apply.body)).toBe(200)
    const firstResult = first.apply.body['result'] as Record<string, unknown>
    const secondResult = second.apply.body['result'] as Record<string, unknown>
    expect(secondResult['action']).toBe('replace')
    // "改之前"的指纹就是第一次写进去的那把 —— 替换也要能说清换掉的是哪一把。
    expect(secondResult['previousFingerprint']).toBe(firstResult['fingerprint'])

    const text = await readFile(harness.credentialsPath, 'utf8')
    // 号池 ref 只出现一次 —— "同一个号重复入库"就是在这里被挡住的。
    expect(text.match(/^ {2}CURSOR_CK_[0-9a-f]{8}:/gm)?.length).toBe(1)
    expect(duplicateBasisLabel('value')).toContain('密钥本身相同')
  })

  it('历史 ref 与当前命名规则不一致时，靠 authId 认出同一个号（端到端）', async () => {
    const legacyKey = `crsr_${'i'.repeat(64)}`
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    // 造一条"老 ref"：ref 名不是按现在的规则派生的，但 authId 是同一个账号。
    await writeFile(
      harness.credentialsPath,
      `${CREDENTIALS}  CURSOR_CK_0badc0de: ${legacyKey}\n`,
      { mode: 0o600 },
    )
    await writeFile(harness.poolPath, JSON.stringify({
      version: 1,
      entries: {
        CURSOR_CK_0badc0de: {
          ref: 'CURSOR_CK_0badc0de', label: '历史条目', fingerprint: fingerprintOf(legacyKey),
          authId: ACCOUNT_A.authId, email: ACCOUNT_A.email, shape: 'api-key',
          addedAt: 1, addedBy: '167', lastVerifiedAt: 1, previousFingerprint: null,
        },
      },
    }, null, 2), { mode: 0o600 })

    const { preflight } = await previewAdd(harness, cookie, JWT_A)
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    expect(diff['action']).toBe('replace')
    expect(diff['duplicateBasis']).toBe('auth_id')
    expect(diff['existingRef']).toBe('CURSOR_CK_0badc0de')
  })
})

describe('写前探测：失败绝不写盘、不留备份（分类照 §8.7 四类表）', () => {
  it('上游 401 → 400 credential_rejected，文件逐字节不变，也没有备份', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    // 一位不认识的 key：桩回 401。身份都拿不到，所以预览就必须拒绝（连 ref 都说不出来）。
    const { preflight } = await previewAdd(harness, cookie, `crsr_${'z'.repeat(64)}`)

    expect(preflight.status).toBe(400)
    expect(preflight.body['code']).toBe('credential_rejected')
    expect(preflight.body['probeKind']).toBe('credential_rejected')
    expect(preflight.body['written']).toBe(false)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
    // 没有写盘 → 管理台的元数据文件也不该被创建。
    expect(await readdir(harness.dataDir)).not.toContain('pool.json')
  })

  it('API key 被换票接口拒了 → 400 credential_rejected（**这一步非 200 才是"key 被拒"**）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, `crsr_${'y'.repeat(64)}`)
    expect(preflight.status).toBe(400)
    expect(preflight.body['probeKind']).toBe('credential_rejected')
    // 换票过不去，就不该再打 GetMe（后面的身份调用无从谈起）。
    expect(harness.calls.some(call => call.path.endsWith('/GetMe'))).toBe(false)
    expect(harness.calls.find(call => call.path.endsWith(CURSOR_EXCHANGE_API_KEY_PATH))?.authorization)
      .toBe(`Bearer crsr_${'y'.repeat(64)}`)
  })

  it('换票成功但取身份失败 → 502 upstream_unavailable，**不能**说成"key 无效"', async () => {
    const apiKey = `crsr_${'w'.repeat(64)}`
    const harness = await startHarness({ apiKeys: new Map([[apiKey, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    // 换票走通（说明 key 被上游接受了），随后 GetMe 才崩 —— 这正是"别把上游异常赖到 key 头上"。
    harness.failGetMeFromNowOn(401)
    const { preflight } = await previewAdd(harness, cookie, apiKey)

    expect(preflight.status).toBe(502)
    expect(preflight.body['code']).toBe('upstream_unavailable')
    expect(preflight.body['probeKind']).toBe('upstream_unavailable')
    const message = String(preflight.body['message'])
    expect(message).toContain('换票成功')
    expect(message).toContain('不是这枚 key 的问题')
    // 换票确实发生了（否则"换票成功"这句话就是假的）。
    expect(harness.calls.some(call => call.path.endsWith(CURSOR_EXCHANGE_API_KEY_PATH))).toBe(true)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('上游 429 → 502，并说明**不能证明**凭据无效', async () => {
    const harness = await startHarness({ getMeStatus: 429 })
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, JWT_A)
    expect(preflight.status).toBe(502)
    expect(preflight.body['code']).toBe('upstream_unavailable')
    expect(preflight.body['probeKind']).toBe('rate_limited')
    expect(String(preflight.body['message'])).toMatch(/不能证明/)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
  })

  it('上游 503 → 502；重试一次后仍失败就如实回报（不把上游抖动说成凭据问题）', async () => {
    const harness = await startHarness({ getMeStatus: 503 })
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, JWT_A)
    expect(preflight.status).toBe(502)
    expect(preflight.body['code']).toBe('upstream_unavailable')
    expect(String(preflight.body['message'])).toMatch(/不能证明/)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    // 5xx 重试一次：两次都打到了上游。
    expect(harness.calls.filter(call => call.path.endsWith('/GetMe')).length).toBe(2)
  })

  it('上游 200 但没给 authId → 按"无法确认"处理（号池的主键就是它，不猜）', async () => {
    const harness = await startHarness({ getMeWithoutAuthId: true })
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, JWT_A)
    expect(preflight.status).toBe(502)
    expect(preflight.body['probeKind']).toBe('upstream_unavailable')
    expect(String(preflight.body['message'])).toContain('authId')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('归一化那一步失败（CreateUserApiKey 401）同样不写盘', async () => {
    const harness = await startHarness({ createKeyStatus: 401 })
    const cookie = await superAdminSession(harness)
    // 预览只验活（GetMe 正常）→ 通过；归一化发生在 apply，因此失败也在那里被挡住。
    const { preflight, apply } = await addCredential(harness, cookie, JWT_A)
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    expect(apply.status).toBe(400)
    expect(apply.body['code']).toBe('credential_rejected')
    expect(apply.body['probeKind']).toBe('credential_rejected')
    expect(apply.body['written']).toBe(false)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
  })

  it('预览通过不等于可以写：**apply 自己再探一次**，上游翻脸就不写盘', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    // 预览时上游一切正常，拿到了令牌。
    const { preflight, token } = await previewAdd(harness, cookie, JWT_A, '甲号')
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    const probe = diff['probe'] as Record<string, unknown>
    expect(probe['ok']).toBe(true)
    expect(probe['endpoint']).toBe('GetMe')
    expect(typeof probe['latencyMs']).toBe('number')

    // 令牌发出之后上游翻脸（凭据被吊销/上游故障），apply 必须自己发现。
    harness.failGetMeFromNowOn(401)
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '甲号', token, reason: '预览之后上游变了（测试）' },
      cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(400)
    expect(apply.body['code']).toBe('credential_rejected')
    expect(apply.body['probeKind']).toBe('credential_rejected')
    expect(apply.body['written']).toBe(false)
    // 逐字节不变，且**没有留下备份**（失败发生在动盘之前）。
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
    expect(await readdir(harness.dataDir)).not.toContain('pool.json')

    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.add.apply' })
    const denied = audit.entries.find(entry => entry.result === 'deny')
    expect(denied?.reason).toBe('credential_rejected')
    expect(denied?.summary).toContain('写前探测未通过')
  })

  it('apply 的探测失败若属"无法确认"（5xx），回 502 而不是"凭据无效"', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { token } = await previewAdd(harness, cookie, JWT_A)
    harness.failGetMeFromNowOn(503)
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', token, reason: '上游抖了（测试）' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(502)
    expect(apply.body['code']).toBe('upstream_unavailable')
    expect(apply.body['probeKind']).toBe('upstream_unavailable')
    expect(String(apply.body['message'])).toMatch(/不能证明/)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
  })

  it('探测失败也留审计（拒绝也是一种结果，必须可追溯）', async () => {
    const harness = await startHarness({ getMeStatus: 503 })
    const cookie = await superAdminSession(harness)
    await previewAdd(harness, cookie, JWT_A)
    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.add' })
    const denied = audit.entries.find(entry => entry.result === 'deny')
    expect(denied).toBeDefined()
    expect(denied?.reason).toBe('upstream_unavailable')
    expect(denied?.summary).toContain('写前探测未通过')
  })

  it('号池 ref 的探测目标就在内置表里（前缀兜底），且注入的探测表是权威的', () => {
    const target = probeTargetFor('CURSOR_CK_deadbeef')
    expect(target?.kind).toBe('cursor-dashboard')
    expect(target?.baseUrl).toBe('https://api2.cursor.sh')
    // 号池今天的消费方还不存在 → 没有任何进程缓存了它，所以不需要重启。
    expect(target?.restartRequired).toBe(false)
    expect(probeTargetFor('DEEPSEEK_API_KEY')?.kind).toBe('openai-chat')
    // 注入探测表时按注入的算（否则测试里的"打哪里"就接管不了）。
    expect(probeTargetFor('CURSOR_CK_deadbeef', {})).toBeUndefined()
  })
})

describe('两步确认：令牌绑"同一个人 + 同一个动作 + 同一份载荷"', () => {
  it('缺少令牌 → 409 confirm_required，且不写文件', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const result = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', reason: '想直接加' }, cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(409)
    expect(result.body['code']).toBe('confirm_required')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('载荷不一致（预览的是 A、提交的是 B）→ 409 confirm_mismatch', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { token } = await previewAdd(harness, cookie, JWT_A)
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_B, label: '', token, reason: '换了内容' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(409)
    expect(apply.body['code']).toBe('confirm_mismatch')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    // 载荷不一致也要留痕。
    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.add' })
    expect(audit.entries.some(entry => entry.reason === 'confirm_mismatch')).toBe(true)
  })

  it('标签也是载荷的一部分：预览时写 A 标签、提交时改成 B → 409', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { token } = await previewAdd(harness, cookie, JWT_A, '甲号')
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '乙号', token, reason: '换了标签' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(409)
    expect(apply.body['code']).toBe('confirm_mismatch')
  })

  it('令牌换动作使不动：add 的令牌拿去 remove → 409', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    const ref = (apply.body['result'] as Record<string, unknown>)['ref'] as string
    const { token } = await previewAdd(harness, cookie, JWT_A)
    const remove = await api(harness, '/pool/remove', {
      body: { ref, token, reason: '拿 add 的令牌来删' }, cookie, ip: '203.0.113.7',
    })
    expect(remove.status).toBe(409)
    expect(remove.body['code']).toBe('confirm_mismatch')
    expect(await readFile(harness.credentialsPath, 'utf8')).toContain(ref)
  })

  it('原因太短 → 400（将来对账的人要知道为什么加）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { token } = await previewAdd(harness, cookie, JWT_A)
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', token, reason: '加' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(400)
    expect(String(apply.body['message'])).toContain('原因')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })
})

describe('权限：`credential.manage` 且必须是 super-admin（服务端硬判定）', () => {
  const roleWithManage: RoleRecord = {
    id: 'ops-can-manage-credentials',
    name: '运维（含密钥权限）',
    kind: 'custom',
    surface: 'ai-admin',
    description: '有 credential.manage 权限，但**不是** super-admin —— 正是要被挡住的那种角色。',
    scopeDefault: 'all',
    permissions: ['credential.read', 'credential.manage'],
  }

  it('非 super-admin 加号 → 403 且写审计 pool.add.apply / deny / not_super_admin', async () => {
    const harness = await startHarness()
    await harness.service.components.roles.save({ version: 1, roles: [roleWithManage] })
    await grantAdmin(harness, '200', roleWithManage.id)
    const cookie = await login(harness, 'other')

    const result = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', token: 'whatever', reason: '尝试越权' }, cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(403)
    expect(result.body['code']).toBe('forbidden')
    expect(result.body['need']).toBe('super-admin')
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)

    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.add.apply' })
    const denied = audit.entries.find(entry => entry.result === 'deny')
    expect(denied?.reason).toBe('not_super_admin')
    expect(denied?.actorId).toBe('200')
    // 越权尝试**一次上游都没打**：判定在探测之前。
    expect(harness.calls.filter(call => call.url.includes('cursor.sh')).length).toBe(0)
  })

  it('非 super-admin 预览与移除同样被挡（两道口子都堵上）', async () => {
    const harness = await startHarness()
    await harness.service.components.roles.save({ version: 1, roles: [roleWithManage] })
    await grantAdmin(harness, '200', roleWithManage.id)
    const cookie = await login(harness, 'other')

    const preflight = await api(harness, '/pool/preflight', {
      body: { credential: JWT_A, label: '' }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status).toBe(403)
    expect(preflight.body['need']).toBe('super-admin')

    const remove = await api(harness, '/pool/remove', {
      body: { ref: 'CURSOR_CK_deadbeef', token: 'x', reason: '尝试越权' }, cookie, ip: '203.0.113.7',
    })
    expect(remove.status).toBe(403)
    expect(remove.body['need']).toBe('super-admin')

    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.remove.apply' })
    expect(audit.entries.some(entry => entry.result === 'deny' && entry.reason === 'not_super_admin')).toBe(true)
  })

  it('没有 credential.manage 的角色被权限层挡住（need 是权限键）', async () => {
    const harness = await startHarness()
    const readonly: RoleRecord = {
      id: 'pool-readonly', name: '只读', kind: 'custom', surface: 'ai-admin',
      description: '只有读权限。', scopeDefault: 'all', permissions: ['credential.read'],
    }
    await harness.service.components.roles.save({ version: 1, roles: [readonly] })
    await grantAdmin(harness, '200', readonly.id)
    const cookie = await login(harness, 'other')

    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', token: 'x', reason: '尝试' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(403)
    expect(apply.body['need']).toBe('credential.manage')
    // 只读角色**可以**看列表（列表只给指纹，不给值）。
    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    expect(list.status).toBe(200)
  })

  it('未登录看列表 → 401', async () => {
    const harness = await startHarness()
    const result = await api(harness, '/pool/list', { ip: '203.0.113.7' })
    expect(result.status).toBe(401)
  })
})

describe('不回显：值在任何响应、审计、管理台数据文件里都不出现', () => {
  it('apply 成功后的响应里只有指纹，没有 JWT、也没有落盘的那把 key', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    expect(apply.status).toBe(200)
    expect(apply.raw).not.toContain(JWT_A)

    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(await readFile(harness.credentialsPath, 'utf8'))?.[1] as string
    expect(apply.raw).not.toContain(stored)
    const result = apply.body['result'] as Record<string, unknown>
    expect(result['fingerprint']).toBe(fingerprintOf(stored))
  })

  it('预览的差异里只有身份与**诚实的指纹**，没有粘贴上来的那一串', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { preflight } = await previewAdd(harness, cookie, JWT_A, '甲号')
    expect(preflight.status).toBe(200)
    expect(preflight.raw).not.toContain(JWT_A)
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    expect(diff['identity']).toEqual({ authId: ACCOUNT_A.authId, email: ACCOUNT_A.email })
    expect(diff['action']).toBe('add')
    expect(diff['ref']).toBe(poolRefForAuthId(ACCOUNT_A.authId))
    /**
     * 会话形态在预览阶段**还没有**落盘值（归一化发生在 apply），所以指纹必须是 `null`。
     * 报"贴进来那一串的指纹"会与写入结果对不上 —— 让人以为凭据被换了，那正是两步确认
     * 要防的"预览看到 A、执行的是 B"。
     */
    expect(diff['valueKnown']).toBe(false)
    expect(diff['fingerprint']).toBeNull()
    expect(diff['fingerprintSubject']).toBeNull()
    expect(String(diff['note'])).toContain('归一化')
    const probe = diff['probe'] as Record<string, unknown>
    expect(probe['ok']).toBe(true)
    expect(probe['endpoint']).toBe('GetMe')
    expect(typeof probe['latencyMs']).toBe('number')
  })

  it('`crsr_…` 形态的预览能给出**真实的落盘指纹**（那把值不会被换掉）', async () => {
    const apiKey = `crsr_${'k'.repeat(64)}`
    const harness = await startHarness({ apiKeys: new Map([[apiKey, ACCOUNT_A]]) })
    const cookie = await superAdminSession(harness)
    const { preflight, token } = await previewAdd(harness, cookie, apiKey, '甲号')
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    expect(diff['valueKnown']).toBe(true)
    expect(diff['fingerprintSubject']).toBe('stored-value')
    expect(diff['fingerprint']).toBe(fingerprintOf(apiKey))
    // 预览也不铸新 key（它本来就是长期 key）。
    expect(harness.calls.some(call => call.path.endsWith('/CreateUserApiKey'))).toBe(false)

    // 写入结果里的指纹与预览完全一致 —— 这是"预览看到的 A 就是执行的 A"的证据。
    const apply = await api(harness, '/pool/apply', {
      body: { credential: apiKey, label: '甲号', token, reason: '加一个 API key 形态的号' },
      cookie, ip: '203.0.113.7',
    })
    expect(apply.status, JSON.stringify(apply.body)).toBe(200)
    expect((apply.body['result'] as Record<string, unknown>)['fingerprint']).toBe(diff['fingerprint'])
    expect(harness.calls.some(call => call.path.endsWith('/CreateUserApiKey'))).toBe(false)
  })

  it('列表只给指纹/标签/状态/身份，**没有任何值字段**', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await addCredential(harness, cookie, JWT_A, '甲号')
    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(await readFile(harness.credentialsPath, 'utf8'))?.[1] as string

    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    expect(list.status).toBe(200)
    expect(list.raw).not.toContain(stored)
    expect(list.raw).not.toContain(JWT_A)
    const keys = list.body['keys'] as readonly Record<string, unknown>[]
    expect(keys.length).toBe(1)
    expect(Object.keys(keys[0] as Record<string, unknown>).sort()).toEqual([
      'addedAt', 'addedBy', 'authId', 'email', 'fingerprint', 'label',
      'lastVerifiedAt', 'previousFingerprint', 'ref', 'shape', 'status',
    ])
    expect(keys[0]?.['status']).toBe('active')
    expect(keys[0]?.['fingerprint']).toBe(fingerprintOf(stored))
    expect(keys[0]?.['authId']).toBe(ACCOUNT_A.authId)
    expect(keys[0]?.['email']).toBe(ACCOUNT_A.email)
    expect(keys[0]?.['label']).toBe('甲号')
    // 网关自己的密钥**不属于号池**，不该出现在这里。
    expect(keys.some(key => key['ref'] === 'DEEPSEEK_API_KEY')).toBe(false)
  })

  it('审计文件里只有指纹（明文进审计等于把凭据抄一份）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await addCredential(harness, cookie, JWT_A)
    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(await readFile(harness.credentialsPath, 'utf8'))?.[1] as string

    const auditFile = await readFile(join(harness.dataDir, 'audit.jsonl'), 'utf8')
    expect(auditFile).not.toContain(JWT_A)
    expect(auditFile).not.toContain(stored)
    expect(auditFile).toContain(fingerprintOf(stored))
    expect(auditFile).toContain(ACCOUNT_A.authId)
    // 探测结论的分类与**真实状态码**都要在（"这次为什么算通过"必须可追溯）。
    expect(auditFile).toContain('探测通过')
    expect(auditFile).toContain('HTTP 200')
    expect(auditFile).toContain('exchange_user_api_key → GetMe')
  })

  it('管理台的任何数据文件里都不出现明文（元数据只存指纹与身份）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await addCredential(harness, cookie, JWT_A)
    const stored = /^\s{2}CURSOR_CK_[0-9a-f]{8}: (.+)$/m.exec(await readFile(harness.credentialsPath, 'utf8'))?.[1] as string

    for (const name of await readdir(harness.dataDir)) {
      const info = await stat(join(harness.dataDir, name))
      if (!info.isFile()) continue
      const content = await readFile(join(harness.dataDir, name), 'utf8').catch(() => '')
      expect(content, `数据文件 ${name} 里不该出现明文凭据`).not.toContain(stored)
      expect(content, `数据文件 ${name} 里不该出现会话 JWT`).not.toContain(JWT_A)
    }
    const meta = await readPoolMeta(harness)
    const record = meta.keys[poolRefForAuthId(ACCOUNT_A.authId)] as Record<string, unknown>
    expect(record['fingerprint']).toBe(fingerprintOf(stored))
    expect(record['addedBy']).toBe('167')
    expect(record['shape']).toBe('session')
  })
})

describe('校验复用：既有 valueRejectionReason / refRejectionReason 就是这条线的那道门', () => {
  it('归一化拿到的值不合法时拒绝写入，理由来自既有校验', async () => {
    // 桩固定回一把带空格的 key —— 那在 YAML 裸标量里会被静默改变。
    const harness = await startHarness({ fixedMintedKey: 'crsr_bad value here' })
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    expect(apply.status).toBe(400)
    expect(apply.body['code']).toBe('bad_request')
    expect(String(apply.body['message'])).toContain(valueRejectionReason('crsr_bad value here') as string)
    expect(apply.body['written']).toBe(false)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    expect(await readdir(harness.backupDir).catch(() => [])).toEqual([])
  })

  it('标签过长/带控制字符 → 400，理由是 labelRejectionReason 给的', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const tooLong = await api(harness, '/pool/preflight', {
      body: { credential: JWT_A, label: 'x'.repeat(65) }, cookie, ip: '203.0.113.7',
    })
    expect(tooLong.status).toBe(400)
    expect(String(tooLong.body['message'])).toBe(labelRejectionReason('x'.repeat(65)))
    const control = await api(harness, '/pool/preflight', {
      body: { credential: JWT_A, label: '甲\u0000号' }, cookie, ip: '203.0.113.7',
    })
    expect(control.status).toBe(400)
    expect(String(control.body['message'])).toContain('控制字符')
    // 标签不合规时**一次上游都没打**（问题在请求本身）。
    expect(harness.calls.filter(call => call.url.includes('cursor.sh')).length).toBe(0)
  })

  it('凭据文件读不懂时拒绝写入（宁可不加，也不写坏工作台）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await writeFile(harness.credentialsPath, `${CREDENTIALS}unknown_section: 1\n`, { mode: 0o600 })
    const { preflight, token } = await previewAdd(harness, cookie, JWT_A)
    expect(preflight.status).toBe(500)
    expect(String(preflight.body['message'])).toContain('顶层键')
    // 预览被拒 → 没有令牌；就算硬提交一次也什么都写不了。
    expect(token).toBe('')
    const apply = await api(harness, '/pool/apply', {
      body: { credential: JWT_A, label: '', token: 'x', reason: '硬提交一次' }, cookie, ip: '203.0.113.7',
    })
    expect(apply.status).toBe(409)
    expect(apply.body['written']).toBeUndefined()
    // 文件仍是"带未知键"的原样（我们既没修它，也没写坏它）。
    expect(await readFile(harness.credentialsPath, 'utf8')).toContain('unknown_section: 1')
  })

  it('凭据文件读不懂时列表降级展示，而不是一片红', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    await writeFile(harness.credentialsPath, `${CREDENTIALS}unknown_section: 1\n`, { mode: 0o600 })
    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    expect(list.status).toBe(200)
    expect(list.body['keys']).toEqual([])
    expect((list.body['fileError'] as Record<string, unknown>)['code']).toBe('unknown_top_level')
  })
})

describe('移除：真的把 refs 段那一行删掉（只删元数据会留下还能取到的凭据）', () => {
  it('加完再移除：文件里那一行没了，元数据清了，备份留下了', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    const ref = (apply.body['result'] as Record<string, unknown>)['ref'] as string

    const preflight = await api(harness, '/pool/preflight', {
      body: { op: 'remove', ref }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status, JSON.stringify(preflight.body)).toBe(200)
    const diff = (preflight.body['confirm'] as Record<string, unknown>)['diff'] as Record<string, unknown>
    expect(diff['action']).toBe('remove')
    expect(diff['after']).toBeNull()
    // 删除没有新凭据要验：探测定是"不适用"，不是"通过"。
    expect(diff['probe']).toBeNull()
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token'] as string

    const remove = await api(harness, '/pool/remove', {
      body: { ref, token, reason: '这个号不干了（测试）' }, cookie, ip: '203.0.113.7',
    })
    expect(remove.status, JSON.stringify(remove.body)).toBe(200)
    const result = remove.body['result'] as Record<string, unknown>
    expect(result['action']).toBe('remove')
    // 删除之后没有"新指纹"：null 比留一个旧指纹诚实。
    expect(result['fingerprint']).toBeNull()
    expect(result['written']).toBe(true)
    expect(result['backupPath']).toBeTruthy()

    const text = await readFile(harness.credentialsPath, 'utf8')
    expect(text).not.toContain(ref)
    // 别的东西一个都没动。
    expect(text).toContain('  DEEPSEEK_API_KEY: sk-old-fake-value')
    expect(text).toContain('      secret: fake-browser-session-secret')
    expect((await stat(harness.credentialsPath)).mode & 0o777).toBe(0o600)

    // 元数据也清了（否则列表里会留一个"看起来还在"的号）。
    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    expect(list.body['keys']).toEqual([])
    const audit = await harness.service.components.audit.query({ actionPrefix: 'pool.remove.apply' })
    expect(audit.entries.some(entry => entry.result === 'allow')).toBe(true)
  })

  it('移除后清单里不再有它（回滚点仍可人工还原）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const { apply } = await addCredential(harness, cookie, JWT_A)
    const ref = (apply.body['result'] as Record<string, unknown>)['ref'] as string
    const beforeRemove = await readFile(harness.credentialsPath, 'utf8')

    const preflight = await api(harness, '/pool/preflight', { body: { op: 'remove', ref }, cookie, ip: '203.0.113.7' })
    const token = (preflight.body['confirm'] as Record<string, unknown>)['token'] as string
    const remove = await api(harness, '/pool/remove', {
      body: { ref, token, reason: '移除（测试）' }, cookie, ip: '203.0.113.7',
    })
    const backupPath = (remove.body['result'] as Record<string, unknown>)['backupPath'] as string
    expect(await readFile(backupPath, 'utf8')).toBe(beforeRemove)
  })

  it('**不能**从号池接口删掉网关自己的密钥（破坏性操作必须有边界）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const preflight = await api(harness, '/pool/preflight', {
      body: { op: 'remove', ref: 'DEEPSEEK_API_KEY' }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status).toBe(400)
    expect(String(preflight.body['message'])).toContain('不属于号池')

    const remove = await api(harness, '/pool/remove', {
      body: { ref: 'DEEPSEEK_API_KEY', token: 'x', reason: '想删网关密钥' }, cookie, ip: '203.0.113.7',
    })
    expect(remove.status).toBe(400)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
    // 连上游都没打（请求本身就被拒了）。
    expect(harness.calls.filter(call => call.url.includes('cursor.sh')).length).toBe(0)
  })

  it('移除一个池子里没有的 ref → 404，文件不变', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const preflight = await api(harness, '/pool/preflight', {
      body: { op: 'remove', ref: 'CURSOR_CK_deadbeef' }, cookie, ip: '203.0.113.7',
    })
    expect(preflight.status).toBe(404)
    expect(await readFile(harness.credentialsPath, 'utf8')).toBe(CREDENTIALS)
  })

  it('元数据还在、值已被手工删掉时，列表显示 missing（不能让界面骗人）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    // 只写元数据，不写凭据文件里那一行。
    await writeFile(harness.poolPath, JSON.stringify({
      version: 1,
      entries: {
        CURSOR_CK_abcdef01: {
          ref: 'CURSOR_CK_abcdef01', label: '孤儿条目', fingerprint: 'deadbeef',
          authId: ACCOUNT_B.authId, email: ACCOUNT_B.email, shape: 'api-key',
          addedAt: 1, addedBy: '167', lastVerifiedAt: 1, previousFingerprint: null,
        },
      },
    }, null, 2), { mode: 0o600 })

    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    const keys = list.body['keys'] as readonly Record<string, unknown>[]
    expect(keys.length).toBe(1)
    expect(keys[0]?.['status']).toBe('missing')
    expect(keys[0]?.['fingerprint']).toBe('deadbeef')
  })

  it('op 只认 add / remove', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const result = await api(harness, '/pool/preflight', {
      body: { op: 'delete', ref: 'CURSOR_CK_deadbeef' }, cookie, ip: '203.0.113.7',
    })
    expect(result.status).toBe(400)
    expect(String(result.body['message'])).toContain('op')
  })
})

describe('生效机制如实暴露：号池的消费方还没接，就不声称已经生效', () => {
  it('列表给出 activation，并明确写清"把号用起来"是消费方的事', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const list = await api(harness, '/pool/list', { cookie, ip: '203.0.113.7' })
    const activation = list.body['activation'] as Record<string, unknown>
    expect(activation['fileWatcher']).toContain('自动加载')
    expect(String(activation['consumer'])).toContain('尚未接入')
    expect(activation['restartRequired']).toBe(false)
    expect(activation['restartCommand']).toBeNull()
    expect(String(activation['note'])).toContain('不声称已经生效')
    expect(list.body['metadataPath']).toBe(harness.poolPath)
  })

  /**
   * 侧栏入口这件事**必须有测试盯着**。
   *
   * 这个坑本仓库实打实踩过一次：接口、权限键、前端页面全都建好了，唯独漏了 `MENU` ——
   * 于是有权限的角色侧栏里看不到入口，**整个功能在界面上不存在，而接口测试全绿**。
   * 所以这里从**接口**这一侧证明入口会被发出去（`session/me` 是前端菜单的唯一来源）。
   */
  it('super-admin 的 session/me 里带号池入口（否则功能在界面上不可达）', async () => {
    const harness = await startHarness()
    const cookie = await superAdminSession(harness)
    const me = await api(harness, '/session/me', { cookie, ip: '203.0.113.7' })
    expect(me.status, JSON.stringify(me.body)).toBe(200)
    const menu = me.body['menu'] as readonly Record<string, unknown>[]
    const item = menu.find(entry => entry['key'] === 'pool')
    expect(item).toEqual({ key: 'pool', title: '上游号池', group: '安全', perm: 'credential.read' })
  })

  it('只有 credential.read 的角色也能看到入口（菜单是权限的投影，不是第二份配置）', async () => {
    const harness = await startHarness()
    const reader: RoleRecord = {
      id: 'pool-reader', name: '只读号池', kind: 'custom', surface: 'ai-admin',
      description: '只有 credential.read。', scopeDefault: 'all', permissions: ['credential.read'],
    }
    await harness.service.components.roles.save({ version: 1, roles: [reader] })
    await grantAdmin(harness, '200', reader.id)
    const cookie = await login(harness, 'other')
    const me = await api(harness, '/session/me', { cookie, ip: '203.0.113.7' })
    const menu = me.body['menu'] as readonly Record<string, unknown>[]
    expect(menu.some(entry => entry['key'] === 'pool')).toBe(true)

    // 没有任何 credential 权限的角色则看不到（菜单随权限走，不是写死的列表）。
    const stranger: RoleRecord = {
      id: 'auditor-only', name: '只读审计', kind: 'custom', surface: 'ai-admin',
      description: '只有 audit.read。', scopeDefault: 'all', permissions: ['audit.read'],
    }
    await harness.service.components.roles.save({ version: 1, roles: [stranger] })
    await grantAdmin(harness, '200', stranger.id)
    const strangerCookie = await login(harness, 'other')
    const strangerMe = await api(harness, '/session/me', { cookie: strangerCookie, ip: '203.0.113.7' })
    const strangerMenu = strangerMe.body['menu'] as readonly Record<string, unknown>[]
    expect(strangerMenu.some(entry => entry['key'] === 'pool')).toBe(false)
    // 顺带钉住"没权限就调不了"：菜单藏起来只是界面行为，接口自己会拒。
    const denied = await api(harness, '/pool/list', { cookie: strangerCookie, ip: '203.0.113.7' })
    expect(denied.status).toBe(403)
    expect(denied.body['need']).toBe('credential.read')
  })
})
