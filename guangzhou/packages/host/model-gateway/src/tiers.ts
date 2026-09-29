/**
 * 订阅与计费的内核：**订阅档位、模型路由表、用量计量、限额执行**。
 *
 * 为什么要有这一层（而不是继续用上游那个 `/chat/completions`）：
 * 我读过上游实现，它从请求体里**只读 `messages` 与 `model` 两个字段，其余全部静默丢弃**，
 * 并且把 `max_tokens` 写死 2000、非流式、不写审计。于是四件事做不了——
 * 上下文上限强制、输出长度控制、流式输出、逐调用留痕——而订阅的成本控制**正建立在这四件上**。
 * 自建网关用我们自己的密钥，这四件一次全解决。
 *
 * 本文件**只做纯逻辑**：不读环境变量、不碰网络、不落盘。这样额度与限额的每条规则都能被
 * 单测穷举，而不是靠"跑一次看看"。
 */

/** 人民币与订阅点数（SP）的锚定：1 SP = 0.01 元。 */
export const SP_PER_YUAN = 100

/** 美元换算人民币的汇率。
 *
 * 官方价目表以美元计价，而我们的售价是人民币，所以必须有一个换算——**这个数字是会变的**，
 * 因此它是显式常量、不是散落在算式里的魔数，改一处即可。定价时按保守值取，宁可高估成本。 */
export const CNY_PER_USD = 7.2

/** 一个后端模型：真实调用哪个模型、什么价。 */
export interface BackendModel {
  /** 上游接受的模型标识（照官方文档原名，不猜）。 */
  readonly id: string
  /** 每百万输入 token 的价格（美元，高峰价；低谷是它的一半，这里按保守取高峰）。 */
  readonly inputUsdPerMillion: number
  /** 每百万输出 token 的价格（美元，高峰价）。 */
  readonly outputUsdPerMillion: number
  /** 该后端的并发上限（官方公布）。 */
  readonly concurrency: number
  /**
   * 这个后端自己的 API 根地址。
   *
   * 为什么必须**按后端**配而不是全局一个：不同后端常常是**不同厂商**——
   * DeepSeek 与阿里云的通义完全是两套端点、两把密钥。用一个全局 baseUrl
   * 转发所有后端，结果就是"换后端"只改了模型名、请求依然发给原来那家，
   * 表现为上游报"模型不存在"。那种接法看起来像是接上了，实际从来没通过。
   */
  readonly baseUrl: string
  /**
   * 这个后端用哪把密钥（凭据文件 `refs:` 段的键名）。
   *
   * 与 `baseUrl` 同理：密钥是按厂商签发的，共用一把必然有一家认证失败。
   */
  readonly credentialRef: string
}

/**
 * 后端清单。
 *
 * 价格来自 DeepSeek 官方定价页（每百万 token、高峰价，低谷价为一半）：
 * - `deepseek-flash`：缓存未命中输入 $0.30、输出 $1.20、并发 2500
 * - `deepseek-v4-pro`：缓存未命中输入 $1.32、输出 $3.96、并发 500
 * **按缓存未命中价取**：缓存命中是运气，不能拿它做定价。
 */
export const BACKENDS: Readonly<Record<string, BackendModel>> = {
  flash: {
    id: 'deepseek-flash', inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20, concurrency: 2500,
    baseUrl: 'https://api.deepseek.com/v1', credentialRef: 'DEEPSEEK_API_KEY',
  },
  pro: {
    id: 'deepseek-v4-pro', inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96, concurrency: 500,
    baseUrl: 'https://api.deepseek.com/v1', credentialRef: 'DEEPSEEK_API_KEY',
  },
  /**
   * 通义千问（阿里云 Model Studio）——**第二个上游**。
   *
   * 为什么值得接：实测这个 Key 在 `compatible-mode/v1` 下能看到 **251 个模型**
   * （含 `deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3`、`kimi-k3`），
   * 也就是说它本身就是个**多模型总入口**。这正好是"换后端不惊动用户"需要的东西：
   * 模型路由控制台改一条绑定就能把「千手·强力」切到完全不同的一家上游，
   * 而用户看到的还是同一个名字。
   *
   * 端点实测：北京 `https://dashscope.aliyuncs.com/compatible-mode/v1` 通（HTTP 200）；
   * 新加坡/美国/香港三个端点对这个 Key 回 401——**密钥按区域绑定**，这是官方文档明确写的。
   *
   * ⚠️ **价格未核实**：这里的单价是按"与 pro 同档"暂填的占位值，**不是官方价**。
   * 真实报价要先查阿里云价目表再改——在改之前，"千手·强力走通义"这条路上的
   * 扣费只能当**估算**看，不能当账单。这条已经写进第 16 节的未验证清单。
   */
  qwen: {
    id: 'qwen-plus', inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96, concurrency: 200,
    // 端点实测：北京通（HTTP 200）；新加坡/美国/香港对这个 Key 回 401——
    // **密钥按区域绑定**，这是官方文档明确写的，不要随手换。
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    credentialRef: 'QWEN_TOKEN_PLAN_API_KEY',
  },
}

/** 一个前台模型名：用户看到的、以及它对应的后端与能力。 */
export interface PublishedModel {
  /** 前台名字（用户只看到这个）。 */
  readonly publishedName: string
  /** 后端键（`BACKENDS` 的键）。一个名字可以有多个后端，按顺序尝试。 */
  readonly backends: readonly string[]
  /** 这个模型允许出现在哪些档位。 */
  readonly tiers: readonly TierId[]
  /** 单次请求的输出上限（我们要解决的正是「写死 2000」）。 */
  readonly maxOutputTokens: number
}

/**
 * 前台模型表。
 *
 * 前台只显示我们的命名；真实后端标识留在绑定里（控制台的映射表就是干这个的）。
 * 一个名字对应**有序后端列表**而不是恰好一个：上游可能有多区/多后端，
 * 这里预留同形结构，将来加备用后端不需要改契约。
 */
export const PUBLISHED_MODELS: readonly PublishedModel[] = [
  {
    publishedName: '千手·迅捷',
    backends: ['flash'],
    tiers: ['basic', 'plus', 'max'],
    maxOutputTokens: 4096,
  },
  {
    publishedName: '千手·强力',
    backends: ['pro', 'flash'],
    // 普通版不给强力档：这是「便宜档与高级档」最实在的差异，也直接对应 3.3 倍成本差。
    tiers: ['plus', 'max'],
    maxOutputTokens: 16384,
  },
]

/** 档位标识。 */
export type TierId = 'basic' | 'plus' | 'max'

/**
 * 全部合法档位的**运行期**清单。
 *
 * 为什么必须有它：档位字符串会从 HTTP 请求体、以及**磁盘上的账本/订阅文件**里读回来。
 * 只靠类型拦不住——类型在运行期不存在，而"读回一个不是档位的字符串"会一路走到
 * `TIERS[bad]` 变成 `undefined`，再以 `Cannot read properties of undefined` 的形式
 * 在别处炸。校验只能靠这个清单（WP1 A-10/A-12）。
 */
export const TIER_IDS: readonly TierId[] = ['basic', 'plus', 'max']

/**
 * 是不是一个合法档位。
 * @param value - 待校验的值。
 * @returns 是档位时为 `true`（类型收窄）。
 */
export function isTierId(value: unknown): value is TierId {
  return typeof value === 'string' && (TIER_IDS as readonly string[]).includes(value)
}

/** 一个订阅档位的额度与限额。 */
export interface Tier {
  readonly id: TierId
  /** 前台显示名。 */
  readonly label: string
  /** 月费（元）。 */
  readonly monthlyYuan: number
  /** 每月授予的订阅点数。 */
  readonly monthlySp: number
  /** 单请求的上下文上限（输入 token）；**这是成本控制，不是营销限制**。 */
  readonly contextLimitTokens: number
  /** 同时进行的请求数上限。 */
  readonly concurrency: number
  /** 五小时窗口内的点数上限（防滥用的刹车；月额度防的是亏损）。 */
  readonly windowFiveHourSp: number
  /** 额度耗尽时的行为。 */
  readonly onExhausted: 'downgrade' | 'stop'
  /** 是否允许主动开启按量付费。 */
  readonly payAsYouGo: boolean
}

/**
 * 三档。
 *
 * 设计依据（详见 `docs/dev-plan/设计-订阅与计费.md`）：
 * - **额度按月授予、五小时窗口另设刹车**：月额度防亏损，短窗口防滥用（一个人写脚本连刷）。
 * - **上下文上限是成本控制**：同样一次调用，1M 输入的成本是 2K 的约 507 倍——
 *   而成本风险**只在输入侧**（输出被我们自己的上限封住）。
 * - **普通版额度耗尽即降级**到轻量模型，而不是直接停：停服对用户体验的伤害远大于降级。
 * - **按量付费只在顶档、且需显式开启**：对消费者账号自动扣费是争议制造机。
 */
export const TIERS: Readonly<Record<TierId, Tier>> = {
  basic: {
    id: 'basic',
    label: '普通版',
    monthlyYuan: 39,
    monthlySp: 390,
    contextLimitTokens: 64_000,
    concurrency: 5,
    windowFiveHourSp: 60,
    onExhausted: 'downgrade',
    payAsYouGo: false,
  },
  plus: {
    id: 'plus',
    label: '高级版',
    monthlyYuan: 99,
    monthlySp: 990,
    contextLimitTokens: 256_000,
    concurrency: 20,
    windowFiveHourSp: 200,
    onExhausted: 'downgrade',
    payAsYouGo: false,
  },
  max: {
    id: 'max',
    label: 'Max 版',
    monthlyYuan: 299,
    monthlySp: 2990,
    contextLimitTokens: 1_000_000,
    concurrency: 60,
    windowFiveHourSp: 600,
    onExhausted: 'downgrade',
    payAsYouGo: true,
  },
}

/**
 * 估算一段文本的 token 数。
 *
 * **这是估算，不是精确分词**，而且必须说清楚为什么这样做：
 * 精确分词要引 tokenizer 依赖（本仓库原则是零新增依赖），而一个偏保守的估算**足够支撑限额**——
 * 因为我们要防的是量级失控（1M 输入 = 507 倍成本），不是几 percent 的计费误差。
 *
 * 规则：中日韩字符按 **1 字符 ≈ 1 token**（官方文档口径），其余按 **4 字符 ≈ 1 token**。
 * 取整一律**向上**，宁可高估成本。
 * @param text - 待估文本。
 * @returns 估算的 token 数。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // 中日韩统一表意文字、扩展 A、兼容表意文字，以及假名与韩文音节。
    const isWide = (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
    if (isWide) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 一条待发出的消息。 */
export interface GatewayMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** 一次请求的输入。 */
export interface GatewayRequest {
  readonly accountId: string
  readonly tier: TierId
  /** 前台模型名（用户选的）。 */
  readonly publishedName: string
  readonly messages: readonly GatewayMessage[]
  /** 调用方希望的输出上限；省略时用该模型的默认值，**并且永远不超过它的上限**。 */
  readonly maxOutputTokens?: number
}

/** 拒绝原因；每一种对应不同的处置。 */
export type RejectionKind =
  | 'unknown-model'
  | 'model-not-in-tier'
  | 'context-too-long'
  | 'no-credit'
  | 'invalid-request'
  | 'too-many-concurrent'

/** 一次被拒绝的请求。 */
export interface Rejection {
  readonly ok: false
  readonly kind: RejectionKind
  /** 面向用户的中文说明；直接可展示。 */
  readonly message: string
  /** 可选的建议（例如降级到哪个模型）。 */
  readonly suggestion?: { readonly publishedName: string }
}

/** 一次被接受的请求：已经算好预算与调用参数。 */
export interface Admission {
  readonly ok: true
  readonly tier: Tier
  readonly model: PublishedModel
  /** 按顺序尝试的后端（真实标识在此，**不出网关**）。 */
  readonly backends: readonly BackendModel[]
  /** 本次输入的估算 token。 */
  readonly inputTokens: number
  /** 本次允许的输出上限（已被模型上限封顶）。 */
  readonly maxOutputTokens: number
  /** 本次的**最大可能花费**（SP）；按输出用满估算——先按最坏情况预留。 */
  readonly reservedSp: number
}

/** 一次调用的真实用量。 */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * 把用量换算成订阅点数（SP）。
 * @param backend - 实际作答的后端。
 * @param usage - 真实用量（来自上游响应的 `usage`；拿不到时用估算值）。
 * @returns 消耗的 SP，向上取整到 0.01 SP（即 0.0001 元）。
 */
export function spForUsage(backend: BackendModel, usage: Usage): number {
  const inputYuan = (usage.inputTokens / 1_000_000) * backend.inputUsdPerMillion * CNY_PER_USD
  const outputYuan = (usage.outputTokens / 1_000_000) * backend.outputUsdPerMillion * CNY_PER_USD
  const sp = (inputYuan + outputYuan) * SP_PER_YUAN
  // 向上取整到 0.01 SP：宁可多收一点点，也不要出现"调用了但不计费"的缝隙。
  return Math.ceil(sp * 100) / 100
}

/** 一次估算：给定输入 token 与输出上限，最坏要花多少 SP。 */
function worstCaseSp(backend: BackendModel, inputTokens: number, maxOutputTokens: number): number {
  return spForUsage(backend, { inputTokens, outputTokens: maxOutputTokens })
}

/**
 * 输出上限的**下限**：低于这个值就抬上来。
 *
 * 为什么必须有这条下限（真实端点实测得来）：DeepSeek 会先产出**推理内容**，
 * 而推理 token **算在 `max_tokens` 预算里**。实测 `max_tokens: 16` 时全部预算
 * 被推理吃掉，正文一个字都没轮到——用户收到的是"内容无法识别"。
 * 网关侧本来没错（没拿到正文就不计费），但**对用户是误导**：
 * 他以为产品坏了，其实是这次请求的输出上限小到不可能出结果。
 *
 * 256 的依据：GPT/Claude 这类接口常把最小值定在 1（纯技术上），
 * 但对**会推理的模型**来说那个值没有意义。256 足够出一次短答，
 * 又不至于把一次误传的小值放大成一大笔开销。
 */
export const MIN_OUTPUT_TOKENS = 256

/** 账户当前可用的额度。 */
export interface CreditState {
  /** 本月剩余 SP。 */
  readonly remainingMonthlySp: number
  /** 五小时窗口内已用 SP。 */
  readonly usedInWindowSp: number
}

/**
 * 判定一次请求是否放行，并算出它的预算。
 *
 * 判定顺序是刻意的：**先看模型是否属于该档位**（这是用户能自己改的：换个模型就好），
 * 再看上下文（用户能自己改：把问题说短点），最后看额度（用户只能付费或等待）。
 * 顺序错了会给用户"额度不足"这种误导性的拒绝——而其实只是选错了模型。
 * @param request - 请求输入。
 * @param credit - 账户额度状态。
 * @returns 放行（含预算）或被拒（含可展示的原因）。
 */
export function admit(request: GatewayRequest, credit: CreditState): Admission | Rejection {
  if (request.messages.length === 0) {
    return { ok: false, kind: 'invalid-request', message: '这条请求没有内容。' }
  }
  const model = PUBLISHED_MODELS.find(candidate => candidate.publishedName === request.publishedName)
  if (model === undefined) {
    return { ok: false, kind: 'unknown-model', message: '这个模型不存在。' }
  }
  const tier = TIERS[request.tier]

  if (!model.tiers.includes(tier.id)) {
    // 给出**可行的替代**，而不是只说"不行"。
    const fallback = PUBLISHED_MODELS.find(candidate => candidate.tiers.includes(tier.id))
    if (fallback === undefined) {
      return { ok: false, kind: 'model-not-in-tier', message: `${tier.label}暂时用不了这个模型。` }
    }
    return {
      ok: false,
      kind: 'model-not-in-tier',
      message: `${tier.label}用不了「${model.publishedName}」。可以改用「${fallback.publishedName}」。`,
      suggestion: { publishedName: fallback.publishedName },
    }
  }

  const backends = model.backends
    .map(key => BACKENDS[key])
    .filter((backend): backend is BackendModel => backend !== undefined)
  const primary = backends[0]
  if (primary === undefined) {
    return { ok: false, kind: 'unknown-model', message: '这个模型暂时没有可用的后端。' }
  }

  const inputTokens = request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  if (inputTokens > tier.contextLimitTokens) {
    return {
      ok: false,
      kind: 'context-too-long',
      message: `这次的内容太长了（约 ${inputTokens} token），${tier.label}单次上限是 ${tier.contextLimitTokens} token。`
        + '把内容拆成几次，或升级到更高档位。',
    }
  }

  // 先按模型上限封顶，再抬到下限——顺序不能反：
  // 反了会把"模型本身只支持 128"这种上游限制顶穿。
  const maxOutputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(request.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
  )
  // 预算按**最坏情况**预留：输出用满。用平均值得出的预算会在长回答上超支。
  const reservedSp = worstCaseSp(primary, inputTokens, maxOutputTokens)

  if (credit.remainingMonthlySp < reservedSp) {
    return {
      ok: false,
      kind: 'no-credit',
      message: tier.onExhausted === 'downgrade'
        ? `本月额度用完了（还剩 ${credit.remainingMonthlySp} SP，这次最多需要 ${reservedSp} SP）。`
          + '会自动改用轻量模型继续，或升级档位。'
        : `本月额度用完了（还剩 ${credit.remainingMonthlySp} SP）。下个周期恢复。`,
    }
  }
  if (credit.usedInWindowSp + reservedSp > tier.windowFiveHourSp) {
    return {
      ok: false,
      kind: 'no-credit',
      message: `${tier.label}短时用量已达上限（五小时内 ${tier.windowFiveHourSp} SP）。`
        + '稍等一下再继续——这是防滥用的刹车，不是永久限制。',
    }
  }

  return { ok: true, tier, model, backends, inputTokens, maxOutputTokens, reservedSp }
}
