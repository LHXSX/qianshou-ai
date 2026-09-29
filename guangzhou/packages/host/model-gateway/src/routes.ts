/**
 * 网关的 HTTP 面：把服务层暴露成接口，让手机与电脑都能用这条链路。
 *
 * 形态选择：**纯函数**（输入 `Request`，输出 `Response`），不自己监听端口。
 * 这样既能在宿主插件里挂 `requestBody: 'streaming'` 的路由，
 * 也能在一台真实 node:http 服务端上完整验证——而后者是本文件测试能证明"真流式"的前提。
 *
 * 两条路由：
 * - `POST /api/qianshou/ai/chat`：流式对话（SSE），走完整条链路（判定→预留→转发→结算）；
 * - `POST /api/qianshou/ai/status`：当前档位与剩余额度，给界面显示。
 *
 * 三条纪律：
 * 1. **身份由调用方注入**，不在这层解析令牌——宿主已经有账号会话，重复实现一套鉴权是隐患。
 * 2. **额度不足用 402**，不是 400：客户端能据此区分"你的请求有问题"与"你该付费了"。
 * 3. **错误响应绝不带内部信息**：不透出后端模型标识、不透出服务商原文、不透出密钥。
 */

import { spForUsage, type TierId } from './tiers.ts'
import { TIERS } from './tiers.ts'
import type { CreditLedger } from './ledger.ts'
import type { Principal } from './admin-routes.ts'
import type { Gateway, GatewayCall, GatewayHandlers } from './service.ts'

/**
 * **安全边界**（这部分讲清楚，因为它决定我们"不做什么"）。
 *
 * 这些路由坐在宿主 `connection` 的 `/api` 前缀路由之下，而那个前缀的**入口**已经
 * 做了 `requestRejection`——主机名/来源不在信任清单里就直接 401/403，
 * 根本进不到这里。也就是说边界是**监听地址（loopback / 受信主机）+ 已建立会话**，
 * 不是应用层密码。
 *
 * 这是有依据的行业做法，不是偷懒：本地 AI 运行时的通行形态就是"默认绑 localhost、
 * 无认证"，靠监听地址与文件系统权限划边界（Ollama 的 API key 认证到目前仍是
 * 一个**开着的功能请求**；NVIDIA 的官方工具在 Ollama 绑到 0.0.0.0 时给出警告，
 * 并要求前面挂认证代理）。跨机器才必须加认证。
 *
 * 还有一条更实在的理由：本机上**任何能发起这些请求的进程，本来就能读
 * `$DSH_HOME/.credentials.yaml` 里的上游密钥**（0600，同一个用户）。在这里加一层
 * 我们自己发明的令牌，安全收益接近零，却会多出一个"看起来有认证"的假象——
 * 那种假象比没有认证更危险，因为它会让人以为不必再加固。
 *
 * **将来必须改的前置条件**：一旦这些路由要跨机器提供（手机直连、给第三方用、
 * 暴露到公网），**必须先**做真正的令牌体系（签发、撤销、按账号隔离、审计），
 * 而不是把 loopback 当成身份。在那之前，"只服务本机"是这套路由的**部署契约**。
 */

/** 路由路径。 */
export const AI_CHAT_PATH = '/api/qianshou/ai/chat'
/** 额度状态路由。 */
export const AI_STATUS_PATH = '/api/qianshou/ai/status'
/**
 * **OpenAI 兼容**路由：给 DSH 自己的模型适配器（电脑端主对话）用。
 *
 * 路径刻意与 OpenAI 的形状一致（`{baseURL}/chat/completions`），这样宿主侧的适配器
 * 只要把 `baseUrl` 指向 `/api/qianshou/ai` 就能改走订阅链路，**不需要为它写专门的客户端**。
 * 而"共用一条链路"也正是要点：手机端与电脑端因此受**同一套**额度、并发与审计约束，
 * 不会出现一端有额度限制、另一端没有的漏洞。
 */
export const AI_COMPLETIONS_PATH = '/api/qianshou/ai/chat/completions'

/** 当前协议版本；响应里带上，便于将来并存。 */
export const AI_API_VERSION = 'qianshou.ai.v1'

/** 路由依赖。 */
export interface AiRoutesDeps {
  readonly gateway: Gateway
  readonly ledger: CreditLedger
  /**
   * 取某账号在某角色下的档位：**订阅优先，角色兜底**。
   *
   * 为什么角色要显式传进来（WP1 A-04/A-12）：早先这一层是个**进程级变量**
   * （`lastRole`：最近一次看到的角色），于是并发或多账号时 A 会拿 B 的档位准入。
   * 现在角色由 `authenticate` 本次返回的主体带过来，没有共享可变状态。
   * @param accountId - 账号。
   * @param role - 该账号的服务端角色。
   */
  readonly tierOf: (accountId: string, role: string) => TierId
  /**
   * 从请求里认出是哪个账户。
   * @param request - 原始请求。
   * **异步**：身份来自宿主侧的账号会话，那是异步读的。写死成同步会逼调用方
   * 用一个"最近一次"的缓存，而缓存错一次就可能是别人的额度被扣。
   * @returns 已验证主体；认不出返回 `null`（路由会回 401）。
   */
  readonly authenticate: (request: Request) => Promise<Principal | null> | Principal | null
  /**
   * 上一次"认不出身份"是不是**核验过程**的问题（上游账号服务抖动）。
   *
   * 为什么必须有它：三种认不出身份的原因，用户要做的动作完全不同——
   * 没登录 → 去登录；会话被吊销 → 重新登录；账号服务抖了一下 → 稍后再试。
   * 全都回 401 的后果实测过：本机适配器把 401 渲染成「API 密钥无效」，
   * 而订阅制用户没有密钥可填——报错把人引向一个不存在的输入框。
   * @returns 瞬时失败时返回 `true`；没登录/被吊销（或没有这个信息源）返回 `false`。
   */
  readonly verifyUnavailable?: () => boolean
  /** 生成调用标识；省略时用随机值。注入是为了测试可复现。 */
  readonly newCallId?: () => string
  /**
   * 首次见到某账号时按档位授予本周期额度。
   *
   * 为什么状态接口也要调用它：额度是**首次见到账号时**授予的（授予幂等）。
   * 如果只有对话路由触发授予，那么新用户打开额度面板会看到"剩余 0"——
   * 他会以为自己的订阅没生效。这是纯粹的显示缺陷，但足以让人怀疑产品坏了。
   * @param accountId - 账号。
   * @param tierId - 档位。
   */
  readonly onGrant?: (accountId: string, tierId: TierId) => void
  /**
   * 预解析：这次请求**实际**会用哪个前台名（可能因降级而不同）。
   *
   * 为什么要在开流前知道：降级线索得写进**响应头**（body 必须保持纯 OpenAI 形状，
   * 否则适配器解析失败），而响应头一旦发出就改不了。所以需要一个同步的预解析。
   * 它与网关内部的解析走**同一份控制台数据**，不是另算一遍。
   * @param publishedName - 用户请求的前台名。
   * @param tier - 本次请求的档位（与准入用的是同一个值）。
   * @returns 实际作答的前台名；解析不了时返回请求的那个。
   */
  readonly resolvePublished?: (publishedName: string, tier: TierId) => string
}

/** 一个 SSE 帧。 */
function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * 一条流的写入端。
 *
 * 两条路由（`/chat` 与 OpenAI 兼容的 `/chat/completions`）都需要同一件事：**推一次、
 * 关一次**，并且在客户端已经断开之后安静地失败（那时 `enqueue`/`close` 会抛）。
 * 分别写两遍就会有两份"关了没关"的判断，而它们迟早会不一致——抽取在这里，
 * 语义只有一份。
 * @param controller - 流的控制器。
 * @returns 推帧与收尾两个动作。
 */
function streamSink(controller: ReadableStreamDefaultController<Uint8Array>): {
  readonly push: (chunk: Uint8Array) => void
  readonly end: () => void
} {
  let closed = false
  return {
    push: (chunk) => {
      if (closed) return
      try { controller.enqueue(chunk) } catch { closed = true }
    },
    end: () => {
      if (closed) return
      closed = true
      try { controller.close() } catch { /* 已经关了 */ }
    },
  }
}

/**
 * 拒绝原因 → HTTP 状态码。
 *
 * 为什么值得分开：客户端要能**据此决定下一步**，而不是读到一句中文再猜。
 * - 402：该付费了（额度用完）——升级档位或等下个周期；
 * - 429：该等一下（并发超限）——不是钱的问题；
 * - 400：请求本身有问题——改一下就能过；
 * - 404/403：模型不存在 / 档位用不了这个模型。
 *
 * 注意：对话路由走 SSE，状态码在**开流时**就发出去了（200），
 * 所以这些码实际出现在 SSE 的 `error` 帧的 `status` 字段里，
 * 由客户端按同一套语义处理。
 * @param kind - 拒绝分类。
 * @returns 对应的 HTTP 状态码。
 */
export function statusForRejection(kind: string): number {
  switch (kind) {
    case 'no-credit': return 402
    case 'too-many-concurrent': return 429
    case 'context-too-long':
    case 'invalid-request': return 400
    case 'unknown-model': return 404
    case 'model-not-in-tier': return 403
    default: return 400
  }
}

/**
 * 认不出身份时的响应。
 *
 * 分两种，且**必须是两种**：核验过程抖动回 **503**（服务暂时不可用，稍后再试），
 * 其余回 **401**（请先登录）。把抖动也回 401 会让客户端把它当成凭据问题——
 * 本机适配器就是这么把 401 渲染成「API 密钥无效」的。
 * @param deps - 路由依赖（读 `verifyUnavailable`）。
 * @param shape - 错误正文形状：`ok` 给状态类路由，`error` 给 OpenAI 兼容路由。
 * @returns 503 或 401 响应。
 */
function identityUnknown(deps: { readonly verifyUnavailable?: () => boolean }, shape: 'ok' | 'error'): Response {
  if (deps.verifyUnavailable?.() === true) {
    return json({ ok: false, message: '账号服务暂时不可用，请稍后重试。' }, 503)
  }
  return shape === 'ok'
    ? json({ ok: false, message: '请先登录。' }, 401)
    : json({ error: { message: '请先登录。', type: 'unauthorized' } }, 401)
}

/** 统一 JSON 响应；带 no-store，避免额度与回答被中间层缓存。 */
function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-qianshou-ai-version': AI_API_VERSION },
  })
}

/** 读请求体；形状不对返回 `null`。 */
async function readBody(request: Request): Promise<{ readonly publishedName: string; readonly messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[]; readonly maxOutputTokens?: number } | null> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const body = parsed as Record<string, unknown>
  const publishedName = body['model']
  const rawMessages = body['messages']
  if (typeof publishedName !== 'string' || !Array.isArray(rawMessages)) return null
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  for (const item of rawMessages) {
    if (item === null || typeof item !== 'object') return null
    const entry = item as Record<string, unknown>
    const role = entry['role']
    const content = entry['content']
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null
    if (typeof content !== 'string') return null
    messages.push({ role, content })
  }
  if (messages.length === 0) return null
  const limit = body['maxOutputTokens']
  return {
    publishedName,
    messages,
    ...(typeof limit === 'number' && Number.isFinite(limit) ? { maxOutputTokens: limit } : {}),
  }
}

/**
 * 建一组路由处理器。
 * @param deps - 网关、账本、档位来源与身份解析。
 * @returns 两个处理器：对话（流式）与额度状态。
 */
export function createAiRoutes(deps: AiRoutesDeps): {
  readonly chat: (request: Request) => Promise<Response>
  readonly status: (request: Request) => Promise<Response>
} {
  const newCallId = deps.newCallId ?? (() => `call-${Math.random().toString(36).slice(2, 12)}`)

  return {
    status: async (request) => {
      const principal = await deps.authenticate(request)
      if (principal === null) return identityUnknown(deps, 'ok')
      const tierId = deps.tierOf(principal.accountId, principal.role)
      // 先把本周期额度落实，再读余额——否则新用户会看到"剩余 0"。
      deps.onGrant?.(principal.accountId, tierId)
      const tier = TIERS[tierId]
      const credit = deps.ledger.creditOf(principal.accountId, tierId)
      return json({
        ok: true,
        version: AI_API_VERSION,
        tier: { id: tier.id, label: tier.label, monthlyYuan: tier.monthlyYuan },
        credit: {
          remainingSp: credit.remainingMonthlySp,
          monthlySp: tier.monthlySp,
          usedInWindowSp: credit.usedInWindowSp,
          windowLimitSp: tier.windowFiveHourSp,
        },
        limits: { contextLimitTokens: tier.contextLimitTokens, concurrency: tier.concurrency },
      })
    },

    chat: async (request) => {
      const principal = await deps.authenticate(request)
      if (principal === null) return identityUnknown(deps, 'ok')

      const body = await readBody(request)
      if (body === null) return json({ ok: false, message: '请求格式不对。' }, 400)
      if (body.messages.length === 0) return json({ ok: false, message: '这条请求没有内容。' }, 400)

      const accountId = principal.accountId
      // 档位**按本次请求解析一次**：放行、结算、回执三条读法共用同一个值，
      // 免得升档/降档时准入用旧值、结算用新值（WP1 A-12）。
      const tierId = deps.tierOf(accountId, principal.role)
      // 与状态路由同一条授予路径：新用户在额度面板看到 0 之前先被授予。
      deps.onGrant?.(accountId, tierId)
      const callId = newCallId()
      const call: GatewayCall = {
        callId,
        accountId,
        publishedName: body.publishedName,
        messages: body.messages,
        tier: tierId,
        ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens }),
      }

      /**
       * 流式响应体。
       *
       * 用 `ReadableStream` + `start()` 里发起上游调用：这样下游可以边收边推，
       * 而不是先攒完再返回——攒完再返回就不叫流式了。
       */
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const { push, end } = streamSink(controller)

          const handlers: GatewayHandlers = {
            onDelta: (text) => { push(sse({ type: 'delta', text })) },
            onDone: (result) => {
              push(sse({
                type: 'done',
                model: result.publishedName,
                // 用户请求的名字一并回传：客户端据此判断"这次的回答是不是我点的那个模型"，
                // 并在降级时把 `downgradeNote` 显示出来。
                requestedModel: result.requestedName,
                chargedSp: result.chargedSp,
                downgraded: result.downgraded,
                ...(result.downgradeNote === null ? {} : { downgradeNote: result.downgradeNote }),
                usageSource: result.usageSource,
                credit: deps.ledger.creditOf(accountId, tierId),
              }))
              end()
            },
            onError: (failure) => {
              push(sse({
                type: 'error',
                kind: failure.kind,
                message: failure.message,
                // 客户端按 status 决定下一步（402 交钱 / 429 等一下 / 400 改请求），
                // 而不是读一句中文再猜。拒绝时还带上结构化原因与剩余额度快照。
                ...(failure.rejection === undefined
                  ? {}
                  : { status: statusForRejection(failure.rejection.kind), rejection: failure.rejection }),
                ...(failure.partialText === undefined ? {} : { partialText: failure.partialText }),
              }))
              end()
            },
          }

          const handle = deps.gateway.chat(call, handlers)
          // 客户端断开时中止上游调用，不让它继续烧钱。
          request.signal.addEventListener('abort', () => { handle.abort(); end() }, { once: true })
          void handle.completed
        },
      })

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-qianshou-ai-version': AI_API_VERSION,
        },
      })
    },
  }
}

/**
 * 建 **OpenAI 兼容**的对话处理器。
 *
 * 三条纪律：
 * 1. **只改模型名，不改别的**：帧里的 `model` 换成前台名（上游标识不出网关），
 *    `choices[0].delta` 一个字节都不动——适配器正是指着它写的，包括 `tool_calls` 的
 *    分片累加与 `reasoning_content`。顺手"整理"一下就会让 agent 的工具调用静默消失。
 * 2. **降级要说出来，但不能破坏 body**：用响应头
 *    `x-qianshou-model`（实际作答的前台名）与 `x-qianshou-requested`（用户请求的那个）
 *    表达"这次换了模型"。body 保持纯 OpenAI 形状，避免适配器解析失败。
 * 3. 失败按 SSE 帧表达（流已开），与 OpenAI 生态一致的错误帧形状。
 * @param deps - 网关、账本、档位来源与身份解析。
 * @returns 一个处理器。
 */
export function createAiCompletionsRoute(deps: AiRoutesDeps): {
  readonly completions: (request: Request) => Promise<Response>
} {
  const newCallId = deps.newCallId ?? (() => `call-${Math.random().toString(36).slice(2, 12)}`)

  return {
    completions: async (request) => {
      const principal = await deps.authenticate(request)
      if (principal === null) {
        // 与状态路由不同：这里保持 **JSON** 错误（不是 SSE），因为 OpenAI 生态的
        // 客户端都按状态码 + JSON 处理鉴权失败，先开流反而会让它们无从判断。
        return identityUnknown(deps, 'error')
      }
      const accountId = principal.accountId
      // 档位在这里**解析一次**，然后随 `GatewayCall` 一路带进准入与结算：
      // 早先这条路由用「订阅优先」的档位、而 `/chat` 与 `/status` 用「最近一次角色」
      // 的档位，同一个账号在两条路由上能拿到不同的额度（WP1 A-12）。
      const tierId = deps.tierOf(accountId, principal.role)
      deps.onGrant?.(accountId, tierId)

      let parsed: Record<string, unknown>
      try {
        parsed = await request.json() as Record<string, unknown>
      } catch {
        return json({ error: { message: '请求格式不对。', type: 'invalid_request_error' } }, 400)
      }
      const publishedName = parsed['model']
      const rawMessages = parsed['messages']
      if (typeof publishedName !== 'string' || !Array.isArray(rawMessages) || rawMessages.length === 0) {
        return json({ error: { message: '缺少 model 或 messages。', type: 'invalid_request_error' } }, 400)
      }
      // 只从 messages 里取角色与文本用于**估算上下文长度**；工具定义、采样参数等
      // 原样转发，不做解读。
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
      for (const item of rawMessages) {
        if (item === null || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        const role = entry['role']
        const content = entry['content']
        if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
        messages.push({ role, content: typeof content === 'string' ? content : '' })
      }
      const maxOutputTokens = parsed['max_tokens']
      const callId = newCallId()
      const encoder = new TextEncoder()

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const { push, end } = streamSink(controller)

          const handle = deps.gateway.completions(
            {
              callId,
              accountId,
              publishedName,
              messages,
              tier: tierId,
              ...(typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
              body: parsed,
            },
            {
              onFrame: (payload) => {
                if (payload === '[DONE]') {
                  push(encoder.encode('data: [DONE]\n\n'))
                  return
                }
                // 只替换 model 这一个字段：其余字节原样透传（含 tool_calls 的分片）。
                let out = payload
                try {
                  const frame = JSON.parse(payload) as Record<string, unknown>
                  if (typeof frame['model'] === 'string') {
                    frame['model'] = publishedName
                    out = JSON.stringify(frame)
                  }
                } catch {
                  // 不是 JSON 就原样发出去：上游发什么我们转什么，不猜。
                }
                push(encoder.encode(`data: ${out}\n\n`))
              },
              onDone: () => { end() },
              onError: (failure) => {
                push(encoder.encode(`data: ${JSON.stringify({
                  error: {
                    message: failure.message,
                    type: 'qianshou_error',
                    ...(failure.rejection === undefined
                      ? {}
                      : { code: failure.rejection.kind, status: statusForRejection(failure.rejection.kind) }),
                  },
                })}\n\n`))
                push(encoder.encode('data: [DONE]\n\n'))
                end()
              },
            },
          )
          request.signal.addEventListener('abort', () => { handle.abort(); end() }, { once: true })
          void handle.completed
        },
      })

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-qianshou-ai-version': AI_API_VERSION,
          /**
           * 降级线索走响应头：实际作答的前台名 + 用户请求的那个。
           *
           * **必须百分号编码**。HTTP 头是 ASCII 的，而我们的前台名是中文
           * （「千手·迅捷」），直接把中文放进头会让 `new Response` **当场抛异常**——
           * 实测抓到的真缺陷：修之前这条路由一开流就 500。客户端用
           * `decodeURIComponent` 解回来即可。
           *
           * 放头里而不是 body 里，是为了让 body 保持纯 OpenAI 形状：
           * 适配器按那个形状解析，多一个字段就可能导致整轮解析失败。
           */
          'x-qianshou-model': encodeURIComponent(deps.resolvePublished?.(publishedName, tierId) ?? publishedName),
          'x-qianshou-requested': encodeURIComponent(publishedName),
        },
      })
    },
  }
}

/** 把一次用量换算成 SP；供路由之外（例如对账）复用。 */
export { spForUsage }
