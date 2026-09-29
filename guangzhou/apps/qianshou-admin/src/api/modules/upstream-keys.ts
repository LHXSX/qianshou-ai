/**
 * §9 上游密钥：查看状态（`credential/list`）与更换（两步确认）。
 *
 * ## 这个模块的两条纪律
 *
 * 1. **明文只在这里出现，而且只往服务端送一次。** 界面上输入的密钥值由调用方
 *    通过闭包交给 `applyUpstreamKey`，不进组件状态之外的任何地方（不写 localStorage、
 *    不进 URL、不进日志）。类型里也没有任何"读回明文"的字段 —— 服务端根本不回。
 * 2. **不做任何权限判断。** 谁能看、谁能改全部由服务端决定；前端只在拿到 403 时
 *    如实提示，不做"按钮藏起来"这种假保险。
 */
import { apply, preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type {
  ApplyResult,
  ConfirmPreview,
  UpstreamKeysResult,
  UpstreamProbeOutcome,
} from '../types'

/** `POST credential/list`：密钥状态、生效机制、备份目录。 */
export async function fetchUpstreamKeys(): Promise<UpstreamKeysResult> {
  const response = await postJson<{ ok: true } & UpstreamKeysResult>(ENDPOINTS.credentialList, {})
  return {
    credentialsPath: response.credentialsPath,
    fileExists: response.fileExists === true,
    fileMode: response.fileMode ?? null,
    keys: response.keys ?? [],
    activation: response.activation,
    backups: response.backups,
  }
}

/**
 * 第一步：预览 + **真打一次上游**的连通性结论。
 *
 * 服务端在预览阶段就会用新密钥打一次上游：让管理员在按下确认之前就知道
 * 这把密钥能不能用，而不是等到执行完才发现。
 * @param ref - 引用名。
 * @param value - 候选密钥（只在这一跳里出现）。
 * @returns 令牌与差异（差异里只有指纹，没有明文）。
 */
export function preflightUpstreamKey(ref: string, value: string): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.credentialPreflight, { ref, value })
}

/**
 * 第二步：带令牌、原因与**载荷**执行。
 *
 * 载荷必须回传 `ref` 与 `value`：服务端用它们重算哈希，确认"管理员看到的"
 * 与"要执行的"是同一件事（改了内容会 `confirm_mismatch`）。
 * @param ref - 引用名。
 * @param value - 与预览时**完全一致**的密钥值。
 * @returns 执行结果（指纹、备份路径、是否需重启）。
 */
export function applyUpstreamKey(ref: string, value: string): (token: string, reason: string) => Promise<ApplyResult> {
  return async (token: string, reason: string) => await apply(ENDPOINTS.credentialApply, token, reason, { ref, value })
}

/** 从 `apply` 结果里取业务字段（服务端把密钥状态放在 `result` 里）。 */
export function writeResultOf(result: ApplyResult): Record<string, unknown> {
  return (result.result ?? {}) as Record<string, unknown>
}

/**
 * 从预览差异里取连通性结论。
 *
 * 服务端把探测结果放在 `diff.probe` 里（差异本身只有指纹）。这里做一次
 * 有边界的读取：认不出形状就返回 `undefined`，界面会如实显示"预览里没有探测信息"，
 * 而不是把 `undefined` 渲染成"通过"。
 * @param diff - 预览差异。
 * @returns 探测结论，或 `undefined`。
 */
export function probeOf(diff: { readonly before: unknown; readonly after: unknown }): UpstreamProbeOutcome | undefined {
  const probe = (diff as { readonly probe?: unknown }).probe
  if (probe === null || typeof probe !== 'object') return undefined
  return probe as UpstreamProbeOutcome
}
