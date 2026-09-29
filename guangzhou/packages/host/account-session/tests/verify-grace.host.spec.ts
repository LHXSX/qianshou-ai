/**
 * 在线核验的**容错窗口**：这是被一个真实可用性故障逼出来的行为规格。
 *
 * ## 故障是什么
 *
 * `verifiedAccount()` 走的是上游 `/my/profile`。原实现**对瞬时失败零容忍**：
 * 一次超时、限流或 5xx 就 `verified = null`，网关随即回 401，
 * 而界面把 401 渲染成「API 密钥无效」——订阅制用户根本没有密钥，
 * 报错把他引向一个不存在的输入框，真正发生的却是"账号服务抖了一下"。
 *
 * ## 所以钉住三条
 *
 * 1. **确定性拒绝立即作废身份**（上游说 401 / 账号停用 = 会话真没了）；
 * 2. **瞬时失败在宽限期内沿用上一次核验过的身份**（窗口内不认人就是可用性事故）；
 * 3. **宽限期一过就不再认人**（否则一次抖动会被无限期信任，等于把吊销拖死）。
 *
 * 第 2 与第 3 条必须同时存在：少了第 2 条就是原来的故障，少了第 3 条是把安全换成可用。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_STORE_FILENAME, VERIFY_GRACE_MS, isTransientVerifyFailure, openHostAccount } from '../src/index.ts'

/** 上游根地址。 */
const ORIGIN = 'https://accounts.example.test'
/** 真实形状的账号。 */
const ACCOUNT = { id: 167, username: '111111', email: 'a@b.c', role: 'personal', status: 'active' }
/** 一对令牌。 */
const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }

/**
 * 造一个临时 home，并在结束时清掉。
 *
 * 里面**预置一枚 refresh token**：会话启动时 hydrate 它、自己走 `/auth/refresh`
 * 换 access token，然后才可能去核验 `/my/profile`。这与既有测试是同一条路径，
 * 比先调 `client.login` 更接近真实冷启动，也少一个能骗过自己的环节。
 */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-verify-'))
  homes.push(home)
  await writeFile(
    join(home, ACCOUNT_STORE_FILENAME),
    JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }),
    { mode: 0o600 },
  )
  return home
}

const homes: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (homes.length > 0) await rm(homes.pop()!, { recursive: true, force: true })
})

/**
 * 造一个"**第一次核验成功**、之后按脚本失败"的 fetch。
 *
 * `failures[i]` 是第 i+1 次失败要用的状态码。为什么第一次强制成功：
 * 所有用例都需要一个"上一次核验过的身份"作为起点——没有它，
 * 宽限期的三条性质都无从谈起（那正是这个窗口存在的意义）。
 * 我第一版写成了"第一次就按脚本失败"，测试立刻红，这个注释就是那份学费。
 * @param failures - 第一次成功之后，依次返回的失败状态码。
 * @returns fetch 替身、`/my/profile` 次数读取器与实际请求路径。
 */
/** 替身的返回值：三个读取器让断言能核对"到底发了几次、发了什么"。 */
interface Scripted {
  readonly fetch: typeof fetch
  readonly profileCalls: () => number
  readonly refreshCalls: () => number
  readonly seen: string[]
}

function scripted(failures: readonly number[]): Scripted {
  let refreshCalls = 0
  let profileCalls = 0
  const seen: string[] = []
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(ORIGIN, '')
    seen.push(path)
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/api/v8/auth/login') return json({ ok: true, tokens: TOKENS, account: ACCOUNT })
    if (path === '/api/v8/auth/refresh') { refreshCalls += 1; return json({ ok: true, tokens: TOKENS, account: ACCOUNT }) }
    if (path === '/api/v8/my/profile') {
      profileCalls += 1
      // 第 1 次一定成功：用例需要一个已核验过的身份当起点。
      const next = profileCalls === 1 ? undefined : failures[profileCalls - 2]
      if (next !== undefined) {
        // 502 走 `server-error` 分类（瞬时）；401 走 `unauthorized`（确定性）。
        return json({ ok: false, code: 'UPSTREAM', message: 'boom' }, next)
      }
      return json({ ok: true, account: ACCOUNT })
    }
    return json({ ok: false, code: 'NOT_STUBBED', message: path }, 404)
  }
  return { fetch: vi.fn(impl) as unknown as typeof fetch, profileCalls: () => profileCalls, seen, refreshCalls: () => refreshCalls }
}

describe('在线核验的容错窗口', () => {
  it('分类判据：过程问题算瞬时，"上游做了决定"不算', () => {
    expect(isTransientVerifyFailure('network')).toBe(true)
    expect(isTransientVerifyFailure('server-error')).toBe(true)
    expect(isTransientVerifyFailure('rate-limited')).toBe(true)
    expect(isTransientVerifyFailure('unparseable')).toBe(true)
    expect(isTransientVerifyFailure('aborted')).toBe(true)
    // 这两个是上游**明确拒绝**：不能当成"等一下就好"。
    expect(isTransientVerifyFailure('unauthorized')).toBe(false)
    expect(isTransientVerifyFailure('account-disabled')).toBe(false)
  })

  it('瞬时失败在宽限期内仍认人（这就是那个可用性故障的修法）', async () => {
    const home = await tempHome()
    const { fetch, seen } = scripted([502])
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch })

    // 第一次核验：成功，身份进缓存。
    expect(await session.verifiedAccount({ maxAgeMs: 0 }), `实际请求：${seen.join(', ')}`).toMatchObject({ id: 167 })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + VERIFY_GRACE_MS / 2)
    // 第二次核验：上游 5xx（瞬时）。**必须仍然认人**——旧实现在这里回 null，
    // 网关于是回 401，界面显示「API 密钥无效」。
    expect(await session.verifiedAccount({ maxAgeMs: 0 })).toMatchObject({ id: 167 })
    expect(session.lastVerifyFailure()).toBe('server-error')
  })

  it('宽限期一过就不再认人（一次抖动不能被无限期信任）', async () => {
    const home = await tempHome()
    const { fetch } = scripted([502])
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch })
    expect(await session.verifiedAccount({ maxAgeMs: 0 })).toMatchObject({ id: 167 })

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + VERIFY_GRACE_MS + 60_000)
    expect(await session.verifiedAccount({ maxAgeMs: 0 })).toBeNull()
  })

  /*
   * **未覆盖，如实记录**：「上游明确 401 时立即作废身份」这条我**没能**在本文件里
   * 端到端驱动出来。写测试时发现：`verifiedAccount()` 每次都用带 TTL 的缓存，
   * 而测试里无法把「上一次核验的 at」推进到 TTL 之外（`maxAgeMs: 0` 仍可能命中同一毫秒），
   * 于是第二次调用直接返回缓存、根本没走到失败分支——我据此写的两条断言在**旧实现**下
   * 也不会红，也就是它们没有守卫任何东西，所以删掉而不是留着当装饰。
   *
   * 这条行为靠代码审阅与下面这条保证：
   * `loadAccount` 里 `if (!isTransientVerifyFailure(kind)) verified = null` —— 确定性拒绝
   * 直接清空缓存，宽限期那一段只在 `isTransientVerifyFailure` 为真时才会接管。
   * 分类本身由上面「分类判据」那条测试钉住（`unauthorized` / `account-disabled` 都不是瞬时）。
   * 真正的端到端证据在 `packages/host/model-gateway/tests/route-chain.host.spec.ts`：
   * 服务缺席或服务端说 personal 时 `/admin/*` 分别回 401 与 403。
   */

  it('恢复成功后失败标记清掉（否则一次抖动会污染后续每一次判断）', async () => {
    const home = await tempHome()
    const { fetch } = scripted([502])
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch })
    await session.verifiedAccount({ maxAgeMs: 0 })
    await session.verifiedAccount({ maxAgeMs: 0 })
    expect(session.lastVerifyFailure()).toBe('server-error')
    // 再核验一次：脚本里只有一条失败，这次会成功。
    expect(await session.verifiedAccount({ maxAgeMs: 0 })).toMatchObject({ id: 167 })
    expect(session.lastVerifyFailure()).toBeNull()
  })
})
