/**
 * 工单 8 · 第 ③ 步：健康探测真实化 —— "装了"≠"能用"。
 *
 * ## 这个模块防的是什么
 *
 * 本机现有的判定是"命令能跑出版本号就算 `verified`"（`supply/local-probe.ts`）。
 * 但那证明的只是**文件在**：模型能不能加载、显存够不够、插件绑定还在不在、执行器起不起得来，
 * 一个都没证。实测到的坏形状是**假健康** —— 本机说 `verified`，派单出去却干不了活。
 *
 * 所以这里的契约把话说死：**`invoked: true` 是 `ok` 的必要条件**。
 * 一个只报告"PATH 里有这个命令"的探测端口，会被判成 `missing`（原因 `PROBE_NOT_AN_INVOCATION`），
 * 而**不是**当成一次通过。失败项一律不进候选池，并且每一条都带可解释的原因。
 */
import type { CapabilityProbeOutcome, CapabilityProbePort } from './types.ts'
import {
  CAPABILITY_HEALTH_FAILURE_REASONS,
  type CapabilityHealth,
  type CapabilityHealthFailureReason,
  type CapabilityHealthObservation,
  type CapabilityHealthRefusal,
} from './types.ts'

export type {
  CapabilityProbeOutcome,
  CapabilityProbePort,
  CapabilityHealth,
  CapabilityHealthFailureReason,
  CapabilityHealthObservation,
  CapabilityHealthRefusal,
}
export { CAPABILITY_HEALTH_FAILURE_REASONS }

/** 端口把话吞了（没说细节）时用的兜底说明；主人至少要知道"这次没有细节"。 */
const NO_DETAIL = '（探测端口没有给出细节）'

/** 一次成功探测的默认说明：主人要知道"真的跑过"，而不是"文件在"。 */
const INVOKED_OK_DETAIL = '最小真实调用已执行并通过。'

/**
 * 对每一项能力各做一次**最小真实调用**，产出可解释的健康判定。
 *
 * 同名能力只探测一次（探测有真实代价，重复跑没有信息增益）。
 * @param capabilities - 待探测的契约能力名（可重复；结果按能力名排序）。
 * @param port - 真实调用的端口；抛错会被记成 `PROBE_THREW`，绝不静默成功。
 * @param signal - 可选取消信号，透传给端口。
 * @returns 每项能力一条判定；`health === 'ok'` 才允许进候选池。
 */
export async function probeCapabilityHealth(
  capabilities: readonly string[],
  port: CapabilityProbePort,
  signal?: AbortSignal,
): Promise<readonly CapabilityHealthObservation[]> {
  const unique = [...new Set(capabilities)].sort()
  const observations: CapabilityHealthObservation[] = []
  for (const capability of unique) {
    observations.push(await probeOne(capability, port, signal))
  }
  return observations
}

/**
 * 探测一项能力并把任何失败形态都翻译成可解释的判定。
 * @param capability - 契约能力名。
 * @param port - 真实调用端口。
 * @param signal - 可选取消信号。
 * @returns 这一项的健康判定。
 */
async function probeOne(capability: string, port: CapabilityProbePort, signal?: AbortSignal): Promise<CapabilityHealthObservation> {
  let outcome: CapabilityProbeOutcome
  try {
    outcome = await port.invoke(capability, signal)
  } catch (error) {
    return {
      capability,
      health: 'missing',
      invoked: false,
      reason: CAPABILITY_HEALTH_FAILURE_REASONS.THREW,
      detail: `探测端口自身失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const detail = typeof outcome.detail === 'string' && outcome.detail.trim() !== '' ? outcome.detail : NO_DETAIL
  if (!outcome.invoked) {
    // 关键分支：只报告"文件存在/命令在 PATH 里"不构成任何证据。
    return { capability, health: 'missing', invoked: false, reason: CAPABILITY_HEALTH_FAILURE_REASONS.NOT_AN_INVOCATION, detail }
  }
  if (!outcome.ok) {
    return {
      capability, health: 'missing', invoked: true,
      reason: outcome.reason ?? CAPABILITY_HEALTH_FAILURE_REASONS.NO_REASON_GIVEN,
      detail,
    }
  }
  if (outcome.degraded === true) {
    // 能跑但打折：按设计也不进候选池 —— 派出去就等于承诺做不到的事。
    return { capability, health: 'degraded', invoked: true, reason: CAPABILITY_HEALTH_FAILURE_REASONS.DEGRADED, detail }
  }
  return { capability, health: 'ok', invoked: true, reason: null, detail: detail === NO_DETAIL ? INVOKED_OK_DETAIL : detail }
}

/**
 * 只留下健康判定为 `ok` 的能力 —— 这就是候选池的全部。
 * @param observations - 第 ③ 步的判定。
 * @returns 排序去重后的候选能力名。
 */
export function candidateCapabilities(observations: readonly CapabilityHealthObservation[]): readonly string[] {
  return [...new Set(observations.filter(observation => observation.health === 'ok').map(observation => observation.capability))].sort()
}

/**
 * 没有进候选池的项与**原因**：主人问"为什么没有它"时唯一的出口。
 * @param observations - 第 ③ 步的判定。
 * @returns 每条拒收的能力名、原因码与细节，按能力名排序。
 */
export function healthRefusals(observations: readonly CapabilityHealthObservation[]): readonly CapabilityHealthRefusal[] {
  return observations
    .filter(observation => observation.health !== 'ok')
    .map(observation => ({
      capability: observation.capability,
      reason: observation.reason ?? CAPABILITY_HEALTH_FAILURE_REASONS.NO_REASON_GIVEN,
      detail: observation.detail,
    }))
    .sort((left, right) => (left.capability < right.capability ? -1 : 1))
}
