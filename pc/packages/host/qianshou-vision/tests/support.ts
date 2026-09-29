/**
 * Real Cordis compositions for vision status reads. The tool runtime, computer-use registry,
 * settings service and LLM service are the product ones; only the probe tool body and the
 * adapter's model answer are fixtures, because those are what the Host reads.
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import QianshouVision from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The provider name the Cua Driver native provider registers. */
export const PROVIDER = ComputerUseProviderName('cua-driver-native')

/** The tool name that provider publishes for its permission probe. */
export const PROBE = 'cua_driver_native__check_permissions'

/** Arguments one probe call received, recorded as the tool saw them. */
export interface ProbeCall {
  prompt: boolean | undefined
  probeDirectCapture: boolean | undefined
}

/** What the probe tool does when called. */
export type ProbeBehavior =
  /** Answer with this canonical value. */
  | { value: JsonValue }
  /** Throw inside the tool body, which the runtime turns into an error result. */
  | { throws: string }
  /** Never answer; only the caller's cancellation ends the call. */
  | { hangs: true }

/**
 * Define the provider-owned probe tool with a recording body.
 * @param name - published tool name; a non-matching name is how "no probe tool" is composed.
 * @param behavior - the answer or failure this probe produces.
 * @param calls - array each call appends its arguments to.
 * @returns A registry-ready tool definition.
 */
export function probeTool(name: string, behavior: ProbeBehavior, calls: ProbeCall[]): ToolDefinition {
  return defineTool({
    name,
    description: 'Read host desktop permissions.',
    parameters: { prompt: { type: 'boolean' }, probe_direct_capture: { type: 'boolean' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'probe' }] },
    execute: (args, exec) => {
      calls.push({ prompt: args.prompt, probeDirectCapture: args.probe_direct_capture })
      if ('throws' in behavior) throw new Error(behavior.throws)
      if ('hangs' in behavior) {
        return new Promise<never>((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(new Error('probe cancelled')) }, { once: true })
        })
      }
      return Promise.resolve(behavior.value)
    },
  })
}

/** Model metadata an adapter discloses for the resolved route. */
export type RouteAnswer =
  /** Disclose exactly these input modalities. */
  | { modalities: readonly ModelModality[] }
  /** Answer without disclosing modalities, which the default adapter also does. */
  | { undisclosed: true }
  /** Fail the lookup, as an unknown model id does. */
  | { throws: string }

/** Minimal real adapter: only exact-model resolution is exercised by vision. */
class RouteAdapter extends LlmAdapter {
  constructor(private readonly answer: RouteAnswer) {
    super()
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('RouteAdapter: vision never streams')
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if ('throws' in this.answer) return Promise.reject(new Error(this.answer.throws))
    const base: LlmResolvedModelInfo = { provider, id: model, name: model }
    return Promise.resolve('undisclosed' in this.answer
      ? base
      : { ...base, inputModalities: [...this.answer.modalities] })
  }
}

/** How one composition assembles the three components vision reads. */
export interface Composition {
  /** `absent` omits the computer-use service; `service` mounts it with no provider. */
  driver?: 'absent' | 'service' | 'provider'
  /** Tool name to publish, or null to publish none. */
  probe?: string | null
  /** Probe behavior; ignored when no tool is published. */
  behavior?: ProbeBehavior
  /** Default model route stored in settings, or null to store none. */
  route?: { provider: string; model: string } | null
  /** Adapter answer for the stored route; ignored when no route is stored. */
  answer?: RouteAnswer
  /** Provider ids the adapter is registered for, defaulting to the route's provider. */
  registered?: readonly string[]
  /** Plugin configuration overrides. */
  config?: Partial<Config>
}

/** A booted composition plus the observations a test asserts on. */
export interface Fixture {
  ctx: Context
  vision: Context['qianshouVision']
  /** The vision plugin's own fiber, disposable without tearing down the components it reads. */
  fiber: Awaited<ReturnType<Context['plugin']>>
  calls: ProbeCall[]
}

/**
 * Boot one composition with the vision plugin on top.
 * @param composition - which components exist and how they answer.
 * @param contexts - collected for the caller to dispose after each test.
 * @returns The Context, the vision service, its fiber, and the recorded probe calls.
 */
export async function fixture(composition: Composition, contexts: Context[]): Promise<Fixture> {
  const { driver = 'provider', probe = PROBE, behavior = { value: {} } } = composition
  const route = composition.route === undefined ? { provider: 'route-provider', model: 'route-model' } : composition.route
  const calls: ProbeCall[] = []
  const ctx = new Context()
  contexts.push(ctx)

  await ctx.plugin(MemorySettings, { doc: route === null ? {} : { 'agent-default-model': route } })
  ctx.settings.register('agent-default-model', Schema.object({ provider: Schema.string(), model: Schema.string() }))
  await ctx.plugin(LlmRuntime)
  if (route !== null) {
    const providers = composition.registered ?? [route.provider]
    if (providers.length > 0) ctx.llm.registerAdapter([...providers], new RouteAdapter(composition.answer ?? { undisclosed: true }))
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (driver !== 'absent') await ctx.plugin(ComputerUseRegistry)
  if (driver === 'provider') ctx.computerUse.register(PROVIDER)
  if (probe !== null) ctx.tools.register(probeTool(probe, behavior, calls))
  const fiber = await ctx.plugin(QianshouVision, composition.config as Config)
  return { ctx, vision: ctx.qianshouVision, fiber, calls }
}
