/**
 * 订阅额度账本：**计量、扣减、五小时刹车、逐调用审计**。
 *
 * 与 `packages/host/billing-contract` 的分工要分清：那边是**节点收益**一侧的契约
 * （`task_earnings` / `platform_fee`，用户付钱、节点收钱）。本文件是**消费**一侧：
 * 用户的订阅额度怎么被模型调用花掉。两边名下有各自的账，**不互相结算**。
 *
 * 三个刻意设计：
 *
 * 1. **预留 → 结算**，而不是直接扣。放行时还不知道回答会有多长，只能按**最坏情况**预留；
 *    真响应回来才知道实际用量，那时把多预留的还回去。用平均值得出的预留会在长回答上超支。
 * 2. **五小时窗口是滚动的**，不是固定整点。这点我特意核对过大厂做法：OpenAI 的窗口
 *    「从你上一条消息开始计时」，不是"等整点刷新"。固定整点会让人在 59 分集中刷。
 * 3. **账本只追加，不修改**。每条记录带自己的时刻与用量，"某笔调用花了多少"永远可重建；
 *    需要撤销时追加一条反向记录，而不是去改历史。
 */

import type { LedgerSnapshot } from './persistence.ts'
import { isTierId, type TierId } from './tiers.ts'

/** 五小时刹车的窗口长度（毫秒）。 */
export const WINDOW_MS = 5 * 60 * 60 * 1000

/**
 * 账本的**内部整数单位**：1 SP = 1,000,000 微 SP。
 *
 * 为什么必须这样记：SP 是「钱」，而每次调用的实际花费是一个**小数**
 * （实测一次普通问答约 0.07 SP）。用浮点累加会漂移——`0.07` 累加若干次之后
 * 得到 `0.06999999999999318`，于是「按真实用量扣减」这件事在账面上是不准的，
 * 余额、五小时刹车、月度上限都会跟着偏，而且偏得没有规律。
 *
 * 换成整数微 SP 之后，记账是**精确**的整数加法，只在对外读数的边界上换算回 SP。
 * 1e-6 SP = 1e-4 元，比最小计费粒度细两个数量级，因此不损失任何定价精度。
 */
export const MICRO_SP_PER_SP = 1_000_000

/** 把对外读到的 SP 换回内部整数微 SP（四舍五入到最近 1 微 SP）。 */
function microOf(sp: number): number {
  return Math.round(sp * MICRO_SP_PER_SP)
}

/** 把内部整数微 SP 换算成对外读到的 SP。 */
function spOf(micro: number): number {
  return micro / MICRO_SP_PER_SP
}

/** 一条调用记录。 */
export interface CallRecord {
  /** 调用标识；预留与结算靠它对应。 */
  readonly callId: string
  readonly accountId: string
  readonly tier: TierId
  /** 前台模型名（记前台名，不记后端标识——账本里不该出现上游厂商）。 */
  readonly publishedName: string
  /** 实际作答的后端键（内部用，用于成本核对）。 */
  readonly backendKey: string
  /** 发生时刻（毫秒）。 */
  readonly at: number
  /** 输入 token（估算或上游回执）。 */
  readonly inputTokens: number
  /** 输出 token（上游回执；拿不到时为 0）。 */
  readonly outputTokens: number
  /** 本次实际消耗的 SP。 */
  readonly sp: number
}

/** 一笔预留。 */
interface Reservation {
  readonly callId: string
  readonly accountId: string
  /**
   * 预留在**哪个档位**下占的额度。
   *
   * 为什么预留要带档位（WP1 A-12）：额度是按「账号 + 账期 + 档位」授予的，所以结算时
   * 必须知道这笔钱该记到哪一份额度上。不带它就只能"用调用方此刻的档位"去算余额，
   * 而升档之后结算一笔旧预留会算错——错的是用户看到的剩余额度。
   */
  readonly tier: TierId
  readonly reservedSp: number
  readonly at: number
}

/** 一次扣减的结果。 */
export interface LedgerOutcome {
  /** 结算后本周期剩余 SP。 */
  readonly remainingSp: number
  /** 本次实际扣的 SP（可能小于预留）。 */
  readonly chargedSp: number
  /** 本次退回的 SP（预留与实际之差，不会为负）。 */
  readonly releasedSp: number
}

/** 账本的注入项。 */
export interface CreditLedgerOptions {
  /** 时钟；测试注入。 */
  readonly now?: () => number
  /** 每个账户的本月起始时刻（用于月度重置）；省略时按自然月。 */
  readonly periodStartOf?: (accountId: string, at: number) => number
  /**
   * 有变更时回调（同步，**不要在这里 await**）。
   *
   * 账本的判定与结算是同步的——网关要求"读额度+预留"中间不能有 `await`，
   * 否则并发请求会同时看到同一份余额。所以持久化不能塞进这里，
   * 只能打标记、由落盘层合并写。
   */
  readonly onChange?: () => void
}

/** 额度账本。 */
export interface CreditLedger {
  /** 授予/重置本周期额度；同一 (账号, 账期, 档位) 内重复调用不叠加。 */
  readonly grant: (accountId: string, tier: TierId, monthlySp: number) => void
  /** 放行时按最坏情况预留。 */
  readonly reserve: (input: { readonly callId: string; readonly accountId: string; readonly tier?: TierId; readonly sp: number }) => void
  /**
   * **原子地**「判额度 + 预留」。
   *
   * 为什么必须原子：`admit()` 与 `reserve()` 分成两步时有**会真花钱的竞态**——
   * 两个并发请求同时读到同一份余额、双双通过检查、双双预留，加起来超过余额。
   * 这里在同一次同步执行里完成检查与占位（中间没有 `await`，所以不会有别的请求插进来）。
   *
   * `admit()` 本身刻意**不**预留：它要能用来预览「这次大概花多少」而不产生副作用。
   * @param callId - 调用标识，结算/退回都靠它。
   * @param accountId - 哪個账户。
   * @param tier - 这次调用按哪个档位计（决定预留算到哪份额度上）。
   * @param plan - 由调用方传入的判定函数：拿到**此刻**的额度，返回放行（含预留量）或被拒。
   * @returns 判定函数的结果；放行时预留已经生效。
   */
  readonly admitAndReserve: <T>(input: {
    readonly callId: string
    readonly accountId: string
    readonly tier: TierId
    readonly plan: (credit: { readonly remainingMonthlySp: number; readonly usedInWindowSp: number }) => T
    /** 放行时从结果里取出要预留多少 SP；返回 `null` 表示这是拒绝、不预留。 */
    readonly reservedSpOf: (outcome: T) => number | null
  }) => T
  /**
   * 结算：按实际用量扣费，并把多预留的退回。
   * @param input - 调用标识、实际用量换算出的 SP，以及可选的用量明细。
   * @returns 结算结果。
   */
  readonly settle: (input: {
    readonly callId: string
    readonly sp: number
    readonly call?: Omit<CallRecord, 'callId' | 'accountId' | 'sp' | 'at'>
  }) => LedgerOutcome
  /** 调用失败时的收尾：全部退回，不计费（用户不该为没拿到的回答付钱）。 */
  readonly release: (callId: string) => LedgerOutcome
  /**
   * **部分结算**：按已经产生的成本扣费，其余释放；**不写入完整调用的审计记录**。
   *
   * 什么时候用它（这是一处真实漏洞的修法）：客户端**中途断开**时，
   * 上游已经把我们发过去的输入 token 都算过费了，也已生成了一部分输出。
   * 早先这种情况走的是 `release()`——**全额退回、不留任何痕迹**，
   * 于是"发一个大请求、200 毫秒后断开"就能白用，而且**月度上限与五小时刹车
   * 同时看不到这次调用**，可以无限重复。
   *
   * 为什么与 `settle` 分开而不是复用：`settle` 会写一条完整的 `CallRecord`
   * （含 input/output token），那是"一次完整调用"的语义；而这里是一次**未完成**的调用，
   * 记成完整调用会让对账看到不存在的请求。所以它只动额度、不留调用记录。
   * @param input - 调用标识与要扣的 SP。
   * @returns 结算结果。
   */
  readonly settlePartial: (input: { readonly callId: string; readonly sp: number }) => LedgerOutcome
  /** 当前额度状态，喂给 `admit()`。 */
  readonly creditOf: (accountId: string, tier: TierId) => { readonly remainingMonthlySp: number; readonly usedInWindowSp: number }
  /**
   * 这个 (账号, 账期, 档位) 是否**已经**授予过额度。
   *
   * 为什么要有它（WP1 A-12）：授予的幂等判据必须是"有没有授予过"这个**事实**，
   * 而不是"余额是不是 0"这种启发式。后者在月初还有窗口用量、或管理员刚升档时都会判错。
   * @param accountId - 账号。
   * @param tier - 档位。
   * @returns 本账期已授予时 `true`。
   */
  readonly isGranted: (accountId: string, tier: TierId) => boolean
  /** 某账户的调用记录（审计用），按时间倒序。 */
  readonly recordsOf: (accountId: string, limit?: number) => readonly CallRecord[]
  /**
   * 用一份快照恢复账本状态（冷启动时调用）。
   *
   * **不清空**已有状态、也不校验业务规则：它只负责把内存结构填回去。
   * 传进来的快照应当来自 {@link snapshotOf}，两者是同一个结构，避免"存一种、读另一种"。
   * @param state - 快照。
   */
  readonly restore: (state: LedgerSnapshot) => void
  /** 导出当前状态供落盘。 */
  readonly snapshotOf: () => LedgerSnapshot
}

/** 自然月起点：当月 1 日 00:00（本地时区，与用户看到的账单周期一致）。 */
function defaultPeriodStart(_accountId: string, at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

/**
 * 建一个额度账本。
 *
 * 内存实现：它服务于**单进程**的网关。落库是另一件事（需要事务与并发控制），
 * 而那应当由部署方接自己的存储——本文件只定义**语义**，不假装自己是数据库。
 * @param options - 时钟与账期起点。
 * @returns 账本实例。
 */
export function createCreditLedger(options: CreditLedgerOptions = {}): CreditLedger {
  const now = options.now ?? (() => Date.now())
  const periodStartOf = options.periodStartOf ?? defaultPeriodStart
  /** 变更通知：同步打标记，落盘由持久化层合并完成。 */
  const notify = options.onChange ?? (() => { /* 没接持久化就是纯内存账本 */ })

  /**
   * 已授予的额度，键为「账号 + 档位」；值里带**账期起点**。
   *
   * 为什么键要带上档位（WP1 A-12）：额度是"某账号在某账期拿到某档位多少 SP"。
   * 早先只按账号记一份，于是同一个账期里先到的调用决定了整期额度——先在 `basic`
   * 上授予了 390，管理员后来给他开到 `max`，他也还是只有 390，直到耗尽为止；
   * 反过来两条路由分别按不同档位授予时，谁先到谁说话。
   * 带上档位之后，升档就是"这个 (账号, 账期, max) 还没有授予过"→ 立刻按新档位授予。
   */
  const granted = new Map<string, { readonly microSp: number; readonly periodStart: number }>()
  /** 未结算的预留。 */
  /** 未结算的预留；值里同样以微 SP 记账。 */
  const reservations = new Map<string, Reservation & { readonly microSp: number }>()
  /** 追加式调用记录。 */
  const records: CallRecord[] = []
  /**
   * 未完成调用已经产生的扣费（按 callId 与发生时刻记）。
   *
   * 为什么要**单独**记而不是写进 `records`：`records` 的语义是"一次完整调用"，
   * 把中途断开的调用记进去会让对账看到不存在的请求。
   * 但钱必须留在**能被 spent 统计看到**的地方——早先直接 return 不记，
   * 结果扣的钱连同漏洞一起消失了（**我自己的测试当场抓到了这一点**）。
   */
  const partialCharges = new Map<string, { readonly accountId: string; readonly microSp: number; readonly at: number }>()

  /** 授予记录的键。用不可打印字符分隔，避免账号里出现分隔符时两把钥匙撞成一把。 */
  const grantKey = (accountId: string, tier: TierId): string => `${accountId}\u0000${tier}`

  /** 某账户本周期内的记录（跨周期的不算）。 */
  const recordsInPeriod = (accountId: string): readonly CallRecord[] => {
    const at = now()
    const start = periodStartOf(accountId, at)
    return records.filter(record => record.accountId === accountId && record.at >= start)
  }

  /** 本周期已花费（含未结算的预留——否则并发请求会同时看到同一份余额）。 */
  const spentInPeriod = (accountId: string): number => {
    const start = periodStartOf(accountId, now())
    const settled = recordsInPeriod(accountId).reduce((sum, record) => sum + microOf(record.sp), 0)
    const partial = [...partialCharges.values()]
      .filter(item => item.accountId === accountId && item.at >= start)
      .reduce((sum, item) => sum + item.microSp, 0)
    const held = [...reservations.values()]
      .filter(item => item.accountId === accountId && item.at >= start)
      .reduce((sum, item) => sum + item.microSp, 0)
    return settled + partial + held
  }

  /** 五小时滚动窗口内已用（同样含预留）。 */
  const spentInWindow = (accountId: string): number => {
    const since = now() - WINDOW_MS
    const settled = records
      .filter(record => record.accountId === accountId && record.at >= since)
      .reduce((sum, record) => sum + microOf(record.sp), 0)
    const partial = [...partialCharges.values()]
      .filter(item => item.accountId === accountId && item.at >= since)
      .reduce((sum, item) => sum + item.microSp, 0)
    const held = [...reservations.values()]
      .filter(item => item.accountId === accountId && item.at >= since)
      .reduce((sum, item) => sum + item.microSp, 0)
    return settled + partial + held
  }

  /** 本周期已授予多少（**按档位**：升档后新档位尚未授予，返回 0）。 */
  const grantOf = (accountId: string, tier: TierId): number => {
    const at = now()
    const start = periodStartOf(accountId, at)
    const entry = granted.get(grantKey(accountId, tier))
    // 跨周期就等于没授予过：调用方应当先 grant 再放行。
    return entry !== undefined && entry.periodStart === start ? entry.microSp : 0
  }

  /** 把内部微 SP 读数换回对外的 SP。 */
  const balanceOf = (accountId: string, tier: TierId): number =>
    spOf(Math.max(0, grantOf(accountId, tier) - spentInPeriod(accountId)))

  /**
   * 统一收尾读数。
   *
   * `chargedSp` / `releasedSp` 也**必须来自整数**：实测 `held.reservedSp - charged`
   * 直接相减会给出 `3.4000000000000004`——余额已经精确了，随口报出的回退量却带着尾巴，
   * 这种不一致比整体不精确更难查。
   */
  const outcomeOf = (accountId: string, tier: TierId, chargedMicro: number, releasedMicro: number): LedgerOutcome => ({
    remainingSp: balanceOf(accountId, tier),
    chargedSp: spOf(chargedMicro),
    releasedSp: spOf(releasedMicro),
  })

  return {
    grant: (accountId, tier, monthlySp) => {
      const at = now()
      granted.set(grantKey(accountId, tier), { microSp: microOf(monthlySp), periodStart: periodStartOf(accountId, at) })
      notify()
    },

    reserve: ({ callId, accountId, tier, sp }) => {
      reservations.set(callId, {
        callId,
        accountId,
        tier: tier ?? 'basic',
        reservedSp: sp,
        microSp: microOf(sp),
        at: now(),
      })
      notify()
    },

    admitAndReserve: ({ callId, accountId, tier, plan, reservedSpOf }) => {
      // 这一段必须是同步的：任何时候只要插入 await，检查与预留之间就出现窗口。
      const credit = {
        remainingMonthlySp: balanceOf(accountId, tier),
        usedInWindowSp: spOf(spentInWindow(accountId)),
      }
      const outcome = plan(credit)
      const reservedSp = reservedSpOf(outcome)
      if (reservedSp !== null) {
        reservations.set(callId, { callId, accountId, tier, reservedSp, microSp: microOf(reservedSp), at: now() })
        notify()
      }
      return outcome
    },

    settle: ({ callId, sp, call }) => {
      const held = reservations.get(callId)
      if (held === undefined) {
        // 没有预留就结算：说明调用方跳过了放行，或者重复结算。两种都不该静默吞掉。
        throw new Error(`没有找到这笔预留：${callId}`)
      }
      reservations.delete(callId)
      const chargedMicro = Math.max(0, microOf(sp))
      const charged = spOf(chargedMicro)
      const releasedMicro = Math.max(0, held.microSp - chargedMicro)
      records.push({
        callId,
        accountId: held.accountId,
        at: now(),
        sp: charged,
        tier: call?.tier ?? held.tier,
        publishedName: call?.publishedName ?? '',
        backendKey: call?.backendKey ?? '',
        inputTokens: call?.inputTokens ?? 0,
        outputTokens: call?.outputTokens ?? 0,
      })
      notify()
      return outcomeOf(held.accountId, held.tier, chargedMicro, releasedMicro)
    },

    settlePartial: ({ callId, sp }) => {
      const held = reservations.get(callId)
      if (held === undefined) {
        // 与 settle/release 同样的纪律：没有预留就结算说明调用方跳过了放行。
        throw new Error(`没有找到这笔预留：${callId}`)
      }
      reservations.delete(callId)
      // 按预留封顶：传一个比预留大的数不能把余额扣成负数。
      const chargedMicro = Math.min(Math.max(0, microOf(sp)), held.microSp)
      const releasedMicro = Math.max(0, held.microSp - chargedMicro)
      // 刻意**不 push 到 records**：这不是一次完整调用。
      // 但钱要留在能被 spent 统计看到的地方，否则这次扣费等于没发生。
      if (chargedMicro > 0) {
        partialCharges.set(callId, { accountId: held.accountId, microSp: chargedMicro, at: now() })
      }
      notify()
      return outcomeOf(held.accountId, held.tier, chargedMicro, releasedMicro)
    },

    release: (callId) => {
      const held = reservations.get(callId)
      if (held === undefined) throw new Error(`没有找到这笔预留：${callId}`)
      reservations.delete(callId)
      // 调用失败不计费：用户没拿到回答，就不该为它付钱。
      notify()
      return outcomeOf(held.accountId, held.tier, 0, held.microSp)
    },

    creditOf: (accountId, tier) => ({
      remainingMonthlySp: balanceOf(accountId, tier),
      usedInWindowSp: spOf(spentInWindow(accountId)),
    }),

    isGranted: (accountId, tier) => {
      const entry = granted.get(grantKey(accountId, tier))
      return entry !== undefined && entry.periodStart === periodStartOf(accountId, now())
    },

    restore: (state) => {
      // 快照里的单位是微 SP，直接塞回内部结构，不再换算（避免二次取整）。
      for (const entry of state.grants) {
        granted.set(grantKey(entry.accountId, entry.tier), { microSp: entry.microSp, periodStart: entry.periodStart })
      }
      for (const entry of state.partialCharges) {
        partialCharges.set(entry.callId, { accountId: entry.accountId, microSp: entry.microSp, at: entry.at })
      }
      for (const entry of state.reservations) {
        reservations.set(entry.callId, {
          callId: entry.callId,
          accountId: entry.accountId,
          tier: entry.tier,
          reservedSp: spOf(entry.microSp),
          microSp: entry.microSp,
          at: entry.at,
        })
      }
      for (const entry of state.records) {
        if (!isTierId(entry.tier)) continue
        records.push({
          callId: entry.callId,
          accountId: entry.accountId,
          tier: entry.tier,
          publishedName: entry.publishedName,
          backendKey: entry.backendKey,
          at: entry.at,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          sp: spOf(entry.microSp),
        })
      }
      // 恢复本身不算变更：否则冷启动会立刻把刚读到的文件再写一遍。
    },

    snapshotOf: () => ({
      version: 1,
      savedAt: now(),
      grants: [...granted.entries()].map(([key, entry]) => ({
        accountId: key.slice(0, key.indexOf('\u0000')),
        tier: key.slice(key.indexOf('\u0000') + 1) as TierId,
        microSp: entry.microSp,
        periodStart: entry.periodStart,
      })),
      partialCharges: [...partialCharges.entries()].map(([callId, entry]) => ({
        callId,
        accountId: entry.accountId,
        microSp: entry.microSp,
        at: entry.at,
      })),
      reservations: [...reservations.values()].map(entry => ({
        callId: entry.callId,
        accountId: entry.accountId,
        tier: entry.tier,
        microSp: entry.microSp,
        at: entry.at,
      })),
      records: records.map(entry => ({
        callId: entry.callId,
        accountId: entry.accountId,
        tier: entry.tier,
        publishedName: entry.publishedName,
        backendKey: entry.backendKey,
        at: entry.at,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        microSp: microOf(entry.sp),
      })),
    }),

    recordsOf: (accountId, limit = 50) =>
      records
        .filter(record => record.accountId === accountId)
        .slice(-limit)
        .reverse(),
  }
}
