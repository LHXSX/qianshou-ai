/**
 * 订阅档位的**展示侧**目录。
 *
 * ## 为什么在客户端写一份档位表（而不是纯从服务端读）
 *
 * 「当前档位」必须来自服务端（`/ai/status` 的 `tier`），这一点没有商量余地。
 * 但「有哪些档位可选、各自多少钱、给多少额度」是**商品信息**：它要在用户还没
 * 有额度、甚至还没登录时就能看到，否则用户无法判断要不要买。
 *
 * 两份数据的**权威不同**且不冲突：服务端说他现在是什么档，商品表说有哪些档。
 * 所以这里的原则是——
 * 1. **当前档位一律用服务端报的**（包括它的中文名与价格），本表只提供"其余档位"的说明；
 * 2. 服务端报了一个本表没有的档位 id 时**照原样显示**，不硬塞进三档模型；
 * 3. 这张表与服务端的 `TIERS`（`packages/host/model-gateway/src/tiers.ts`）
 *    有一致性风险，所以**必须有一段测试同时读两边**比对——见
 *    `tests/tier-catalog.client.spec.ts`。测试红了就说明有人只改了一边。
 *
 * 数值来源：`packages/host/model-gateway/src/tiers.ts`（`SP_PER_YUAN = 100`）。
 */

/** 一个可选档位的展示信息。 */
export interface TierOffer {
  /** 与服务端一致的档位 id。 */
  readonly id: 'basic' | 'plus' | 'max'
  /** 月费（元）。 */
  readonly monthlyYuan: number
  /** 每月授予的订阅点数。 */
  readonly monthlySp: number
  /** 单请求上下文上限（输入 token）。 */
  readonly contextLimitTokens: number
  /** 并发上限。 */
  readonly concurrency: number
}

/**
 * 三档商品表，与服务端 `TIERS` 逐字段对应。
 *
 * 顺序是**从低到高**，界面按这个顺序横排/纵排，不重排——
 * 价格锚点要靠稳定的次序才能读出来。
 */
export const TIER_OFFERS: readonly TierOffer[] = [
  { id: 'basic', monthlyYuan: 39, monthlySp: 390, contextLimitTokens: 64_000, concurrency: 5 },
  { id: 'plus', monthlyYuan: 99, monthlySp: 990, contextLimitTokens: 256_000, concurrency: 20 },
  { id: 'max', monthlyYuan: 299, monthlySp: 2_990, contextLimitTokens: 1_000_000, concurrency: 60 },
]

/**
 * 找一档商品。
 * @param id - 服务端报的档位 id；未知档位返回 `null`。
 * @returns 对应商品，或 `null`。
 */
export function offerOf(id: string): TierOffer | null {
  return TIER_OFFERS.find(offer => offer.id === id) ?? null
}

/**
 * 每元买到多少 SP。用来解释"贵的那档每元更划算"——这是**可算出来的事实**，
 * 不是营销话术。
 * @param offer - 一档商品。
 * @returns SP/元；月费为 0 时返回 `null`（不制造 Infinity）。
 */
export function spPerYuan(offer: TierOffer): number | null {
  if (offer.monthlyYuan <= 0) return null
  return Math.round((offer.monthlySp / offer.monthlyYuan) * 100) / 100
}
