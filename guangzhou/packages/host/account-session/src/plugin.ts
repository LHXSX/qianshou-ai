/**
 * 账号会话的宿主插件面：把 {@link openHostAccount} 暴露成可供电脑端界面调用的 HTTP 路由。
 *
 * 为什么必须有这一层：会话本身在宿主进程里跑（文件持久化、不受浏览器同源策略约束），
 * 但**界面够不到它**——界面在浏览器里，只能发 HTTP。少了这一层，宿主侧的会话就是个
 * 谁也打不开的盒子。
 *
 * 敏感材料的三条纪律（每一条都在测试里盯着）：
 *
 * 1. **口令只向内**：请求体里的 `password` / `old_password` / `current_password` 只进不出，
 *    响应里绝不回显，错误信息里也绝不带上。
 * 2. **令牌不出宿主**：access/refresh token 都留在宿主进程，界面只拿到「账号是谁、
 *    余额多少、是否已登录」这些展示所需的字段。
 * 3. **登出即清**：`signOut` 会连本机凭据一起清掉，不留半份。
 */
// 只为类型增强而导入：`ctx.connection` 的声明来自这个包（`declare module '@deepseek-ai/cordis'`），
// 少了它 `tsc` 不认得 `ctx.connection`。不用 `import type` 是因为要的就是那份声明。
import '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { isAccountFailure } from '@deepseek-ai/dsh-client-account'
import type { AccountFailure } from '@deepseek-ai/dsh-client-account'
import { openHostAccount, type HostAccountSession, type LoadAccountOutcome } from './index.ts'

/** Cordis 插件身份。 */
export const name = 'qianshou-account'

/** 路由挂在既有的已鉴权 owner 连接上；不新开监听端口。 */
export const inject = ['connection']

/** 请求体上限：账号接口的请求都很小，给 16 KiB 足够，也顺手挡住异常体积。 */
const MAX_BODY_BYTES = 16384

/**
 * 失败分类 → HTTP 状态码。
 *
 * 为什么要分开（这是一处真实缺陷的修法，WP1 A-19）：早先 `/me` 把「后端不可达」与
 * 「未登录」都回 401，界面于是显示「请先登录」——用户去重输口令，而真正的问题是网络。
 * 判据只有一个：**是不是服务端明确说了"你不行"**。网络层失败一律 5xx。
 * @param failure - 账号失败的分类对象。
 * @returns 状态码。
 */
function statusOf(failure: AccountFailure): number {
  switch (failure.kind) {
    // 服务端明确拒绝：请去登录（或账号被停用）。
    case 'unauthorized':
    case 'account-disabled':
      return 401
    // 限流：客户端该等一下再试，不是"重新登录"。
    case 'rate-limited':
      return 429
    // 调用方自己断的：不是服务端故障。
    case 'aborted':
      return 499
    // 后端不可达 / 上游 5xx / 响应读不懂：都不是"没登录"，必须回 5xx。
    case 'network':
    case 'server-error':
    case 'unparseable':
      return 502
    default:
      return 400
  }
}

/**
 * 暴露给同进程其它插件的账号形状。
 *
 * 不给余额、邮箱或整份账号对象：其它插件要的是身份与角色，以及（可选）调用上游的 access token。
 * HTTP 路由仍然不回令牌；令牌只留在宿主进程里。
 */
interface ExposedAccount {
  readonly id: number | string
  readonly role: string
}

/** 把失败翻译成界面能展示的一句话。失败对象已经过账号包的遮盖，可以透出。 */
function messageOf(failure: AccountFailure): string {
  return failure.message
}

/** 插件配置。 */
export interface Config {
  /** 凭据文件路径；省略时用 `$DSH_HOME/.qianshou-account.json`。 */
  readonly storePath?: string
  /** 接口基址；省略时用生产域。 */
  readonly baseUrl?: string
}

/**
 * 挂载账号面。
 * @param ctx - 宿主作用域，提供已鉴权的 connection。
 * @param config - 部署侧可覆盖的路径与基址。
 */
export function apply(ctx: Context, config: Config = {}): void {
  /**
   * 打开**一次**会话并复用。
   *
   * 不在每个请求里新开：凭据的 hydrate 与内存态都在会话里，每请求新建等于每次都要重新读盘，
   * 而且并发请求会各持一份互不知情的令牌。
   */
  let opening: Promise<HostAccountSession> | null = null
  const accountOf = (): Promise<HostAccountSession> => {
    opening ??= openHostAccount({
      ...(config.storePath === undefined ? {} : { storePath: config.storePath }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    })
    return opening
  }

  /**
   * 把会话暴露给同进程的其它插件。
   *
   * 为什么必须提供：配对引导要写绑定，而绑定的 `accountId` 必须是**真实登录账号**——
   * 那个值只有这里知道。不暴露的话，引导只能编一个占位身份（比如 `local-owner`），
   * 跨设备就会把两台机器当成两个人。
   *
   * `account()` 是**异步**的，这是刻意的：会话在插件挂载时才开始打开（要读凭据文件），
   * 同步读只能返回一个会过期的快照——那正是"明明登录了却读到 null"这类 bug 的来源。
   * 调用方 `await` 它，拿到的永远是当下真实的值。
   */
  ctx.provide('accountSession', {
    /**
     * 当前账号；**只在会话真的处于 `authenticated` 时返回**。
     *
     * 为什么必须加这道门（WP1 A-01）：这个值被别的插件当作**身份**用（配对绑定要写
     * `accountId`，网关要判角色）。而它在冷启动时来自磁盘缓存，且登出后仍然留着——
     * 不设门就等于"登出后身份还在"，与"未登录就没有身份"直接矛盾。
     * 展示用的快照另有出路（HTTP `/state`），那条路不构成授权依据。
     */
    account: async (): Promise<ExposedAccount | null> => {
      const session = await accountOf()
      if (session.state() !== 'authenticated') return null
      return session.account()
    },
    /**
     * **服务端权威**的账号快照（在线核验 `/me`，默认 60 秒 TTL）。
     *
     * 角色与管理员身份只能信它：磁盘缓存里的 `role` 与工作台同属一个 OS 用户，
     * 改一行就是管理员（WP1 A-01）。核验不过时返回 `null`，调用方只能表现为
     * "认不出身份"，而不是"继承上一次看到的角色"。
     */
    verifiedAccount: async (options?: { readonly maxAgeMs?: number }): Promise<ExposedAccount | null> => {
      const session = await accountOf()
      return await session.verifiedAccount(options)
    },
    /**
     * 同进程宿主插件调用上海接口用的 access token。
     * HTTP 账号路由仍然不把令牌回给浏览器。
     */
    ensureAccessToken: async (): Promise<string | null> => {
      const session = await accountOf()
      return await session.ensureAccessToken()
    },
  })

  const response = (value: unknown, status = 200): Response => Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  })

  /** 读请求体；形状不对一律 400，不猜。 */
  const body = async (request: Request): Promise<Record<string, unknown>> => {
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }

  /**
   * 把失败翻译成界面能展示的一句话。
   *
   * **只有 `AccountFailure` 可以透出 `message`**（WP1 A-16）。早先的写法是"只要有
   * `message` 字符串就透出"，于是 `TypeError`、`fetch` 的 `cause`、带绝对路径的
   * 文件系统错误都会以 400 的正文出现在浏览器页面上——对用户毫无用处，对排查也是误导
   * （它看起来像业务错误）。非账号异常一律固定文案 + 记 logger：那里才是它该出现的地方。
   */
  const failure = (error: unknown): Response => {
    if (isAccountFailure(error)) return response({ ok: false, message: messageOf(error) }, statusOf(error))
    ctx.logger.error(`qianshou-account: 账号路由出现非账号异常，已按固定文案回复：${String(error)}`)
    return response({ ok: false, message: '操作没成功，请稍后再试。' }, 500)
  }

  /**
   * 把一次 `/me` 的结果翻成响应。
   *
   * 分开写是因为三条路由（`/me`、`login`、`login-totp`）都要它，而**状态码的判据只有一份**：
   * 后端不可达必须是 5xx，不能和"未登录"混成一个 401（A-19）。
   */
  const accountOutcomeResponse = (session: HostAccountSession, outcome: LoadAccountOutcome): Response => {
    if (outcome.ok && outcome.account !== null) {
      return response({ ok: true, state: session.state(), account: outcome.account })
    }
    if (outcome.failure !== null) {
      return response({ ok: false, message: messageOf(outcome.failure) }, statusOf(outcome.failure))
    }
    // 既没成功也没有失败对象：只可能是不该出现的组合，按服务端故障处理，不谎报"未登录"。
    return response({ ok: false, message: '账号信息暂时读不到，请稍后再试。' }, 502)
  }

  /**
   * 界面可见的状态；**不含任何令牌**。
   *
   * 刻意**不**在这里报告「有没有 access token」：冷启动时它必然为空（短期凭据不落盘），
   * 报出去只会让界面误判成「没登录」；而为了报得准去主动刷新一次，又会让一个只读接口产生副作用。
   * 真实状态由 `state`（signed-out / authenticated / expired）与 `/me` 的成败决定。
   */
  const snapshotOf = (session: HostAccountSession): Record<string, unknown> => ({
    ok: true,
    state: session.state(),
    account: session.account(),
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/state', methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      try {
        return response(snapshotOf(await accountOf()))
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/state')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/me', methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      try {
        const session = await accountOf()
        return accountOutcomeResponse(session, await session.loadAccount())
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/me')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/login', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        const username = typeof payload['username'] === 'string' ? payload['username'] : ''
        const password = typeof payload['password'] === 'string' ? payload['password'] : ''
        if (username.length === 0 || password.length === 0) {
          return response({ ok: false, message: '请填写账号和密码。' }, 400)
        }
        const session = await accountOf()
        const result = await session.client.login({ username, password })
        if (result.kind === 'two-factor') {
          // 不返回 challenge_token 之外的任何东西；界面必须走第二步。
          return response({ ok: true, twoFactor: true, challenge: result.challenge })
        }
        // 登录成功后再拉一次 /me，让界面拿到余额与角色。
        const outcome = await session.loadAccount()
        if (!outcome.ok) return accountOutcomeResponse(session, outcome)
        return response({ ok: true, twoFactor: false, account: outcome.account })
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/login')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/login-totp', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        const challengeToken = typeof payload['challengeToken'] === 'string' ? payload['challengeToken'] : ''
        const code = typeof payload['code'] === 'string' ? payload['code'] : ''
        if (challengeToken.length === 0 || code.length === 0) {
          return response({ ok: false, message: '请填写验证码。' }, 400)
        }
        const session = await accountOf()
        await session.client.loginTotp({
          challenge_token: challengeToken,
          code,
          ...(payload['trustDevice'] === true ? { trust_device: true } : {}),
        })
        const outcome = await session.loadAccount()
        if (!outcome.ok) return accountOutcomeResponse(session, outcome)
        return response({ ok: true, account: outcome.account })
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/login-totp')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/register', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        const password = typeof payload['password'] === 'string' ? payload['password'] : ''
        if (password.length === 0) return response({ ok: false, message: '请填写密码。' }, 400)
        const session = await accountOf()
        await session.client.register({
          password,
          ...(typeof payload['username'] === 'string' && payload['username'].length > 0 ? { username: payload['username'] } : {}),
          ...(typeof payload['email'] === 'string' && payload['email'].length > 0 ? { email: payload['email'] } : {}),
        })
        // 注册**不自动登录**：上游注册响应是否带令牌未核实，假装已登录会误导用户。
        return response({ ok: true, signedIn: false })
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/register')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/account/logout', methods: ['POST'], requestBody: 'buffered',
    fetch: async () => {
      try {
        const session = await accountOf()
        await session.signOut()
        return response({ ok: true })
      } catch (error) { return failure(error) }
    },
  }), 'account: POST /api/qianshou/account/logout')
}
