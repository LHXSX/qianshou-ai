/**
 * 网关服务层：把三段串起来——**判定 → 预留 → 转发 → 结算**。
 *
 * 内核（`tiers.ts`）、账本（`ledger.ts`）、转发（`forward.ts`）各自都对，但只有串起来才叫能用。
 * 这一层要回答三个原本没人回答的问题：
 *
 * 1. **降级到底什么时候发生？** 「你选的模型不在你的档位」与「你的额度用完了」**是两件事**：
 *    前者是选错了（该退回该档位最好的模型），后者是花完了（该降级或停）。混在一起会让用户
 *    看到"额度不足"但其实是选错模型——最难查的那种误导。
 * 2. **用量拿不到怎么办？** 上游不给 `usage` 时**必须**有兜底估算，否则会出现"用了但不计费"的缝隙。
 *    兜底用**模型无关的估算**（中日韩 1 字符≈1 token、其余 4 字符≈1 token），不是"字符数÷4"。
 * 3. **失败怎么收尾？** 调用失败必须把预留**全额退回**：用户没拿到回答就不该付钱。
 *    而"部分到达后失败"是个真实的中间态——已产生的输出照样计费，但要说清。
 */

import { createConcurrencyGuard, DEFAULT_BACKEND_STREAM_CAP, type ConcurrencyGuard } from './concurrency.ts'
import { createBackendHealth, type BackendHealth } from './backend-health.ts'
import { forwardRaw, RawForwardFailure } from './raw-forward.ts'
import { BACKENDS, admit, estimateTokens, spForUsage, type Admission, type BackendModel, type GatewayMessage, type Rejection, type Tier, type TierId } from './tiers.ts'
import { PUBLISHED_MODELS, TIERS, type PublishedModel } from './tiers.ts'
import type { CreditLedger } from './ledger.ts'
import type { RoutingConsole } from './routing.ts'
import { forwardStream, type ForwardFailure, type ProviderUsage } from './forward.ts'

/** 网关对外的一次调用。 */
export interface GatewayCall {
  readonly callId: string
  readonly accountId: string
  /** 用户选的**前台模型名**。 */
  readonly publishedName: string
  readonly messages: readonly GatewayMessage[]
  /** 调用方希望的输出上限；会被模型上限封顶。 */
  readonly maxOutputTokens?: number
  /**
   * 本次调用的档位。
   *
   * 由**调用方按已认证主体**解析好传进来（见 `routes.ts`）：网关内部只认这个值，
   * 不再自己去猜"这个账号现在是什么档位"。早先网关自己按进程级的"最近一次角色"取，
   * 并发时 A 会拿 B 的档位准入（WP1 A-04/A-12）。
   * 省略时退回 `deps.tierOf(accountId)`，只为兼容既有调用方。
   */
  readonly tier?: TierId
  readonly signal?: AbortSignal
}

/** 网关事件。 */
export interface GatewayHandlers {
  /** 正文增量。 */
  readonly onDelta: (text: string) => void
  /**
   * 正常收尾。
   * @param result - 谁作回答了、花了多少、是否发生降级。
   */
  readonly onDone: (result: {
    /** **实际作答**的前台名字（降级后就不是用户请求的那个了）。 */
    readonly publishedName: string
    /** 用户请求的前台名字。与 `publishedName` 不同就说明发生了替换。 */
    readonly requestedName: string
    readonly chargedSp: number
    /** 是否换了更轻的模型。 */
    readonly downgraded: boolean
    /**
     * 降级时给用户看的一句话；没降级就是 `null`。
     *
     * 为什么必须说出来：用户买的是「千手·强力」，如果因为额度不足被换成轻量模型
     * 却什么都不显示，他花的那份钱就没有兑现，而且他自己不会知道。
     * **换模型可以不惊动用户（不必解释后端是谁），但降级这件事必须可见。**
     */
    readonly downgradeNote: string | null
    /** 用量是权威回执还是本地估算。 */
    readonly usageSource: 'provider' | 'estimated'
  }) => void
  /**
   * 这次没成。
   * @param failure - 面向用户的说明 + 机器可读的分类。
   */
  readonly onError: (failure: GatewayFailure) => void
}

/** 网关层的失败：机器可读分类 + 可展示文案。 */
export interface GatewayFailure {
  readonly kind: 'rejected' | ForwardFailure['kind']
  readonly message: string
  /** 被拒时带上结构化原因（例如上下文超限、额度不足）。 */
  readonly rejection?: Rejection
  /** 已经产生的输出（部分到达后失败时不为空）。 */
  readonly partialText?: string
}

/** 网关依赖。 */
export interface GatewayDeps {
  readonly ledger: CreditLedger
  /** 取某个账户当前的档位。 */
  readonly tierOf: (accountId: string) => TierId
  /** 路由控制台；给了它，后端顺序与灰度就由控制台决定，而不是静态声明。 */
  readonly routing?: RoutingConsole
  /** 时钟；测试注入。 */
  readonly now?: () => number
  /** 转发函数；默认用真实的 `forwardStream`。 */
  readonly forward?: typeof forwardStream
  /** 透传函数（OpenAI 兼容那条路）；默认用真实的 `forwardRaw`。 */
  readonly rawForward?: typeof forwardRaw
  /**
   * 后端健康跟踪；省略时自建一个。
   *
   * 它的存在是为了让**声明的备用后端真的会被用上**：控制台给一个前台名字绑的是
   * 有序后端列表，而早先运行时只取 `backends[0]`——后面那些永远不会被调用。
   */
  readonly backendHealth?: BackendHealth
  /** 并发上限执行器；省略时自建一个（单进程内存计数）。 */
  readonly concurrency?: ConcurrencyGuard
  /**
   * 我们允许同时向上游打开多少条流。
   *
   * **不是**后端公布的并发数（那是我们整个平台在上游的账号级容量）。
   * 真按 2500 放行，一次尖峰会把上游连接拉满，结果是我们整体开始被拒，
   * 用户看到的是一连串失败。取一个远低于它的进程内上限，让过载表现成
   * "一部分请求被礼貌挡住"，而不是"所有人都坏掉"。
   */
  readonly backendStreamCap?: number
  /** 整个进程的并发总闸；省略时不设总闸（只靠后端容量）。 */
  readonly globalStreamCap?: number
  /** 默认的转发配置（端点 + 取密钥的方式）。 */
  readonly forwardConfig: ForwardConfig
  /**
   * 取某个后端**自己的**转发配置（端点 + 密钥）。
   *
   * 省略时退回 `forwardConfig`——但那只在"所有后端同一家厂商"时才成立。
   * 一旦后端来自不同厂商（DeepSeek 与阿里云），必须按后端取，
   * 否则请求会发给错误的厂商，而上游只会说"模型不存在"。
   */
  readonly forwardConfigFor?: (backend: BackendModel) => ForwardConfig
}

/** 一个后端的转发配置：端点 + 取密钥的方式（可注入 fetch 与超时）。 */
export interface ForwardConfig {
  readonly baseUrl: string
  readonly apiKey: () => string | null | Promise<string | null>
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/** 一次调用的句柄：可以中止，也可以等它结束。 */
export interface GatewayCallHandle {
  readonly abort: () => void
  readonly completed: Promise<void>
}

/**
 * 一次 **OpenAI 兼容**调用的入参。
 *
 * 除了网关调用本身，还带上**要原样透传**的请求体：适配器认识的字段（工具定义、采样参数、
 * `reasoning` 开关…）我们不做解读，只负责转发——少一个字段就可能让工具调用静默消失。
 */
export type RawGatewayCall = GatewayCall & { readonly body: Readonly<Record<string, unknown>> }

/** 网关。 */
export interface Gateway {
  /**
   * 走一次完整流程。
   * @param call - 调用输入。
   * @param handlers - 事件回调。
   * @returns 可中止的句柄。
   */
  readonly chat: (call: GatewayCall, handlers: GatewayHandlers) => GatewayCallHandle
  /**
   * **OpenAI 兼容**的一次调用：给 DSH 自己的模型适配器（也就是电脑端主对话）用。
   *
   * 与 `chat` 的差别只在**流的形状**：`chat` 把上游帧解析成"正文增量"，
   * 而这里把帧**原样**交出去，因为适配器要看完整的 `choices[0].delta`——
   * 包括 `reasoning_content`、按 index 分片累加的 `tool_calls`、`finish_reason`。
   * 用有损形状接上去，agent 的工具调用会**静默消失**（表现为"接上了但不会干活"）。
   *
   * 准入、并发、额度、结算、审计与 `chat` **完全共用同一套**：一条链路两副面孔，
   * 避免出现"手机端受额度约束、电脑端不受"这种漏洞。
   */
  readonly completions: (call: RawGatewayCall, handlers: RawGatewayHandlers) => GatewayCallHandle
}

/**
 * 该档位下最好的可用模型（按 `PUBLISHED_MODELS` 声明顺序）。
 * @param tier - 档位。
 * @returns 可用的前台模型；没有则 `null`。
 */
function bestFor(tier: Tier): PublishedModel | null {
  return PUBLISHED_MODELS.find(model => model.tiers.includes(tier.id)) ?? null
}

/**
 * 把「用户要的模型」解析成「这次实际能用哪个」。
 *
 * 三种情况分开处理，因为它们对用户的意义完全不同：
 * - 名字存在且该档位能用 → 照用，不算降级；
 * - 名字存在但该档位不能用 → **退回该档位最好的模型**，并按降级告知（用户只是选错了模型）；
 * - 名字根本不存在 → 拒绝（这是调用方的 bug，不该静默替它选一个）。
 * @param requested - 用户要的前台模型名。
 * @param tier - 账户档位。
 * @returns 实际使用的模型与是否降级，或拒绝。
 */
export function resolveModel(requested: string, tier: Tier): { readonly model: PublishedModel; readonly downgraded: boolean } | Rejection {
  const model = PUBLISHED_MODELS.find(candidate => candidate.publishedName === requested)
  if (model === undefined) {
    return { ok: false, kind: 'unknown-model', message: '这个模型不存在。' }
  }
  if (model.tiers.includes(tier.id)) return { model, downgraded: false }
  const fallback = bestFor(tier)
  if (fallback === null) {
    return { ok: false, kind: 'model-not-in-tier', message: `${tier.label}暂时没有可用的模型。` }
  }
  return { model: fallback, downgraded: true }
}

/**
 * 解析「此刻这个前台名字意味着哪些后端」。
 *
 * **两份职责分清楚**：`tiers.ts` 的目录决定**档位资格与输出上限**（那是产品属性，随档位走）；
 * 控制台决定**后端与灰度**（那是运维属性，随部署走）。合成一处会让"改定价"和"换模型"
 * 变成同一件事，而它们本该由不同的人在不同时间做。
 * @param deps - 控制台（可选）与时刻来源。
 * @param requested - 用户要的前台名字。
 * @param tier - 账户档位。
 * @param requestKey - 请求标识（灰度分流）。
 * @returns 实际使用的模型、后端键与是否降级，或拒绝。
 */
export function resolveModelAt(
  deps: { readonly routing?: RoutingConsole; readonly now?: () => number },
  requested: string,
  tier: Tier,
  requestKey: string,
): { readonly model: PublishedModel; readonly backendKeys: readonly string[]; readonly downgraded: boolean } | Rejection {
  const catalogue = resolveModel(requested, tier)
  // 判别式是"**有没有** `ok` 字段"：`Rejection` 有 `ok: false`，成功形状没有 `ok`
  // （所以不能写 `catalogue.ok === false`——那在联合类型上取不到字段）。
  if ('ok' in catalogue) return catalogue
  const chosen = catalogue

  // 没接控制台时退回静态声明的后端顺序——保持既有行为，也让"没接"这件事不改变结果。
  if (deps.routing === undefined) {
    return { model: chosen.model, backendKeys: chosen.model.backends, downgraded: chosen.downgraded }
  }

  const at = (deps.now ?? (() => Date.now()))()
  const resolved = deps.routing.modelAt(chosen.model.publishedName, at, requestKey)
  if (!resolved.ok) {
    // 控制台说没有可用后端（或已下线）→ 如实拒绝，不偷偷用一个它没批准的模型。
    return { ok: false, kind: 'unknown-model', message: resolved.message }
  }
  return { model: chosen.model, backendKeys: resolved.backendKeys, downgraded: chosen.downgraded }
}

/** OpenAI 兼容调用的回调。 */
export interface RawGatewayHandlers {
  /** 上游帧的 payload（`data:` 之后的内容，含 `[DONE]`）。 */
  readonly onFrame: (payload: string) => void
  /** 收尾；`expiredCredit` 是结算后的额度快照，供客户端显示。 */
  readonly onDone: (result: { readonly chargedSp: number; readonly usageSource: 'provider' | 'estimated'; readonly credit?: unknown }) => void
  readonly onError: (failure: GatewayFailure) => void
}

/**
 * 建一个网关。
 * @param deps - 账本、档位来源与转发配置。
 * @returns 网关实例。
 */
export function createGateway(deps: GatewayDeps): Gateway {
  const forward = deps.forward ?? forwardStream
  const rawForward = deps.rawForward ?? forwardRaw
  const concurrency = deps.concurrency ?? createConcurrencyGuard()
  const backendStreamCap = deps.backendStreamCap ?? DEFAULT_BACKEND_STREAM_CAP
  const health = deps.backendHealth ?? createBackendHealth()

  return {
    chat: (call, handlers) => {
      const controller = new AbortController()
      const signal = call.signal ?? controller.signal
      // 档位：调用方给的一律优先；没给才退回注入的解析函数。
      const tierId = call.tier ?? deps.tierOf(call.accountId)
      const tier = TIERS[tierId]

      const resolved = resolveModelAt(
        deps.routing === undefined ? {} : { routing: deps.routing, ...(deps.now === undefined ? {} : { now: deps.now }) },
        call.publishedName,
        tier,
        call.callId,
      )
      if ('ok' in resolved) {
        handlers.onError({ kind: 'rejected', message: resolved.message, rejection: resolved })
        return { abort: () => { /* 还没开始 */ }, completed: Promise.resolve() }
      }
      const chosen = resolved

      /**
       * **先占并发位**，再算准入，最后原子预留。三步的顺序都是有理由的：
       *
       * - 并发位在最前：它管的是"瞬时占用"，与额度无关。超了就直接拒，**不碰额度**
       *   （否则一次被拒的请求会在五小时窗口里留下痕迹）。
       * - 准入在预留之前：先预留再判定会在判定失败时白预留一次（还要退回去）。
       * - 「读额度 + 预留」必须在**同一次同步执行**里完成，中间不许 `await`——
       *   否则两个并发请求会同时读到同一份余额。`admitAndReserve` 就是为这件事存在的。
       */
      const slot = concurrency.acquire(call.accountId, tier.concurrency)
      if (!slot.ok) {
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: slot.message }
        handlers.onError({ kind: 'rejected', message: slot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      /** 并发位必须**恰好**放一次：成功、失败、被后续判定拒绝、客户端中止都要放。 */
      let slotReleased = false
      const releaseSlot = (): void => {
        if (slotReleased) return
        slotReleased = true
        slot.release()
      }

      /**
       * 第二、三道闸门：**后端容量**与**进程总闸**。
       *
       * 顺序：账户档位 → 后端容量 → 总闸 → 额度判定。
       * 理由与账户闸门一致：容量问题与钱无关，先挡住就**不碰额度**。
       * 这两道闸门保护的是我们自己的整体可用性——真按后端公布的 2500 放行，
       * 一次尖峰就会让我们整体开始被上游拒。
       */
      const backendSlot = concurrency.acquireBackend(chosen.backendKeys[0] ?? 'unknown', backendStreamCap)
      if (!backendSlot.ok) {
        releaseSlot()
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: backendSlot.message }
        handlers.onError({ kind: 'rejected', message: backendSlot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      const globalSlot = deps.globalStreamCap === undefined
        ? { ok: true as const, release: () => { /* 没设总闸 */ } }
        : concurrency.acquireGlobal(deps.globalStreamCap)
      /** 三道闸门必须**恰好**各放一次。 */
      const releaseAll = (): void => {
        releaseSlot()
        backendSlot.release()
        if (globalSlot.ok) globalSlot.release()
      }
      if (!globalSlot.ok) {
        releaseSlot()
        backendSlot.release()
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: globalSlot.message }
        handlers.onError({ kind: 'rejected', message: globalSlot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }

      const outcome = deps.ledger.admitAndReserve({
        callId: call.callId,
        accountId: call.accountId,
        // 预留要记住档位：结算时才知道该把这笔钱记到哪份额度上。
        tier: tierId,
        plan: credit => admit(
          {
            accountId: call.accountId,
            tier: tierId,
            publishedName: chosen.model.publishedName,
            messages: call.messages,
            ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
          },
          credit,
        ),
        reservedSpOf: value => (value.ok ? value.reservedSp : null),
      })

      if (!outcome.ok) {
        releaseAll()
        handlers.onError({ kind: 'rejected', message: outcome.message, rejection: outcome })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      const granted: Admission = outcome

      // 后端由**控制台的解析结果**决定（含灰度回落），而不是模型上静态写的那几个。
      const backends = chosen.backendKeys
        .map(key => BACKENDS[key])
        .filter((backend): backend is BackendModel => backend !== undefined)
      if (backends.length === 0) {
        deps.ledger.release(call.callId)
        releaseAll()
        handlers.onError({ kind: 'rejected', message: '这个模型暂时没有可用的后端。' })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }

      // 上面已经确认 `backends` 非空，所以首项必然存在。
      /**
       * 按健康状态挑后端：优先用列表里第一个**不在冷却中**的。
       *
       * 早先硬取 `backends[0]`，所以控制台上配的备用后端从来没被调用过——
       * "主后端故障时按顺序落到备用"是一句空话，而用户会一直卡在坏掉的上游上。
       */
      const picked = health.pick(backends)
      const backend = picked.backend

      // 已到达的正文；失败时要如实交回，不能假装什么都没发生。
      let partial = ''
      let settled = false

      /** 结算收尾：无论成功失败只走一次。 */
      const finish = (usage: ProviderUsage | null, forwarded: ForwardFailure | null): void => {
        if (settled) return
        settled = true
        releaseAll()
        if (forwarded !== null) {
          /**
           * **只退没花掉的部分，已经产生的成本照收。**
           *
           * 早先这里是 `release(callId)`——**全额退回且不留记录**。那是一个可被利用的漏洞：
           * 客户端中途断开时，上游已经把发过去的输入 token 都算过费了、也生成了一部分输出，
           * 而我们一分不收、**这次调用还不进账本**——于是月度上限与五小时刹车同时看不到它，
           * "发个大请求、200 毫秒后断开"可以无限重复白用。
           * （LiteLLM 在取消路径上也是按 input_cost 结算的，不是全退。）
           *
           * 判据分两种：
           * - **确认没花到我们自己的钱**（密钥没配、上游拒绝、连接都没建起来）→ 全额退回；
           * - **可能已经产生成本**（客户端取消、上游中途断流、超时）→ 按"已发出的输入 +
           *   已收到的正文"结算，其余退回。
           *
           * 刻意**不写完整调用记录**（用 `settlePartial`）：这是一次未完成的调用，
           * 记成完整调用会让对账看到不存在的请求。
           */
          const mayHaveCost = forwarded.kind === 'aborted' || forwarded.kind === 'unreachable' || forwarded.kind === 'invalid-response'
          if (!mayHaveCost) {
            deps.ledger.release(call.callId)
          } else {
            // 输入：按**实际请求体**估（已经发给上游了，这笔钱跑不掉）。
            const inputTokens = call.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
            // 输出：只算**真的到达客户端**的那部分。
            const outputTokens = partial.length === 0 ? 0 : estimateTokens(partial)
            deps.ledger.settlePartial({ callId: call.callId, sp: spForUsage(backend, { inputTokens, outputTokens }) })
          }
          handlers.onError({
            kind: forwarded.kind,
            message: forwarded.message,
            ...(partial.length === 0 ? {} : { partialText: partial }),
          })
          return
        }
        // 权威用量优先；拿不到就用**模型无关的估算**补齐——
        // 若这里按"字符数÷4"估，中文会被低估约 4 倍，直接少收钱。
        const source: 'provider' | 'estimated' = usage !== null && usage.completionTokens > 0 ? 'provider' : 'estimated'
        const finalUsage = source === 'provider'
          ? usage as ProviderUsage
          : {
            promptTokens: call.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
            completionTokens: estimateTokens(partial),
          }
        const charged = spForUsage(backend, {
          inputTokens: finalUsage.promptTokens,
          outputTokens: finalUsage.completionTokens,
        })
        const outcome = deps.ledger.settle({
          callId: call.callId,
          sp: charged,
          call: {
            tier: tierId,
            publishedName: chosen.model.publishedName,
            backendKey: backend.id,
            inputTokens: finalUsage.promptTokens,
            outputTokens: finalUsage.completionTokens,
          },
        })
        handlers.onDone({
          publishedName: chosen.model.publishedName,
          requestedName: call.publishedName,
          chargedSp: outcome.chargedSp,
          downgraded: chosen.downgraded,
          // 降级必须说出来：用户买的是哪个档位、拿到的是哪个模型，两者不同就要讲清楚。
          downgradeNote: chosen.downgraded
            ? `「${call.publishedName}」在${tier.label}里用不了，这次由「${chosen.model.publishedName}」作答。`
            : null,
          usageSource: source,
        })
      }

      /**
       * 用**这个后端自己的**端点与密钥，而不是全局那一份。
       *
       * 早先全局一份 baseUrl/apiKey 时，"换后端"只改了模型名、请求仍发给原来那家，
       * 表现为上游报"模型不存在"——看起来像接上了，实际从来没通过。
       */
      const backendForward = deps.forwardConfigFor?.(backend) ?? deps.forwardConfig
      const stream = forward(
        backendForward,
        {
          model: backend.id,
          messages: call.messages,
          maxOutputTokens: granted.maxOutputTokens,
          signal,
        },
        {
          onDelta: (text) => { partial += text; handlers.onDelta(text) },
          onDone: (usage) => {
            // 成功即清零：冷却期满后的第一次真实请求就是探针。
            health.recordSuccess(backend.id)
            finish(usage.completionTokens > 0 ? usage : null, null)
          },
          onError: (failure) => {
            // 失败计数；达到阈值就冷却，让下一次请求直接落到备用后端。
            health.recordFailure(backend.id)
            finish(null, failure)
          },
        },
      )

      return { abort: () => { stream.abort(); controller.abort() }, completed: stream.completed }
    },

    /**
     * OpenAI 兼容的一次调用。准入/并发/额度/结算/审计与 `chat` 走**同一套代码路径**，
     * 只有流的形状不同（这里原样透传）。
     *
     * 重复这一段是有意的：把它抽成共享函数会让 `chat` 也承担"透传"的复杂度，
     * 而两边的失败语义并不一样（`chat` 失败时要交回已产出的正文，
     * 这里失败时上游帧已经发出去了、只能如实告知）。**同一条纪律，两种表达**。
     */
    completions: (call, handlers) => {
      const controller = new AbortController()
      const signal = call.signal ?? controller.signal
      // 与 `chat` 同一条规则：调用方解析好的档位优先。
      const tierId = call.tier ?? deps.tierOf(call.accountId)
      const tier = TIERS[tierId]

      const resolved = resolveModelAt(
        deps.routing === undefined ? {} : { routing: deps.routing, ...(deps.now === undefined ? {} : { now: deps.now }) },
        call.publishedName,
        tier,
        call.callId,
      )
      if ('ok' in resolved) {
        handlers.onError({ kind: 'rejected', message: resolved.message, rejection: resolved })
        return { abort: () => { /* 还没开始 */ }, completed: Promise.resolve() }
      }
      const chosen = resolved

      // 与 `chat` 同样的三道闸门，顺序也相同：账户档位 → 后端容量 → 进程总闸 → 额度。
      const slot = concurrency.acquire(call.accountId, tier.concurrency)
      if (!slot.ok) {
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: slot.message }
        handlers.onError({ kind: 'rejected', message: slot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      const backendSlot = concurrency.acquireBackend(chosen.backendKeys[0] ?? 'unknown', backendStreamCap)
      if (!backendSlot.ok) {
        slot.release()
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: backendSlot.message }
        handlers.onError({ kind: 'rejected', message: backendSlot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      const globalSlot = deps.globalStreamCap === undefined
        ? { ok: true as const, release: () => { /* 没设总闸 */ } }
        : concurrency.acquireGlobal(deps.globalStreamCap)
      let released = false
      const releaseAll = (): void => {
        if (released) return
        released = true
        slot.release()
        backendSlot.release()
        if (globalSlot.ok) globalSlot.release()
      }
      if (!globalSlot.ok) {
        releaseAll()
        const rejection: Rejection = { ok: false, kind: 'too-many-concurrent', message: globalSlot.message }
        handlers.onError({ kind: 'rejected', message: globalSlot.message, rejection })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }

      const outcome = deps.ledger.admitAndReserve({
        callId: call.callId,
        accountId: call.accountId,
        // 预留要记住档位：结算时才知道该把这笔钱记到哪份额度上。
        tier: tierId,
        plan: credit => admit(
          {
            accountId: call.accountId,
            tier: tierId,
            publishedName: chosen.model.publishedName,
            // 上下文长度按请求体里的 messages 估；形状由调用方保证（它转发的是 OpenAI 兼容体）。
            messages: call.messages,
            ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
          },
          credit,
        ),
        reservedSpOf: value => (value.ok ? value.reservedSp : null),
      })
      if (!outcome.ok) {
        releaseAll()
        handlers.onError({ kind: 'rejected', message: outcome.message, rejection: outcome })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      const granted: Admission = outcome

      const backends = chosen.backendKeys
        .map(key => BACKENDS[key])
        .filter((backend): backend is BackendModel => backend !== undefined)
      if (backends.length === 0) {
        deps.ledger.release(call.callId)
        releaseAll()
        handlers.onError({ kind: 'rejected', message: '这个模型暂时没有可用的后端。' })
        return { abort: () => { /* 未开始 */ }, completed: Promise.resolve() }
      }
      /**
       * 按健康状态挑后端：优先用列表里第一个**不在冷却中**的。
       *
       * 早先硬取 `backends[0]`，所以控制台上配的备用后端从来没被调用过——
       * "主后端故障时按顺序落到备用"是一句空话，而用户会一直卡在坏掉的上游上。
       */
      const picked = health.pick(backends)
      const backend = picked.backend

      let settled = false
      const finish = (usage: ProviderUsage | null, failure: RawForwardFailure | null): void => {
        if (settled) return
        settled = true
        releaseAll()
        if (failure !== null) {
          /**
           * 与 `chat` 同一条纪律：**确认没花钱才全退，否则按已产生的成本结算**。
           * 两条路必须一致——只在一条上堵住，从另一条进来照样能白用。
           */
          const mayHaveCost = failure.kind === 'aborted' || failure.kind === 'unreachable' || failure.kind === 'invalid-response'
          if (!mayHaveCost) {
            deps.ledger.release(call.callId)
          } else {
            const inputTokens = call.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
            deps.ledger.settlePartial({ callId: call.callId, sp: spForUsage(backend, { inputTokens, outputTokens: 0 }) })
          }
          handlers.onError({ kind: failure.kind, message: failure.message })
          return
        }
        const finalUsage: ProviderUsage = usage !== null && (usage.promptTokens > 0 || usage.completionTokens > 0)
          ? usage
          : {
            // 上游没给回执：用**模型无关的估算**补齐，且如实标注来源。
            // 按"字符数÷4"估会把中文低估约 4 倍，那等于少收钱。
            promptTokens: call.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
            completionTokens: 0,
          }
        const source: 'provider' | 'estimated' = usage !== null && (usage.promptTokens > 0 || usage.completionTokens > 0) ? 'provider' : 'estimated'
        // `spForUsage` 收的是 {inputTokens, outputTokens}，而上游回执用 prompt/completion 命名。
        // 在边界处换算一次，别让命名差异渗进计价函数。
        const charged = spForUsage(backend, { inputTokens: finalUsage.promptTokens, outputTokens: finalUsage.completionTokens })
        const settledOutcome = deps.ledger.settle({
          callId: call.callId,
          sp: charged,
          call: {
            tier: tierId,
            publishedName: chosen.model.publishedName,
            backendKey: backend.id,
            inputTokens: finalUsage.promptTokens,
            outputTokens: finalUsage.completionTokens,
          },
        })
        handlers.onDone({ chargedSp: settledOutcome.chargedSp, usageSource: source, credit: deps.ledger.creditOf(call.accountId, tierId) })
      }

      const stream = rawForward(
        deps.forwardConfigFor?.(backend) ?? deps.forwardConfig,
        {
          model: backend.id,
          // 请求体原样转发（只覆盖 model 与 stream），工具定义因此完整保留。
          body: { ...call.body, max_tokens: granted.maxOutputTokens },
          signal,
        },
        {
          onFrame: (frame) => { handlers.onFrame(frame.payload) },
          onDone: (usage) => { health.recordSuccess(backend.id); finish(usage, null) },
          onError: (failure) => { health.recordFailure(backend.id); finish(null, failure) },
        },
      )

      return { abort: () => { stream.abort(); controller.abort() }, completed: stream.completed }
    },
  }
}
