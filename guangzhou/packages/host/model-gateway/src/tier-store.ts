/**
 * 订阅档位的存储。
 *
 * 为什么需要它：在此之前"档位"是从**上游账号角色**直接映射来的
 * （`personal→basic`、`pro→plus`、`enterprise→max`）。那是把两件不同的事当成了一件：
 * 账号角色是**平台上的身份**，而订阅档位是**用户花钱买到的权益**。
 * 不分开的后果很具体：
 * - 用户付了高级版的钱，但角色还是 `personal`，他拿到的仍是普通版额度；
 * - 管理员无法给某个账号开通/降级，只能去改平台角色——那是改权限，不是卖订阅；
 * - 订阅有**期限**（到期要降级），而角色没有期限。
 *
 * 所以这里引入一份独立的订阅记录：谁、买了哪档、何时开始、何时到期。
 * 它是**追加式**的（同账号可以有历史记录），当前档位取"此刻仍在有效期内"的那一条。
 *
 * 三条刻意的取舍：
 * 1. **没有记录就是普通版**。不是"没有记录就拒绝"——那样一次存储故障会让所有
 *    付费用户都用不了；退化成最低档至少"能用，只是额度少"，用户会来投诉，
 *    而不会以为产品坏了。
 * 2. **过期就是过期**，不宽限。宽限期是个产品决策，需要有人明确指定天数；
 *    自己拍一个 3 天等于悄悄送钱。要宽限就显式加一条记录。
 * 3. 落盘沿用账本那套（全量快照 + 原子替换 + `0600`）：订阅里含账号 id 与付费档位。
 */
import type { TierId } from './tiers.ts'

/** 订阅记录文件名。 */
export const TIER_STORE_FILENAME = '.qianshou-subscriptions.json'

/** 一条订阅记录。 */
export interface Subscription {
  readonly accountId: string
  readonly tier: TierId
  /** 生效时刻（毫秒）。 */
  readonly from: number
  /**
   * 到期时刻（毫秒）；`null` 表示不自动到期。
   *
   * 为什么允许 `null`：内部账号、赠送账号、员工账号确实有"长期有效"的情形。
   * 但**不要**拿它当默认——默认必须有期限，否则忘记续费就永远免费。
   */
  readonly to: number | null
  /** 谁开通的（管理员邮箱或 id）；留痕用。 */
  readonly grantedBy: string
  /** 为什么给（订单号、活动名、"内部账号"）。对账时靠它解释。 */
  readonly reason: string
}

/** 订阅存储与查询。 */
export interface TierStore {
  /**
   * 查某账号在某时刻的档位。
   * @param accountId - 账号。
   * @param at - 时刻（毫秒）。
   * @returns 有效档位；没有任何有效记录时返回 `null`。
   */
  readonly tierOf: (accountId: string, at: number) => TierId | null
  /**
   * 追加一条订阅记录。
   *
   * **只追加**：改一条历史记录会让"某人某段时间是什么档位"变得不可解释，
   * 而那是账单的依据。要纠正就给一条新的（可以立即生效）。
   * @param subscription - 记录。
   */
  readonly grant: (subscription: Subscription) => void
  /** 某账号的全部记录（含已过期），按生效时刻倒序。 */
  readonly historyOf: (accountId: string) => readonly Subscription[]
  /** 全部账号 id（管理面列表用）。 */
  readonly accounts: () => readonly string[]
  /** 导出供落盘。 */
  readonly snapshotOf: () => TierStoreSnapshot
  /** 从快照恢复。 */
  readonly restore: (snapshot: TierStoreSnapshot) => void
}

/** 落盘格式。 */
export interface TierStoreSnapshot {
  readonly version: number
  readonly savedAt: number
  readonly subscriptions: readonly Subscription[]
}

/** 落盘格式版本。 */
const FORMAT_VERSION = 1

/**
 * 建一个订阅存储。
 * @param options - 变更回调（用于落盘）。
 * @returns 存储实例。
 */
export function createTierStore(options: { readonly onChange?: () => void } = {}): TierStore {
  /** 按账号分组的追加式记录。 */
  const byAccount = new Map<string, Subscription[]>()
  const notify = options.onChange ?? (() => { /* 没接持久化就是纯内存 */ })

  return {
    tierOf: (accountId, at) => {
      const records = byAccount.get(accountId)
      if (records === undefined) return null
      /**
       * 取"此刻有效"的记录里**生效时刻最晚**的那一条。
       *
       * 为什么取最晚而不是第一条：追加式记录里，一次"升级"会留下两条都在有效期的记录
       * （旧那条若没写 `to`）。取最晚的那条才是用户最近一次的真实权益。
       */
      let chosen: Subscription | null = null
      for (const record of records) {
        if (record.from > at) continue
        if (record.to !== null && record.to <= at) continue
        if (chosen === null || record.from > chosen.from) chosen = record
      }
      return chosen?.tier ?? null
    },

    grant: (subscription) => {
      const records = byAccount.get(subscription.accountId)
      if (records === undefined) byAccount.set(subscription.accountId, [subscription])
      else records.push(subscription)
      notify()
    },

    historyOf: accountId => [...(byAccount.get(accountId) ?? [])].sort((left, right) => right.from - left.from),

    accounts: () => [...byAccount.keys()].sort(),

    snapshotOf: () => ({
      version: FORMAT_VERSION,
      savedAt: Date.now(),
      subscriptions: [...byAccount.values()].flat().sort((left, right) => left.from - right.from),
    }),

    restore: (snapshot) => {
      if (snapshot.version !== FORMAT_VERSION) return
      byAccount.clear()
      for (const record of snapshot.subscriptions) {
        const records = byAccount.get(record.accountId)
        if (records === undefined) byAccount.set(record.accountId, [record])
        else records.push(record)
      }
      // 恢复不算变更：否则冷启动会立刻把刚读到的文件再写一遍。
    },
  }
}
