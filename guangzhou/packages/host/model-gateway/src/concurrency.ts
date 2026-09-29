/**
 * 分档并发上限的执行器。
 *
 * 为什么需要它：档位表里早就写了 `concurrency`（普通 5 / 高级 20 / Max 60），
 * 但那个数字此前**只被显示、从未被执行**——额度状态接口把它读出来给界面看，
 * 判定链里却没有任何一行用它。结果是五条并行的长对话和六十条并行占用完全一样。
 *
 * 为什么这条限制值得存在（而不只是好看）：**并发是成本风险，不是体验选项**。
 * 每个在飞请求都会让上游同时开着一条流，上游按并发计费与限流；一个人开六十条
 * 会把整档的容量占住，其他人全部排队。所以它是防滥用的刹车，与五小时额度互补：
 * 额度管"总量"，并发管"瞬时"。
 *
 * 实现取一个**同步**的计数表：Node 是单线程，`acquire` 里没有任何 `await`，
 * 所以"读计数 → 判断 → 加一"不会有窗口，不需要锁。
 *
 * 三个键空间刻意分开，方便定位是谁满了：
 * - `account:<id>`：某个账户开了多少条（档位限制）；
 * - `backend:<key>`：某个后端被开了多少条（容量保护）；
 * - `global`：整个进程开了多少条（总闸）。
 */

/**
 * 我们自己的进程向上游**同时**开多少条流的上限。
 *
 * 为什么不是直接用后端公布的并发数（`deepseek-flash` 2500 / `deepseek-v4-pro` 500）：
 * 那个数字是**账号级**容量，属于我们整个平台在上游那边的额度，不是单个进程能安全打满的量。
 * 真按 2500 放行，一次流量尖峰会把上游连接数瞬间拉满，结果是我们**整体**开始被上游拒——
 * 而用户看到的是一连串失败。取一个远低于它、但足够用的进程内上限，
 * 让过载表现为"其中一部分请求排队/被礼貌拒绝"，而不是"所有人都坏掉"。
 *
 * 这个值是可运维的：真实压力下按观测调，而不是拍脑袋定死。
 */
export const DEFAULT_BACKEND_STREAM_CAP = 64

/** 并发上限的执行器。 */
export interface ConcurrencyGuard {
  /**
   * 尝试为某个账户占一个并发位。
   * @param accountId - 账户。
   * @param limit - 该档位的并发上限。
   * @returns 放行时给 `release`，被拒时给拒绝原因。
   */
  readonly acquire: (accountId: string, limit: number) => ConcurrencySlot
  /** 某个账户当前在飞数量（诊断与测试用）。 */
  readonly inFlightOf: (accountId: string) => number
  /** 某个后端当前在飞数量。 */
  readonly backendInFlightOf: (backendKey: string) => number
  /** 整个进程当前在飞数量。 */
  readonly totalInFlight: () => number
  /**
   * 占一个**后端容量**位（与账户额度无关）。
   * @param backendKey - 后端键位（`flash` / `pro`）。
   * @param cap - 我们允许同时打开多少条。
   */
  readonly acquireBackend: (backendKey: string, cap: number) => ConcurrencySlot
  /**
   * 占一个**进程总闸**位，防止过载。
   * @param cap - 总并发上限。
   */
  readonly acquireGlobal: (cap: number) => ConcurrencySlot
}

/** 一个并发位：放行时给归还函数，被拒时给原因。 */
export type ConcurrencySlot =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly message: string }

/**
 * 建一个并发执行器。
 * @returns 执行器实例。
 */
export function createConcurrencyGuard(): ConcurrencyGuard {
  const inFlight = new Map<string, number>()

  return {
    acquire: (accountId, limit) => {
      const current = inFlight.get(accountId) ?? 0
      if (current >= limit) {
        return {
          ok: false,
          message: `同时进行的对话已达上限（${limit} 条）。等其中一条结束再继续——`
            + '这是防止单账号占满整档容量的刹车，不是永久限制。',
        }
      }
      inFlight.set(accountId, current + 1)
      /** 只放行一次：重复调 `release` 不能把计数减成负数。 */
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          const held = (inFlight.get(accountId) ?? 1) - 1
          if (held <= 0) inFlight.delete(accountId)
          else inFlight.set(accountId, held)
        },
      }
    },
    inFlightOf: accountId => inFlight.get(accountId) ?? 0,
    backendInFlightOf: backendKey => inFlight.get(`backend:${backendKey}`) ?? 0,
    totalInFlight: () => inFlight.get('global') ?? 0,
    acquireBackend: (backendKey, cap) => {
      const key = `backend:${backendKey}`
      if ((inFlight.get(key) ?? 0) >= cap) {
        return {
          ok: false,
          message: '当前访问量较大，这条请求没有排上。稍等片刻再发——'
            + '这不是你的额度问题，是我们在保护上游连接不被拉满。',
        }
      }
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          const held = (inFlight.get(key) ?? 1) - 1
          if (held <= 0) inFlight.delete(key)
          else inFlight.set(key, held)
        },
      }
    },
    acquireGlobal: (cap) => {
      if ((inFlight.get('global') ?? 0) >= cap) {
        return {
          ok: false,
          message: '服务器当前繁忙，这条请求没有排上。稍等片刻再发。',
        }
      }
      inFlight.set('global', (inFlight.get('global') ?? 0) + 1)
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          const held = (inFlight.get('global') ?? 1) - 1
          if (held <= 0) inFlight.delete('global')
          else inFlight.set('global', held)
        },
      }
    },
  }
}
