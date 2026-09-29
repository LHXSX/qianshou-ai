/**
 * 契约测试用的 `fetch` 打桩器。
 *
 * 为什么是打桩而不是真服务端：本包的契约测试**绝不允许碰真实账号**——注册会造号、
 * 登录会累计失败次数并可能触发限流和风控。所以所有请求都在这里被截住，
 * 并且把「客户端到底发了什么」逐字段记下来，让断言可以直接检查请求体映射。
 *
 * 这里刻意使用真实的 `Response` 对象而不是自造的形状：账号接口最容易踩的坑是
 * 「地址填错，返回了一整页 HTML」「2xx 但没有 JSON」这类**真实 Response 上的边界**，
 * 用假 Response 会把 `content-type`、`status`、`text()` 这些行为一起假掉。
 */
import type { FetchLike } from '../src/http.ts'

/** 一次被截获的请求。 */
export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  /** 请求体原文；无体的请求是 `null`。 */
  readonly body: string | null
  /** 已解析的请求体；无体或解析失败是 `null`。 */
  readonly json: Record<string, unknown> | null
  /** 传给 fetch 的 `credentials`；这条断言的是「cookie 通道有没有被打开」。 */
  readonly credentials: RequestCredentials | undefined
}

/** 打桩器。 */
export interface FetchStub {
  readonly fetch: FetchLike
  /** 按顺序记录每一次请求。 */
  readonly requests: RecordedRequest[]
  /** 最后一次请求；没有请求时抛错——用抛错而不是 `undefined`，避免断言悄悄跳过。 */
  readonly last: () => RecordedRequest
  /** 第 n 次请求（从 0 开始）。 */
  readonly at: (index: number) => RecordedRequest
  /** 剩余待返回的响应数量。 */
  readonly pending: () => number
}

/** 一个待返回的响应描述。 */
export type StubReply =
  | { readonly kind: 'json'; readonly status?: number; readonly body: unknown; readonly headers?: Record<string, string> }
  | { readonly kind: 'raw'; readonly status?: number; readonly text: string; readonly contentType?: string }
  /** 没有响应体（例如 204）。 */
  | { readonly kind: 'empty'; readonly status?: number }
  /** 读取响应体时抛错：验证「读不出来也不能崩成未处理异常」。 */
  | { readonly kind: 'unreadable'; readonly status?: number }
  /** 网络层直接失败：`fetch` 自己抛错。 */
  | { readonly kind: 'network-error'; readonly message?: string }
  /** 请求被 `AbortSignal` 取消。 */
  | { readonly kind: 'abort' }
  /**
   * 请求一直不返回，直到取消信号触发。
   *
   * 这是「慢服务器 + 客户端超时」的真实形态，也是唯一能走到超时分支的形态：
   * 立刻返回的桩永远跑不到 `setTimeout` 的取消回调。
   */
  | { readonly kind: 'hang' }

/**
 * 会**立刻**返回 `Response` 的桩形态。
 *
 * `'hang'` 被排除在外，不是因为它特殊，而是因为它在类型上就永远返回不了：
 * 它必须等取消信号，所以要 `await`，只能在异步的打桩 `fetch` 里处理。
 * 用 `Exclude` 把它挡在这里，`toResponse` 才是一个纯同步函数——
 * 否则「一个永远等不到头的 await」和「把描述变成 Response」是两件事，
 * 混在一个 switch 里就只能靠 switch 之后的兜底分支勉强通过类型检查。
 */
type ImmediateStubReply = Exclude<StubReply, { readonly kind: 'hang' }>

/** 把一条「立刻返回」的描述变成一个真实的 `Response`。 */
function toResponse(reply: ImmediateStubReply): Response {
  switch (reply.kind) {
    case 'json':
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers },
      })
    case 'raw':
      return new Response(reply.text, {
        status: reply.status ?? 200,
        headers: { 'content-type': reply.contentType ?? 'text/html' },
      })
    case 'empty':
      return new Response(null, { status: reply.status ?? 204 })
    case 'unreadable': {
      // 通过覆写 `text()` 模拟「连接中途断掉」：这是 `fetch` 成功但读体失败的真实情形。
      const response = new Response('{}', { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'text', {
        value: () => Promise.reject(new TypeError('terminated')),
      })
      return response
    }
    case 'network-error':
      throw new TypeError(reply.message ?? 'fetch failed')
    case 'abort': {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    // 联合类型将来加了新的「立刻返回」形态而这里忘了处理时，这一行会编译不过：
    // 收窄出的 `reply` 不再是 `never`，`satisfies never` 就会报错。
    default: {
      const unhandled = reply satisfies never
      throw new Error(`未处理的桩响应形态：${String(unhandled)}`)
    }
  }
}

/**
 * 造一个打桩的 fetch。
 * @param replies - 按顺序返回的响应；用完后继续请求会抛错（宁可炸也不要静默返回上一次的响应）。
 * @returns 打桩器。
 */
export function createFetchStub(replies: readonly StubReply[]): FetchStub {
  const queue = [...replies]
  const requests: RecordedRequest[] = []
  const fetch: FetchLike = async (input, init) => {
    // 尊重取消信号：真实的 fetch 在信号触发时会以 AbortError 拒绝。
    // 打桩里也必须这样做，否则「超时」与「用户取消」这两条路径根本走不到——
    // 而它们正是「不该误报成已取消 / 不该把用户登出」的关键分支。
    const signal = init?.signal
    if (signal?.aborted === true) {
      const aborted = new Error('This operation was aborted')
      aborted.name = 'AbortError'
      throw aborted
    }
    const body = init?.body
    const headerEntries: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders !== undefined) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headerEntries[key.toLowerCase()] = value
      }
    }
    requests.push({
      url: input,
      method: init?.method ?? 'GET',
      headers: headerEntries,
      body: typeof body === 'string' ? body : null,
      json: typeof body === 'string' ? JSON.parse(body) as Record<string, unknown> : null,
      credentials: init?.credentials,
    })
    const reply = queue.shift()
    if (reply === undefined) {
      throw new Error(`打桩 fetch 收到第 ${String(requests.length)} 次请求，但没有可返回的响应：${input}`)
    }
    if (reply.kind === 'hang') {
      const signal = init?.signal
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted === true) {
          const aborted = new Error('This operation was aborted')
          aborted.name = 'AbortError'
          reject(aborted)
          return
        }
        signal?.addEventListener('abort', () => {
          const aborted = new Error('This operation was aborted')
          aborted.name = 'AbortError'
          reject(aborted)
        }, { once: true })
      })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (reply.kind === 'abort') {
      // 真实 fetch 在信号已取消时会以 AbortError 拒绝；这里复现同一行为。
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    return toResponse(reply)
  }
  return {
    fetch,
    requests,
    last: () => {
      const last = requests[requests.length - 1]
      if (last === undefined) throw new Error('打桩 fetch 一次请求都没收到')
      return last
    },
    at: (index) => {
      const request = requests[index]
      if (request === undefined) throw new Error(`打桩 fetch 没有第 ${String(index)} 次请求`)
      return request
    },
    pending: () => queue.length,
  }
}

/** 造一个成功的令牌响应，形状照抄上游登录响应（含会误导人的 `agent_token`）。 */
export function tokenReply(options: {
  readonly access?: string
  readonly refresh?: string | null
  readonly expiresIn?: number
  readonly agentToken?: string
  readonly account?: unknown
  readonly status?: number
} = {}): StubReply {
  const access = options.access ?? 'access-token-value'
  const refresh = options.refresh === undefined ? 'refresh-token-value' : options.refresh
  return {
    kind: 'json',
    ...(options.status === undefined ? {} : { status: options.status }),
    body: {
      ok: true,
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: options.expiresIn ?? 7200,
      },
      // 上游把 `agent_token` 赋成 refresh token 的同一个值；客户端必须忽略它。
      ...(options.agentToken === undefined ? {} : { agent_token: options.agentToken }),
      account: options.account ?? {
        id: 42,
        username: 'qianshou-user',
        email: 'user@example.test',
        role: 'personal',
        status: 'active',
        balance: 12.5,
        created_at: '2026-01-01T00:00:00Z',
        last_login_at: null,
      },
    },
  }
}

/** 造一个上游失败业务包。 */
export function errorReply(options: {
  readonly status: number
  readonly code: string
  readonly message?: string
  readonly traceId?: string
  readonly errors?: readonly unknown[]
  readonly headers?: Record<string, string>
}): StubReply {
  return {
    kind: 'json',
    status: options.status,
    headers: options.headers ?? {},
    body: {
      ok: false,
      code: options.code,
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.errors === undefined ? {} : { errors: options.errors }),
      trace_id: options.traceId ?? 'trace-id-for-test',
    },
  }
}

/**
 * 上游校验错误包：**故意回显提交的请求体**，与实测到的上游行为一致
 * （`errors[0].input` 就是提交的 password）。测试据此确认客户端不会把它带出去。
 */
export function validationReply(submitted: unknown): StubReply {
  return errorReply({
    status: 422,
    code: 'VALIDATION_ERROR',
    message: '请求参数校验失败',
    errors: [{ type: 'string_too_short', loc: ['body', 'password'], msg: 'String should have at least 6 characters', input: submitted }],
  })
}

/** 内存版 refresh token 持久化端口，同时记录调用次数以便断言「有没有写盘」。 */
export function memoryRefreshStore(initial: string | null = null): {
  read: () => Promise<string | null>
  write: (token: string) => Promise<void>
  clear: () => Promise<void>
  value: () => string | null
  writes: () => number
  clears: () => number
} {
  let stored = initial
  let writes = 0
  let clears = 0
  return {
    read: async () => stored,
    write: async (token) => { stored = token; writes += 1 },
    clear: async () => { stored = null; clears += 1 },
    value: () => stored,
    writes: () => writes,
    clears: () => clears,
  }
}
