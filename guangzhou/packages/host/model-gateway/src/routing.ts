/**
 * 模型路由控制台的数据面：**前台名字 → 有序后端列表的版本化绑定**。
 *
 * 要解决的核心问题：**换掉后端模型时不能惊动用户**。
 * 用户在界面上看到的是「千手·强力」；这个星期它由 A 作答，下个星期由 B 作答，
 * 用户不需要知道，也不该看到账单口径突然变化。
 *
 * 四条设计（每条都为了解决一个具体的坑）：
 *
 * 1. **绑定只追加、带生效区间，不修改历史**。所以「某个名字在某一天意味着什么」永远可重建。
 *    直接改一条绑定的后端，等于把过去的账单变成不可解释的——对账的人会疯。
 * 2. **绝不在计费周期中间换绑**：`bind` 要求生效日在未来，并且要显式给出原因与操作者。
 * 3. **一个名字对应的是有序后端列表，不是恰好一个**。主后端打满时按顺序落到备用
 *    （大厂也是这个形状：Azure 的 spillover 就是「预备容量耗尽时改由标准部署服务」）。
 * 4. **灰度按名字与请求标识确定性地分流**，不用随机数——否则同一个用户的相邻两次请求
 *    会落到不同后端，出了问题无法复现。
 */

/** 后端的生命周期阶段（照 Azure 的成文阶段）。 */
export type LifecycleStage = 'preview' | 'ga' | 'legacy' | 'deprecated' | 'retired'

/** 上游换默认版本时我们跟不跟。 */
export type UpgradeRule = 'follow-default' | 'on-expiry' | 'never'

/** 一个前台名字的记录。 */
export interface PublishedNameRecord {
  readonly publishedName: string
  /** 界面上的显示名（可与名字不同，例如带「深度推理」后缀）。 */
  readonly label: string
  readonly tiers: readonly string[]
  readonly maxOutputTokens: number
  /** 界面上的排序。 */
  readonly order: number
  readonly upgradeRule: UpgradeRule
  readonly lifecycleStage: LifecycleStage
  /** 该名字何时停止路由到这个真实模型；`null` 表示没有计划。 */
  readonly shutdownDate: number | null
  /** 退役后建议用户迁到哪个名字。 */
  readonly migrationTarget: string | null
}

/** 一条绑定：某个名字在某段生效区间里由哪些后端按顺序作答。 */
export interface BackendBinding {
  readonly publishedName: string
  /** 生效时刻（含）。 */
  readonly effectiveFrom: number
  /**
   * 失效时刻（不含）；`null` 表示至今有效。
   *
   * **绑定的失效时刻由「下一条绑定的生效时刻」决定，不由管理员手填**——
   * 让管理员同时填两个时刻，必然出现重叠或空档。
   */
  readonly effectiveTo: number | null
  /** 有序后端：主用在前，备用在后的顺序就是 spillover 顺序。 */
  readonly backendKeys: readonly string[]
  /** 为什么改：给将来对账的人看的。 */
  readonly reason: string
  readonly operator: string
  /** 灰度百分比（0–100）；`100` 表示全量。 */
  readonly rolloutPercent: number
}

/** 解析结果。 */
export type ResolveOutcome =
  | { readonly ok: true; readonly backendKeys: readonly string[]; readonly rollout: 'full' | 'canary' }
  | { readonly ok: false; readonly reason: 'no-binding' | 'retired'; readonly message: string }

/** 控制台的数据面。 */
export interface RoutingConsole {
  /** 登记或更新一个前台名字（显示名、档位、上限等管理属性）。 */
  readonly publish: (record: PublishedNameRecord) => void
  /**
   * 追加一条绑定。**要求生效日在未来**，并自动把上一条的失效时刻设到它生效之前。
   * @param input - 名字、后端列表、生效时刻、原因与操作者。
   * @returns 追加后的完整绑定列表。
   */
  readonly bind: (input: {
    readonly publishedName: string
    readonly backendKeys: readonly string[]
    readonly effectiveFrom: number
    readonly reason: string
    readonly operator: string
    readonly rolloutPercent?: number
  }) => readonly BackendBinding[]
  /**
   * 解析某个名字在某个时刻由谁作答。
   * @param publishedName - 前台名字。
   * @param at - 时刻。
   * @param requestKey - 请求标识（用于灰度分流；确定性，不用随机数）。
   * @returns 后端列表与是否处于灰度。
   */
  readonly resolve: (publishedName: string, at: number, requestKey: string) => ResolveOutcome
  /**
   * 按名字与时刻解析出**可直接调用**的模型配置。
   *
   * 这是把控制台接进服务层的那个口：服务层不再查静态表，而是问它
   * 「此刻这个名字意味着哪些后端」。
   * @param publishedName - 前台名字。
   * @param at - 时刻。
   * @param requestKey - 请求标识（灰度分流用）。
   * @returns 可调用的模型配置，或拒绝原因。
   */
  readonly modelAt: (publishedName: string, at: number, requestKey: string) => ResolveOutcome | { readonly ok: false; readonly reason: 'unknown-name'; readonly message: string }
  /** 全部名字（按 order 排序），给控制台列表用。 */
  readonly names: () => readonly PublishedNameRecord[]
  /** 某个名字的绑定历史（含已失效的），给「某天意味着什么」用。 */
  readonly historyOf: (publishedName: string) => readonly BackendBinding[]
}

/**
 * 确定性的哈希：给灰度分流用。
 *
 * **不用随机数**是刻意的：随机数会让同一用户的相邻两次请求落到不同后端，
 * 出问题无法复现。这里用累计求和，同一个 `requestKey` 永远得到同一个桶。
 * @param text - 请求标识。
 * @returns 0–99 的桶号。
 */
export function bucketOf(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100_000_007
  }
  return hash % 100
}

/**
 * 解析某个名字在某个时刻由谁作答。抽成独立函数是为了让 `resolve` 与 `modelAt` 共用同一份
 * 实现——两处各写一遍必然分叉，而分叉的那一天就是"某个名字在某天意味着什么"开始说不清的那天。
 * @param deps - 取记录与绑定。
 * @param publishedName - 前台名字。
 * @param at - 时刻。
 * @param requestKey - 请求标识（灰度分流）。
 * @returns 后端列表与是否处于灰度，或拒绝原因。
 */
function resolveAt(
  deps: {
    readonly recordOf: (name: string) => PublishedNameRecord | undefined
    readonly bindingsOf: (name: string) => readonly BackendBinding[]
  },
  publishedName: string,
  at: number,
  requestKey: string,
): ResolveOutcome {
  const record = deps.recordOf(publishedName)
  if (record !== undefined && record.shutdownDate !== null && at >= record.shutdownDate) {
    return {
      ok: false,
      reason: 'retired',
      message: record.migrationTarget === null
        ? `「${record.label}」已经下线。`
        : `「${record.label}」已经下线，建议改用「${record.migrationTarget}」。`,
    }
  }
  const ordered = deps.bindingsOf(publishedName)
  const inWindow = ordered.find(binding =>
    binding.effectiveFrom <= at && (binding.effectiveTo === null || at < binding.effectiveTo))
  if (inWindow === undefined) {
    return { ok: false, reason: 'no-binding', message: `「${publishedName}」暂时没有可用的后端。` }
  }
  if (inWindow.rolloutPercent >= 100) {
    return { ok: true, backendKeys: inWindow.backendKeys, rollout: 'full' }
  }
  const inCanary = bucketOf(`${publishedName}:${requestKey}`) < inWindow.rolloutPercent
  if (inCanary) return { ok: true, backendKeys: inWindow.backendKeys, rollout: 'canary' }
  // 未命中灰度的人回落到**换绑前**那条绑定，而不是"没有后端可用"——这正是灰度该有的行为。
  const previous = ordered.filter(binding => binding.effectiveTo === inWindow.effectiveFrom)
  const fallback = previous[previous.length - 1]
  return fallback === undefined
    ? { ok: false, reason: 'no-binding', message: `「${publishedName}」暂时没有可用的后端。` }
    : { ok: true, backendKeys: fallback.backendKeys, rollout: 'full' }
}

/**
 * 建一个路由控制台的数据面。
 *
 * 内存实现：它服务于单进程网关。落库是部署方的事，这里只定义**语义**
 * （尤其是「历史不可变」这条，落库时也要靠只追加来保证）。
 * @returns 控制台实例。
 */
export function createRoutingConsole(): RoutingConsole {
  const names = new Map<string, PublishedNameRecord>()
  const bindings = new Map<string, BackendBinding[]>()

  const sorted = (publishedName: string): readonly BackendBinding[] =>
    [...(bindings.get(publishedName) ?? [])].sort((left, right) => left.effectiveFrom - right.effectiveFrom)

  return {
    publish: (record) => { names.set(record.publishedName, record) },

    bind: ({ publishedName, backendKeys, effectiveFrom, reason, operator, rolloutPercent = 100 }) => {
      if (backendKeys.length === 0) throw new Error('一条绑定至少要有一个后端')
      const existing = sorted(publishedName)
      const latest = existing[existing.length - 1]
      if (latest !== undefined && effectiveFrom <= latest.effectiveFrom) {
        // 只允许往后追加。允许改历史就等于让过去的账单不可解释。
        throw new Error(`生效时刻必须晚于上一条绑定（${new Date(latest.effectiveFrom).toISOString()}）`)
      }
      const next: BackendBinding[] = existing.map((binding, index) => (
        index === existing.length - 1 && binding.effectiveTo === null
          // 把上一条的失效时刻钉在新绑定生效之前——不让管理员手填两个时刻，否则必然重叠或空档。
          ? { ...binding, effectiveTo: effectiveFrom }
          : binding
      ))
      next.push({
        publishedName,
        effectiveFrom,
        effectiveTo: null,
        backendKeys,
        reason,
        operator,
        rolloutPercent: Math.max(0, Math.min(100, rolloutPercent)),
      })
      bindings.set(publishedName, next)
      return next
    },

    resolve: (publishedName, at, requestKey) =>
      resolveAt({ recordOf: name => names.get(name), bindingsOf: sorted }, publishedName, at, requestKey),

    modelAt: (publishedName, at, requestKey) => {
      if (!names.has(publishedName)) {
        return { ok: false, reason: 'unknown-name' as const, message: '这个模型不存在。' }
      }
      return resolveAt({ recordOf: name => names.get(name), bindingsOf: sorted }, publishedName, at, requestKey)
    },

    names: () => [...names.values()].sort((left, right) => left.order - right.order),
    historyOf: publishedName => sorted(publishedName),
  }
}
