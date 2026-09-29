/**
 * 上游连通性测试：改密钥之前，**先用新密钥真打一次上游**。
 *
 * 这是防"手滑把网关弄挂"的关键一环。没有它的话，一次粘贴错误就会把配置写进去，
 * 而症状是全部用户对话失败 —— 那时再回滚已经晚了。
 *
 * ## 两条刻意的取舍
 *
 * 1. **失败不写入，但"上游 5xx"和"密钥不对"必须分开说。**
 *    401/403 是密钥本身的结论（确定性失败，不重试）；5xx 与网络错误是上游/链路
 *    的问题（重试一次，仍失败则如实说"无法确认"）。把后者说成"密钥无效"会让
 *    管理员去换一把本来没问题的密钥。
 * 2. **报延迟而不是报"通过"。** 只能证明"这次请求通了"，证明不了"以后一直通"。
 *    所以我们回一个延迟区间，让管理员自己看它是否异常 —— 比一个绿色的对勾诚实。
 *
/**
 * 本模块**只用 node 内置能力**（`fetch` 是 Node 22 的内置能力），不引第三方依赖：
 * 部署形态是 `node src/main.ts serve`，引包会让服务器上起不来。
 */
import {
  CURSOR_API_BASE,
  isCursorPoolRef,
  verifyCursorCredential,
} from './cursor-credential.ts'

/** 一次探测的结果。 */
export type ProbeResult =
  | {
    readonly ok: true
    /** 往返耗时（毫秒）。 */
    readonly latencyMs: number
    /** 上游回的模型名（有就带上，便于确认打对了厂商）。 */
    readonly model: string | null
    /** 上游回的 HTTP 状态码。审计要能回答"当时真的是 200 吗"，所以它必须是真的那一个。 */
    readonly status: number
  }
  | {
    readonly ok: false
    /** 分类：密钥问题 / 上游问题 / 链路问题 / 配置问题。 */
    readonly kind: ProbeFailureKind
    /** 可直接展示给管理员的中文原因。 */
    readonly message: string
    /** 上游的 HTTP 状态码（拿不到就是 `null`）。 */
    readonly status: number | null
  }

/** 失败分类。区分它们是因为**下一步动作不同**。 */
export type ProbeFailureKind =
  /** 密钥无效或没有权限 —— 确定性失败，不该写入。 */
  | 'credential_rejected'
  /** 上游限流 —— 无法确认密钥是否有效。 */
  | 'rate_limited'
  /** 上游 5xx 或超时 —— 上游的问题，不是密钥的。 */
  | 'upstream_unavailable'
  /** 网络/DNS/TLS 层失败。 */
  | 'network_error'
  /** 这个引用没有配置探测目标（管理台不会去猜该打哪个地址）。 */
  | 'probe_not_configured'

/** 一个引用的探测目标。 */
export interface ProbeTarget {
  /** OpenAI 兼容的 chat completions 根地址（`cursor-dashboard` 时是上游根地址）。 */
  readonly baseUrl: string
  /**
   * 探测打法。
   *
   * 默认 `openai-chat`（OpenAI 兼容的 `chat/completions`）。上游不是 OpenAI 兼容
   * 形状的（Cursor 的 `GetMe`）必须显式声明 —— **不要让通用探测去猜协议**，
   * 猜错的探测会给出"凭据无效"这种完全错误的结论。
   */
  readonly kind?: 'openai-chat' | 'cursor-dashboard'
  /** `openai-chat` 用哪个模型做这次最小请求（挑最便宜的）。`cursor-dashboard` 不用它。 */
  readonly model?: string
  /** 额外请求头。 */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * 改完这个键之后，工作台是否**必须重启**才生效。
   *
   * 这是实测出来的，不是保险起见。模型网关的 `apiKey()` 缓存是"**成功值永久缓存**"
   * —— 只有解析结果为 `null` 时才走 30 秒冷却重试；一旦拿到值就再也不重算。
   * 而 `DEEPSEEK_API_KEY` 正是网关的主引用，所以改完文件**必须重启**。
   *
   * 写成配置而不是常量：网关哪天把缓存换成带 TTL 的，改这里就行，
   * 不用去动接口逻辑。
   */
  readonly restartRequired: boolean
  /** 重启哪个服务（只作展示，管理台**不代执行**）。 */
  readonly restartService?: string
}

/**
 * 内置探测目标表。
 *
 * 为什么是**表**而不是写死的逻辑：上游地址是部署方会改的东西（换代理、换厂商、
 * 私有化部署），而"改哪个地址"不该需要改代码。表之外的引用一律回
 * `probe_not_configured` —— 明确说"我不知道该打哪里"，而不是随便挑一个地址发出去。
 *
 * `max_tokens: 1` + 最短提示词：这次调用是要计费的，所以刻意做到近零成本。
 */
export const PROBE_TARGETS: Readonly<Record<string, ProbeTarget>> = {
  DEEPSEEK_API_KEY: {
    kind: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    // 网关把这个引用放在主路径上且**成功值永久缓存**（见 ProbeTarget.restartRequired）。
    restartRequired: true,
    restartService: 'qianshou-workbench',
  },
}

/**
 * 号池条目的探测目标。
 *
 * 为什么它不进 `PROBE_TARGETS`：号池的 ref 是**按账号派生的动态名字**
 * （`CURSOR_CK_<sha256(authId) 前 8 位>`，见 `cursor-credential.ts`），
 * 事先列不出来。所以它按**前缀**匹配，由 `probeTargetFor` 兜底。
 *
 * 探测打法不是 OpenAI 兼容的：Cursor 的验活接口是 `GetMe`（POST，带 CLI 客户端头），
 * 它既回答"这枚凭据还活着吗"，也给出 `authId`。
 *
 * `restartRequired: false` 是**当前事实**：号池今天的消费方还不存在（网关的号池路由
 * 尚未接入），所以没有任何进程缓存了它。接入之后，如果那个消费方也像
 * `apiKey()` 一样永久缓存成功值，这里要改成 `true`。
 */
export const CURSOR_POOL_PROBE_TARGET: ProbeTarget = {
  kind: 'cursor-dashboard',
  baseUrl: CURSOR_API_BASE,
  restartRequired: false,
}

/**
 * 找一个引用该往哪里探测。
 *
 * 注入的探测表（`ProbeDeps.targets`）是**权威的**：测试要能完整接管"打哪里"，
 * 所以只有内置表才按前缀兜底到号池目标 —— 否则"注入空表"就挡不住真实网络请求。
 * @param ref - 引用名。
 * @param targets - 探测表（默认内置表）。
 * @returns 探测目标；没有就返回 `undefined`（管理台不猜地址）。
 */
export function probeTargetFor(
  ref: string,
  targets: Readonly<Record<string, ProbeTarget>> = PROBE_TARGETS,
): ProbeTarget | undefined {
  const exact = targets[ref]
  if (exact !== undefined) return exact
  if (targets !== PROBE_TARGETS) return undefined
  return isCursorPoolRef(ref) ? CURSOR_POOL_PROBE_TARGET : undefined
}

/** 单次探测超时（毫秒）。上游慢的时候不能把管理台接口一起拖住。 */
export const PROBE_TIMEOUT_MS = 15_000

/** 从上游的错误正文里取一句可读的原因；**绝不回显请求侧的任何东西**。 */
function reasonFromBody(text: string): string | null {
  if (text.trim().length === 0) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object') {
      const error = (parsed as { error?: unknown }).error
      if (error !== null && typeof error === 'object') {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
      }
      const message = (parsed as { message?: unknown }).message
      if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
    }
  } catch {
    // 不是 JSON：退化成截断的纯文本。
  }
  return text.trim().slice(0, 300)
}

/**
 * 判定一次 HTTP 响应。
 *
 * 抽成纯函数是为了能在测试里**逐条钉住**每种失效模式，而不用真去连上游 ——
 * 上游的可用性不是我们能在测试里控制的东西，但我们的分类逻辑必须是确定的。
 * @param status - HTTP 状态码。
 * @param bodyText - 响应正文。
 * @returns 判定结果。
 */
export function classifyProbeResponse(
  status: number,
  bodyText: string,
): { readonly ok: true; readonly model: string | null } | { readonly ok: false; readonly kind: ProbeFailureKind; readonly message: string } {
  const reason = reasonFromBody(bodyText)
  if (status >= 200 && status < 300) {
    let model: string | null = null
    try {
      const parsed = JSON.parse(bodyText) as { model?: unknown }
      if (typeof parsed.model === 'string') model = parsed.model
    } catch {
      // 2xx 但正文不是 JSON：上面已经判成功了，模型名留空即可。
    }
    return { ok: true, model }
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      kind: 'credential_rejected',
      message: `上游拒绝了这把密钥（HTTP ${status}）${reason === null ? '' : `：${reason}`}`,
    }
  }
  if (status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      message: `上游限流（HTTP 429）${reason === null ? '' : `：${reason}`}。这**不能证明**密钥无效，请稍后重试。`,
    }
  }
  if (status === 400 || status === 404) {
    // 400/404 通常是我们把请求发错了（模型名、路径）。它同样不能证明密钥有效或无效，
    // 但**必须暴露**：这说明探测目标配置过期了，继续用它等于在自欺。
    return {
      ok: false,
      kind: 'upstream_unavailable',
      message: `上游不接受这次探测请求（HTTP ${status}）${reason === null ? '' : `：${reason}`}。探测目标配置可能已过期，请修好再试。`,
    }
  }
  return {
    ok: false,
    kind: 'upstream_unavailable',
    message: `上游返回 HTTP ${status}${reason === null ? '' : `：${reason}`}。这是上游的问题，**不能证明密钥无效**。`,
  }
}

/** 探测依赖（测试注入）。 */
export interface ProbeDeps {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** 重试前的等待（测试里注入成 0，别让用例真的睡过去）。 */
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  /** 覆盖探测表（测试用）。**注入即权威**：给了它就不再按前缀兜底到号池目标。 */
  readonly targets?: Readonly<Record<string, ProbeTarget>>
}

/**
 * 用一把候选密钥真打一次上游。
 *
 * 重试策略（刻意不对称）：**只重试"无法确认"的那两类**（5xx/网络）。
 * 401/403 是确定性结论，重试只是让管理员多等；400/404 是配置问题，重试没用。
 * @param ref - 引用名（决定打哪个上游）。
 * @param value - 候选密钥（只在内存里，不进日志、不进审计）。
 * @param deps - 依赖注入。
 * @returns 探测结果。
 */
export async function probeUpstreamKey(ref: string, value: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const targets = deps.targets ?? PROBE_TARGETS
  const target = probeTargetFor(ref, targets)
  if (target === undefined) {
    return {
      ok: false,
      kind: 'probe_not_configured',
      message: `管理台还没有为「${ref}」配置连通性探测目标，无法在写入前验证。请先补上探测配置再改这个键。`,
      status: null,
    }
  }

  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS

  // 不是 OpenAI 兼容形状的上游：**协议知识在上游自己的模块里**（`cursor-credential.ts`），
  // 这里只负责把它的结论装进统一的 `ProbeResult`。重试策略也由那边负责
  // （同一套取舍：只重试"无法确认"的 5xx 与网络层失败）。
  //
  // 号池 ref 里落盘的值恒为 `crsr_…`，而它**不能直接打 `GetMe`**（实测三种头部组合全 401）：
  // 验活必须走"先换票、再用票取身份"两步 —— 那一整条在 `verifyCursorCredential` 里，
  // 这里不重复实现协议，也不自己拼那两步。
  //
  // 依赖直接传下去：`ProbeDeps` 与 `CursorDeps` 是同一份注入（同一个 fetch、同一个超时），
  // 只暴露一个注入点，测试里就不会出现"一半打桩、一半真打网络"的缝。
  if (target.kind === 'cursor-dashboard') {
    const attempt = await verifyCursorCredential(value, deps)
    if (attempt.ok) return { ok: true, latencyMs: attempt.probe.latencyMs, model: null, status: attempt.probe.status }
    // 形状认不出来时上游一次都没打：那是"我不知道这是什么"，不是"凭据被拒"。
    if (attempt.code === 'unrecognized') {
      return { ok: false, kind: 'credential_rejected', message: attempt.message, status: null }
    }
    return { ok: false, kind: attempt.kind, message: attempt.message, status: attempt.status }
  }

  const model = target.model
  if (model === undefined) {
    // 没有模型名就等于不知道该怎么发这次请求。**不猜**（照着别的目标发一次
    // 会得到一个"凭据无效"的假结论）。
    return {
      ok: false,
      kind: 'probe_not_configured',
      message: `「${ref}」的探测目标没有指定模型名，管理台不知道怎么发这次最小请求。请先补上探测配置。`,
      status: null,
    }
  }

  let lastFailure: { readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null } | null = null

  // 最多两次：初次 + 一次重试（只针对"无法确认"的失败）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = now()
    let response: Response
    try {
      response = await doFetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${value}`,
          ...target.headers ?? {},
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const aborted = name === 'TimeoutError' || name === 'AbortError'
      lastFailure = {
        kind: aborted ? 'upstream_unavailable' : 'network_error',
        message: aborted
          ? `连接上游超时（${timeoutMs} 毫秒）—— 这是链路问题，**不能证明密钥无效**。`
          : `连不上上游：${error instanceof Error ? error.message : String(error)}。这是链路问题，**不能证明密钥无效**。`,
        status: null,
      }
      if (attempt === 0) {
        await sleep(500)
        continue
      }
      return { ok: false, ...lastFailure }
    }

    // 读正文时也要能超时：有些失败是"连上了但不回正文"。
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      bodyText = ''
    }
    const verdict = classifyProbeResponse(response.status, bodyText)
    if (verdict.ok) {
      return { ok: true, latencyMs: Math.max(0, now() - started), model: verdict.model, status: response.status }
    }
    lastFailure = { kind: verdict.kind, message: verdict.message, status: response.status }
    // 只有"无法确认"的失败才值得再试一次。
    if (verdict.kind === 'upstream_unavailable' && response.status >= 500 && attempt === 0) {
      await sleep(500)
      continue
    }
    if (verdict.kind === 'network_error' && attempt === 0) {
      await sleep(500)
      continue
    }
    return { ok: false, kind: verdict.kind, message: verdict.message, status: response.status }
  }

  const failure = lastFailure ?? { kind: 'upstream_unavailable' as const, message: '探测未取得结论。', status: null }
  return { ok: false, kind: failure.kind, message: failure.message, status: failure.status }
}
