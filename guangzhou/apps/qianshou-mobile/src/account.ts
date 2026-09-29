/**
 * 手机端的账号接入层。
 *
 * 分工：`@deepseek-ai/dsh-client-account` 负责「怎么跟上游账号接口说话」，这里只负责
 * 三件宿主相关的事——**令牌存哪、cookie 能不能用、当前是谁**——再把状态推给界面。
 *
 * 两条刻意的取舍：
 *
 * 1. **页面走 `http://` 时不能假装 cookie 可用**。httpOnly cookie 在非安全上下文里会被
 *    浏览器拒绝种下，于是「刷新」会在无声无息中永远失败。所以这里如实探测协议，
 *    cookie 不可用时退化为请求体携带 refresh token，并把它存在本机——**并且界面要说明
 *    这一点**，不能一边退化成明文存储、一边告诉用户「已安全加密」。
 * 2. **长期凭据单独存一个键**，与连接设置（服务商、模型）分开：登出只需清这一个键。
 */
import type { WorkbenchClient } from './workbench.ts'
import {
  ACCOUNT_API_ORIGIN,
  createAccountClient,
  createSession,
  createTokenStore,
  type Account,
  type AccountClient,
  type AccountSession,
  type AccountSessionState,
  type RefreshTokenStore,
} from '@deepseek-ai/dsh-client-account'

/** 长期凭据在本机的键；登出时清它。 */
const REFRESH_KEY = 'qianshou.mobile.account.refresh.v1'
/** 账号信息（非密）的键：冷启动先把上次的昵称与余额显示出来，再去 `/me` 校正。 */
const ACCOUNT_KEY = 'qianshou.mobile.account.profile.v1'

/** 本机存储不可用时抛出；调用方据此给出「这台设备无法保存登录状态」的说明。 */
export class AccountStorageUnavailable extends Error {
  constructor() {
    super('这台设备无法保存登录状态（浏览器禁用了本地存储）')
    this.name = 'AccountStorageUnavailable'
  }
}

/**
 * 页面是否真的能收 httpOnly cookie。
 *
 * 判据是「安全上下文」：`https:` 一定是；`http:` 下只有 localhost 被浏览器当作安全来源。
 * 这条判断必须由宿主做，因为账号包本身不读 `location`（它也要能在打包后的 PC 进程里跑）。
 * @param location - 可注入的地址对象；省略时用当前页面。
 * @returns 能收 cookie 返回 `true`。
 */
export function cookiesAvailable(location?: { readonly protocol: string; readonly hostname: string }): boolean {
  const source = location ?? (typeof globalThis.location === 'undefined' ? null : globalThis.location)
  // 非浏览器宿主（打包后的进程、测试）当作可用：那里没有 cookie 策略这回事。
  if (source === null) return true
  if (source.protocol === 'https:') return true
  return source.hostname === 'localhost' || source.hostname === '127.0.0.1'
}

/** 本机长期凭据的读写；只用 localStorage，不引入任何依赖。 */
function refreshStore(): RefreshTokenStore {
  const map = (): Storage | null => {
    try {
      return globalThis.localStorage
    } catch {
      return null
    }
  }
  // 这三个方法在账号包里都是异步的（存储可能是异步宿主），所以这里也返回 Promise。
  return {
    read: async () => {
      const store = map()
      if (store === null) return null
      const value = store.getItem(REFRESH_KEY)
      return value === null || value.length === 0 ? null : value
    },
    write: async (token: string) => {
      const store = map()
      if (store === null) throw new AccountStorageUnavailable()
      store.setItem(REFRESH_KEY, token)
    },
    clear: async () => {
      const store = map()
      if (store === null) return
      store.removeItem(REFRESH_KEY)
    },
  }
}

/**
 * 电脑连接：能连上时，账号请求一律经它转发。
 *
 * `client` 允许先是 `null`：账号服务在启动时就建好了，而手机通常**更晚**才连上电脑
 * （用户要先填入口地址）。所以这里持有一个可变的槽，连上之后填进去即可——
 * 比"连上再重建账号服务"简单，也不会把已有会话状态丢掉。
 */
export interface PcRoute {
  /** 已经换到会话 cookie、可以发请求的工作台客户端；还没连上是 `null`。 */
  client: WorkbenchClient | null
}

/**
 * 宿主账号面的路径前缀。
 *
 * 与工作台同源部署时（手机端挂在 `https://<工作台>/mobile/` 下），这些路径就是**同源**的：
 * 浏览器不会拦，宿主进程直接调上游——既不需要 CORS，也不需要上游加白名单。
 */
export const HOST_ACCOUNT_PREFIX = '/api/qianshou/account'

/**
 * 上游路径 → 宿主路径的映射。
 *
 * **写成显式表而不是机械拼字符串**：上游是 `/api/v8/auth/login`，宿主是
 * `/api/qianshou/account/login`——中间那个 `auth/` 必须去掉；而 `my/profile` 对应的是
 * `/me`。机械拼会让每个路径都 404（我第一版就是这么错的，实测抓出来的）。
 *
 * 表里**没有**的路径一律不接管：宿主的账号面只实现了这几条，没实现的上游路径
 * （会话列表、TOTP 开关等）在这里落空比发出去再 404 更清楚。
 */
const HOST_PATHS: Readonly<Record<string, string>> = {
  '/api/v8/auth/login': `${HOST_ACCOUNT_PREFIX}/login`,
  '/api/v8/auth/login/totp': `${HOST_ACCOUNT_PREFIX}/login-totp`,
  '/api/v8/auth/register': `${HOST_ACCOUNT_PREFIX}/register`,
  '/api/v8/auth/logout': `${HOST_ACCOUNT_PREFIX}/logout`,
  '/api/v8/auth/me': `${HOST_ACCOUNT_PREFIX}/me`,
  '/api/v8/my/profile': `${HOST_ACCOUNT_PREFIX}/me`,
}

/**
 * 这个页面是不是由工作台自己提供的（同源部署）。
 *
 * 判据是「能不能在同源下看到宿主账号面」——用一次轻量探测代替猜地址：
 * 同源部署时它会回业务包，独立预览时会被预览服务回成 HTML（SPA 回退）或 404。
 * @param fetchImpl - 发请求用的实现。
 * @returns 同源可用返回 `true`。
 */
export async function hostAccountReachable(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${HOST_ACCOUNT_PREFIX}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const type = response.headers.get('content-type') ?? ''
    return response.status !== 404 && type.includes('application/json')
  } catch {
    return false
  }
}

/**
 * 同源路由：把账号请求发到**当前页面的源**下的宿主账号面。
 * @param fallback - 同源不可用时的兜底（直连上游）。
 * @returns 一个可交给账号客户端的 fetch。
 */
function sameOriginFetch(fallback: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    const path = `${url.pathname}${url.search}`
    const mapped = HOST_PATHS[url.pathname]
    if (mapped === undefined) return await fallback(input, init)
    return await fallback(`${mapped}${url.search}`, init)
  }) as typeof fetch
}

/** 把请求送到电脑上的宿主账号面。**
 *
 * 为什么需要它：上游的跨域白名单只放行 `localhost` 与它自己的域，
 * 手机端那个公网预览域会被浏览器**在请求发出前**拦掉——表现成「连不上账号服务器」。
 * 宿主进程自己发请求不受同源策略约束，所以经电脑走是手机上唯一能通的路。
 *
 * 请求 URL 由账号客户端按基址拼好（完整 URL），这里只取路径交给工作台客户端；
 * 会话 cookie 由工作台客户端保管，**不外流**。
 */
function pcRoutedFetch(route: PcRoute, fallback: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const client = route.client
    if (client === null || !client.connected) return await fallback(input, init)
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = `${new URL(raw).pathname}${new URL(raw).search}`
    const method = (init?.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
    let body: unknown
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = undefined }
    }
    return await client.request(path, { method, ...(body === undefined ? {} : { body }) }, init?.signal ?? new AbortController().signal)
  }) as typeof fetch
}

/** 界面上要显示的账号快照；**不含任何令牌**。 */
export interface AccountSnapshot {
  readonly state: AccountSessionState
  /** 当前账号；未登录时为 `null`。 */
  readonly account: Account | null
  /** 这台设备能不能用 httpOnly cookie；界面上要如实说明。 */
  readonly cookies: boolean
  /** 账号请求走哪条路：经电脑转发，还是直连上游。界面要如实说明。 */
  readonly route: 'same-origin' | 'via-pc' | 'direct'
}

/** 账号服务：一个进程一份，界面通过它订阅状态。 */
export interface AccountService {
  readonly snapshot: () => AccountSnapshot
  /** 订阅变化；返回取消订阅。 */
  readonly subscribe: (listener: (snapshot: AccountSnapshot) => void) => () => void
  readonly client: AccountClient
  readonly session: AccountSession
  /** 拉一次 `/me` 并记为已登录；登录/注册成功后调用。 */
  readonly loadAccount: (signal?: AbortSignal) => Promise<Account | null>
  /** 登出：清本机长期凭据并把状态置为未登录。 */
  readonly signOut: () => Promise<void>
  /**
   * 切到同源路由。
   *
   * 探测是异步的（要发一次请求），而账号服务在首次渲染时就建好了，
   * 所以用一个显式开关而不是构造参数——否则只能"先探测再建服务"，
   * 那会把首屏渲染卡在一次网络往返后面。
   */
  readonly useSameOrigin: () => void
}

/**
 * 建一个账号服务。
 * @param options - 可注入的 fetch、基址与地址对象，便于测试与宿主替换。
 * @returns 账号服务实例。
 */
export function openAccount(options: {
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly location?: { readonly protocol: string; readonly hostname: string }
  /**
   * 已连上的电脑。给了它，账号请求就经电脑转发——这是手机端能绕过上游跨域白名单的
   * **唯一**通路；没给（或电脑不可达）时才直连上游，但那时手机域会被浏览器拦掉。
   */
  readonly pc?: PcRoute
  /**
   * 同源可用：页面由工作台提供时，账号请求直接走相对路径的宿主账号面。
   * 这比「经电脑转发」更直接——没有跨域，也没有额外一跳。
   */
  readonly sameOrigin?: boolean
} = {}): AccountService {
  const cookies = cookiesAvailable(options.location)
  const store = refreshStore()
  const baseUrl = options.baseUrl ?? ACCOUNT_API_ORIGIN
  const direct: typeof fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  /** 同源开关；探测完成后由 `useSameOrigin()` 打开。 */
  let sameOrigin = options.sameOrigin === true
  const originFetch: typeof fetch = async (input, init) => {
    // 每次请求时看当时的开关：探测结果通常在首次请求之前就到了，但这里不假设顺序。
    const chosen = sameOrigin ? sameOriginFetch(direct) : direct
    return await chosen(input, init)
  }
  const fetchImpl = options.pc === undefined ? originFetch : pcRoutedFetch(options.pc, originFetch)

  const tokens = createTokenStore({
    cookiesAvailable: cookies,
    refreshStore: store,
  })
  const session = createSession({ baseUrl, fetch: fetchImpl, tokens })
  const client = createAccountClient({ baseUrl, fetch: fetchImpl, tokens })

  let account: Account | null = readCachedAccount()
  const listeners = new Set<(snapshot: AccountSnapshot) => void>()

  const snapshot = (): AccountSnapshot => ({
    state: session.state(),
    account,
    cookies,
    route: sameOrigin ? 'same-origin' : options.pc === undefined ? 'direct' : 'via-pc',
  })

  const publish = (): void => {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  // 状态机只有会话层一个驱动者；这里只负责在它变化时广播，并顺手落一次账号缓存。
  session.subscribe((state) => {
    if (state === 'signed-out' || state === 'expired') {
      account = null
      writeCachedAccount(null)
    }
    publish()
  })

  return {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    client,
    session,
    loadAccount: async (signal) => {
      const result = await session.requestProtected({ path: '/my/profile', operation: 'me', method: 'GET', ...(signal === undefined ? {} : { signal }) })
      if (!result.ok) {
        // 读不到账号不等于令牌失效：网络问题也会走到这里，所以只广播、不改状态。
        publish()
        return null
      }
      account = normalizeAccount(result.payload)
      session.markAuthenticated()
      writeCachedAccount(account)
      publish()
      return account
    },
    useSameOrigin: () => {
      sameOrigin = true
      publish()
    },
    signOut: async () => {
      try {
        await session.requestProtected({ path: '/auth/logout', operation: 'logout', method: 'POST' })
      } catch {
        // 上游登出失败不该把用户卡在登录态：本机凭据照清，状态照置。
      }
      await session.signOut()
      store.clear()
      account = null
      writeCachedAccount(null)
      publish()
    },
  }
}

/** 从 `/my/profile` 的响应里取账号；字段名以**账号包的类型**为准，取不到就不编。 */
function normalizeAccount(payload: unknown): Account | null {
  if (payload === null || typeof payload !== 'object') return null
  const source = payload as Record<string, unknown>
  // 上游可能把账号包在 `account`/`user`/`profile` 里，也可能直接铺在顶层；两种都认。
  const nested = [source['account'], source['user'], source['profile']].find(v => v !== null && typeof v === 'object')
  const fields = (nested ?? source) as Record<string, unknown>
  const id = fields['id']
  if (typeof id !== 'number' && typeof id !== 'string') return null
  const balance = fields['balance']
  return {
    id,
    username: typeof fields['username'] === 'string' ? fields['username'] : '',
    email: typeof fields['email'] === 'string' ? fields['email'] : '',
    role: typeof fields['role'] === 'string' ? fields['role'] : 'personal',
    status: typeof fields['status'] === 'string' ? fields['status'] : 'active',
    balance: typeof balance === 'string' || typeof balance === 'number' ? balance : null,
    created_at: typeof fields['created_at'] === 'string' ? fields['created_at'] : null,
    last_login_at: typeof fields['last_login_at'] === 'string' ? fields['last_login_at'] : null,
  }
}

/** 读上次缓存的账号（非密）；坏数据一律当没有。 */
function readCachedAccount(): Account | null {
  try {
    const raw = globalThis.localStorage.getItem(ACCOUNT_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Account) : null
  } catch {
    return null
  }
}

/** 写账号缓存；失败不影响使用。 */
function writeCachedAccount(value: Account | null): void {
  try {
    if (value === null) globalThis.localStorage.removeItem(ACCOUNT_KEY)
    else globalThis.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(value))
  } catch {
    /* 存储不可用：界面上仍显示本次会话的账号 */
  }
}

/** 配对二维码的前缀。带了它就能和别的二维码区分开，免得扫错。 */
export const PAIR_PREFIX = 'qianshou-pair:'

/**
 * 从扫到的文本里取出配对票据。
 *
 * 接受两种写法：带前缀的 `qianshou-pair:<ticket>`，和**裸票据**。
 * 后者是刻意的：二维码是电脑生成的，多一圈前缀就多一处不一致的可能。
 * @param text - 扫到的原文。
 * @returns 票据；认不出返回 `null`。
 */
export function ticketOf(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const value = trimmed.startsWith(PAIR_PREFIX) ? trimmed.slice(PAIR_PREFIX.length).trim() : trimmed
  return value.length === 0 ? null : value
}

/**
 * 用票据换取这台手机的绑定（配对引导）。
 *
 * 请求发到**同源**的宿主引导接口——手机的绑定不能由它自己发起（「手机不能自己授权自己」），
 * 所以票据是人扫进来的那个授权凭证，宿主验票、取真实登录账号、写绑定。
 * @param options - 票据、设备标识与注入项。
 * @returns 绑定结果；失败时给出可展示的中文说明。
 */
export async function redeemPairing(options: {
  readonly ticket: string
  readonly deviceId: string
  readonly fetchImpl?: typeof fetch
}): Promise<{ readonly ok: true; readonly binding: unknown } | { readonly ok: false; readonly message: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchImpl('/api/qianshou/mobile/pc-window/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: options.deviceId, ticket: options.ticket }),
    })
    const payload = await response.json() as { binding?: unknown; error?: { code?: string } }
    if (!response.ok) return { ok: false, message: PAIR_FAILURE_COPY[payload.error?.code ?? ''] ?? '配对没成功，请重新扫一次。' }
    return { ok: true, binding: payload.binding }
  } catch {
    return { ok: false, message: '连不上电脑。确认电脑开着、且这个页面是从电脑那边打开的。' }
  }
}

/**
 * 配对失败的说明。
 *
 * 三类票据失败分开写：拿错票要重扫、票过期要重新生成、撞太多次要等——
 * 用户的处置完全不同，合成一句「配对失败」等于把三件事都藏起来。
 */
export const PAIR_FAILURE_COPY: Readonly<Record<string, string>> = {
  PC_WINDOW_PAIR_UNKNOWN: '这个二维码不对（可能是旧的）。请在电脑上重新生成再扫。',
  PC_WINDOW_PAIR_EXPIRED: '二维码过期了（有效期 5 分钟）。请在电脑上重新生成。',
  PC_WINDOW_PAIR_TOO_MANY_ATTEMPTS: '试错次数太多，先歇一会儿再配对。',
  PC_WINDOW_NOT_SIGNED_IN: '电脑那边还没登录账号。先在电脑上登录，再重新生成二维码。',
  PC_WINDOW_NO_SESSION: '电脑那边没有打开的会话，没有可继续的上下文。',
  PC_WINDOW_BOOTSTRAP_DEVICE_REQUIRED: '本机标识丢了，重开一次应用再试。',
}
