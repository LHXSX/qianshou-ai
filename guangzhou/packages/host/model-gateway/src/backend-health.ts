/**
 * 后端健康与冷却：**让声明的备用后端真的会被用上**。
 *
 * ## 为什么需要它（一处"声明了但没执行"的缺陷）
 *
 * 模型路由控制台让我们给一个前台名字绑**有序的后端列表**（`backendKeys`），
 * 并宣称"主后端打满或故障时按顺序落到备用"。但实际运行时只取了 `backends[0]`——
 * **列表里后面的那些永远不会被调用**。于是控制台上配的备用后端是一句空话，
 * 而用户会一直卡在坏掉的那个上游上，表现是"所有人都发不出消息，换绑之前没法自愈"。
 * （开源对比时在 one-api 里看到同一类缺陷：schema 里有个 `Channel.Weight` 字段，
 * 但逻辑里从不读它。**这类"死配置"比没有配置更糟**，因为它让人以为已经防住了。）
 *
 * ## 为什么是"冷却"而不是"同一次请求里重试"
 *
 * 流式请求已经开始往客户端推字之后再换后端，会把两家模型的输出**接在一起**，
 * 输出是坏的；而重试还可能让上游**重复计费**（第一次其实已经生成了一部分）。
 * 所以这里不做请求内重试，而是把失败记下来，**让下一次请求直接选下一个健康后端**。
 * 代价是"第一次失败的用户确实失败了"，换来的是不会有拼接输出、不会双重扣费。
 *
 * ## 刻意不做"自动恢复探测"
 *
 * 冷却期满后就直接当它恢复了，让下一次真实请求当探针。
 * 自己起后台任务去探活会引入新的失败面（探测本身失败怎么办、探测把上游打疼怎么办），
 * 而真实的用户请求本来就是最好的探针。
 */
import type { BackendModel } from './tiers.ts'

/** 冷却配置。 */
export interface BackendHealthConfig {
  /** 连续失败到几次就进入冷却。默认 2（偶发一次网络抖动不该立刻切走）。 */
  readonly failThreshold?: number
  /** 冷却时长（毫秒）。默认 60 秒。 */
  readonly cooldownMs?: number
  /** 时钟；测试注入。 */
  readonly now?: () => number
}

/** 一个后端的健康状态。 */
export interface BackendHealth {
  /**
   * 从**有序列表**里挑第一个可用的后端。
   *
   * 顺序由调用方给（来自控制台的绑定），这里只跳过正在冷却的。
   * 全都冷却时**返回第一个**——宁可试一下也不要让用户完全发不出消息；
   * 全坏的情况本来就无解，交给上游按时回错。
   * @param backends - 有序的后端列表。
   * @returns 选中的后端，以及是否发生了回落。
   */
  readonly pick: (backends: readonly BackendModel[]) => { readonly backend: BackendModel; readonly fellBack: boolean }
  /** 记一次失败；达到阈值就进入冷却。 */
  readonly recordFailure: (backendKey: string) => void
  /** 记一次成功；清掉失败计数与冷却。 */
  readonly recordSuccess: (backendKey: string) => void
  /** 某个后端当前是否在冷却中（诊断与测试用）。 */
  readonly isCooling: (backendKey: string) => boolean
}

/**
 * 建一个后端健康跟踪器。
 * @param config - 阈值、冷却时长与时钟。
 * @returns 跟踪器实例。
 */
export function createBackendHealth(config: BackendHealthConfig = {}): BackendHealth {
  const failThreshold = config.failThreshold ?? 2
  const cooldownMs = config.cooldownMs ?? 60_000
  const now = config.now ?? (() => Date.now())
  /** 后端键 → 连续失败次数与进入冷却的时刻。 */
  const state = new Map<string, { failures: number; coolingUntil: number }>()

  /** 后端键是**模型标识**还是控制台键位？用 `BackendModel.id` —— 那才是真正发出去的东西。 */
  const keyOf = (backend: BackendModel): string => backend.id

  return {
    pick: (backends) => {
      if (backends.length === 0) throw new Error('后端列表为空')
      const at = now()
      for (let index = 0; index < backends.length; index += 1) {
        const backend = backends[index] as BackendModel
        const entry = state.get(keyOf(backend))
        if (entry === undefined || entry.coolingUntil <= at) {
          return { backend, fellBack: index > 0 }
        }
      }
      // 全都在冷却：回第一个。让用户至少还能试，而不是直接告诉他不许用。
      return { backend: backends[0] as BackendModel, fellBack: false }
    },

    recordFailure: (backendKey) => {
      const entry = state.get(backendKey) ?? { failures: 0, coolingUntil: 0 }
      const failures = entry.failures + 1
      state.set(backendKey, {
        failures,
        // 达到阈值才冷却；没达到只是计数，避免一次抖动就把客户切到别的上游。
        coolingUntil: failures >= failThreshold ? now() + cooldownMs : entry.coolingUntil,
      })
    },

    recordSuccess: (backendKey) => {
      // 成功即清零：冷却期满后的**第一次真实请求**就是探针，成功了就恢复正常优先级。
      state.delete(backendKey)
    },

    isCooling: (backendKey) => {
      const entry = state.get(backendKey)
      return entry !== undefined && entry.coolingUntil > now()
    },
  }
}
