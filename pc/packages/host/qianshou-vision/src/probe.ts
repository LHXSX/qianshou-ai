/** The three independent vision facts, each read from the component that owns it. */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-settings'
import type { VisionDriverFact, VisionPermissionFact, VisionRouteFact } from './types.ts'

/**
 * Provider-owned permission probe as Cua Driver publishes it: the native provider
 * prefixes `cua_driver_native__`, the MCP provider `mcp__cua-driver-mcp__`.
 */
const PROBE_TOOL = /(?:^|__)check_permissions$/u

/**
 * Observe whether the computer-use service and a provider are assembled in this Host.
 * @param ctx - Host Context; both services are read without an inject requirement.
 * @returns Assembly state, provider name, and the provider's permission probe tool when published.
 */
export function driverFact(ctx: Context): VisionDriverFact {
  const registry = ctx.get('computerUse')
  if (registry === undefined) return { state: 'absent', provider: null, probeTool: null }
  const provider = registry.providerName
  if (provider === undefined) return { state: 'service-only', provider: null, probeTool: null }
  const probeTool = ctx.get('tools')?.schemas().map(schema => schema.name).find(name => PROBE_TOOL.test(name)) ?? null
  return { state: 'registered', provider, probeTool }
}

/** Read an untrusted JSON object without accepting arrays. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Decode Cua Driver's `check_permissions` result without trusting its free text.
 * @param value - canonical tool value, an MCP result carrying `structuredContent`.
 * @returns Both TCC grants, or undefined when the result lacks the two booleans.
 */
export function permissionsOf(value: unknown): { accessibility: boolean; screenRecording: boolean } | undefined {
  const structured = object(object(value)?.structuredContent)
  if (structured === undefined) return undefined
  const accessibility = structured.accessibility
  const screenRecording = structured.screen_recording
  if (typeof accessibility !== 'boolean' || typeof screenRecording !== 'boolean') return undefined
  return { accessibility, screenRecording }
}

/**
 * Run the provider's own permission probe. `prompt: false` reads TCC status only;
 * `prompt: true` is the explicit user action that raises the OS dialogs.
 * @param tools - tool registry holding the provider's tools, or undefined when none is mounted.
 * @param driver - current driver assembly; an absent probe tool yields `unknown` rather than a guess.
 * @param prompt - whether missing grants may raise the system permission dialogs.
 * @param signal - caller-owned cancellation for the tool call.
 * @returns Grant booleans when the probe answered, otherwise `unknown` with the reason.
 */
export async function permissionFact(
  tools: ToolRuntime | undefined, driver: VisionDriverFact, prompt: boolean, signal: AbortSignal,
): Promise<VisionPermissionFact> {
  const unknown = (reason: VisionPermissionFact['reason']): VisionPermissionFact =>
    ({ state: 'unknown', accessibility: null, screenRecording: null, reason })
  if (driver.state !== 'registered') return unknown('no-provider')
  if (driver.probeTool === null || tools === undefined) return unknown('no-probe-tool')
  let result
  try {
    result = await tools.execute({
      name: driver.probeTool, callId: ToolCallId(`qianshou-vision-${prompt ? 'request' : 'probe'}-${Date.now()}`),
      // `probe_direct_capture: false` keeps a request staged: Accessibility and Screen Recording only,
      // without the ScreenCaptureKit direct-capture consent the driver would otherwise add.
      arguments: prompt ? { prompt: true, probe_direct_capture: false } : { prompt: false }, signal,
    })
  } catch {
    return unknown('probe-failed')
  }
  if (result.isError) return unknown('probe-failed')
  const grants = permissionsOf(result.value)
  if (grants === undefined) return unknown('unrecognized-result')
  return {
    state: grants.accessibility && grants.screenRecording ? 'granted' : 'missing',
    accessibility: grants.accessibility, screenRecording: grants.screenRecording, reason: null,
  }
}

/**
 * Resolve the default model route's disclosed modalities through the adapter that owns it,
 * the same lookup screenshot admission performs before storing an image.
 * @param ctx - Host Context providing `settings` and `llm`.
 * @param signal - caller-owned cancellation for adapter lookup.
 * @returns Route identity plus image acceptance; `null` acceptance means the adapter disclosed nothing.
 */
export async function routeFact(ctx: Context, signal: AbortSignal): Promise<VisionRouteFact> {
  const selected = object(ctx.settings.get('agent-default-model'))
  const provider = typeof selected?.provider === 'string' ? selected.provider : null
  const model = typeof selected?.model === 'string' ? selected.model : null
  const fact = (inputModalities: string[] | null, reason: VisionRouteFact['reason']): VisionRouteFact => ({
    provider, model, inputModalities,
    acceptsImage: inputModalities === null ? null : inputModalities.includes('image'), reason,
  })
  if (provider === null || model === null) return fact(null, 'no-default-model')
  let info
  try {
    info = await ctx.llm.resolveModelInfo(provider, model, signal)
  } catch {
    return fact(null, 'unresolvable')
  }
  if (info.inputModalities === undefined) return fact(null, 'modalities-undisclosed')
  return fact([...info.inputModalities], null)
}
