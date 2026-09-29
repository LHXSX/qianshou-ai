/** Optional CEO tools: observed capabilities, local planning and owner workload reads. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.ts'
import { ComputeError } from './errors.ts'
import { planDraftCardMeta } from './draft-card-meta.ts'
import { chainDraftCardMeta } from './chain-store.ts'
import { COMPUTE_HONESTY_PROMPT, COMPUTE_HONESTY_SECTION, COMPUTE_HONESTY_SECTION_ORDER } from './honesty.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Optional tool consumer identity. */
export const name = 'qianshou-compute-tools'
/** Only explicitly selected agent scopes receive these tools. */
export const inject = ['tools', 'computeCore']
/** Limit an inspection-only preset to observed capability and existing receipt reads. */
export interface Config {
  /** Omit planning and submission tools while retaining capability and receipt reads. */
  readonly observationOnly?: boolean
}
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

/** The account picker is a cached text-model catalog, not a Guangzhou capability or health endpoint. */
async function cloudCatalog(ctx: Context, signal: AbortSignal) {
  signal.throwIfAborted()
  const unavailable = (reason: string) => ({
    status: 'unreachable' as const, reason, textModels: null as string[] | null,
    textModelHealth: 'not_observed' as const, imageGeneration: 'not_observed' as const,
    videoGeneration: 'not_observed' as const, pluginMarket: 'not_observed' as const,
    price: null,
  })
  try {
    const candidate: unknown = ctx.get('qianshouAccount')
    if (candidate === null || typeof candidate !== 'object' || !('state' in candidate)
      || typeof candidate.state !== 'function') return unavailable('account_service_not_loaded')
    const snapshot: unknown = await candidate.state()
    signal.throwIfAborted()
    if (snapshot === null || typeof snapshot !== 'object' || !('phase' in snapshot)
      || !('models' in snapshot) || !Array.isArray(snapshot.models)) return unavailable('account_snapshot_failed')
    if (snapshot.phase !== 'authenticated') return unavailable('account_not_authenticated')
    return { ...unavailable(''), status: 'observed' as const, reason: null,
      textModels: snapshot.models.filter((model): model is string => typeof model === 'string') }
  } catch (error) {
    if (signal.aborted) throw error
    return unavailable('account_snapshot_failed')
  }
}

/** Register model-visible operations; the existing tool log records every call and receipt.
 * @param ctx - The selected agent scope with the Host compute service.
 * @param config - Optional inspection-only mode; ordinary CEO/calling scopes retain planning tools.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.observationOnly !== undefined && typeof config.observationOnly !== 'boolean') {
    throw new Error('COMPUTE_TOOLS_OBSERVATION_CONFIG_INVALID')
  }
  const registerPlanning = (tool: Parameters<typeof ctx.tools.register>[0]): void => {
    if (config.observationOnly !== true) ctx.tools.register(tool)
  }
  ctx.tools.register(defineTool({
    name: 'compute_cloud_catalog',
    description: 'Read the signed-in Qianshou account’s cached Guangzhou text-model catalog. This is a catalog observation, not a live model health check. Guangzhou image, video, plugin-market availability and prices are not in this account catalog, so report them as unknown. Do not infer all backend capability from an image route or a model name.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return JSON.stringify(await cloudCatalog(ctx, exec.signal))
    },
    presentCall: () => ({ card: 'generic', title: '查询千手云服务目录', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_capability_landscape',
    description: 'One read-only view for natural conversation: separately observe cached Guangzhou text models, Shanghai live semantic registry/developer entry, local registered executors and the last completed local supply probe. Use it before advising where a task could run or whether to make a plugin. Unknown sources stay unknown. This does not probe current local health, inspect all Guangzhou media services, check current workers, quote, install, dispatch, charge or enable order intake. For a relevant Shanghai registry name call compute_pool next.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const [guangzhou, discovery] = await Promise.all([
        cloudCatalog(ctx, exec.signal), ctx.computeCore.capabilityDiscovery(exec.signal),
      ])
      exec.signal.throwIfAborted()
      const previous = ctx.computeCore.lastObservedSupply()
      const registry = discovery.registry
      const developer = discovery.requestableTaskTypes
      return JSON.stringify({
        guangzhou: { source: 'account-cached-model-catalog', ...guangzhou,
          mediaServiceHealth: 'not_observed', catalogFreshness: 'cached' },
        shanghai: {
          source: 'live-semantic-registry', status: registry.status,
          observedAt: registry.observedAt, reason: registry.reason,
          registryVersion: registry.registryVersion,
          capabilities: registry.capabilities?.slice(0, 50).map(item => ({
            id: item.capability, implementations: item.implementations,
            legacyTaskTypes: item.legacyTaskTypes,
          })) ?? null,
          total: registry.capabilities?.length ?? null,
          truncated: (registry.capabilities?.length ?? 0) > 50,
          developerEntry: { status: developer.status, observedAt: developer.observedAt,
            reason: developer.reason, taskTypes: developer.items?.map(item => item.taskType) ?? null },
          liveWorkersChecked: false,
        },
        local: {
          source: 'host-executor-registry-and-last-supply-probe',
          registeredExecutors: ctx.computeCore.executors.list().map(({ capabilityId, version }) => ({ capabilityId, version })),
          lastObservedAt: previous?.observedAt ?? null,
          observedServiceCount: previous?.localServices.length ?? null,
          observedServicesTruncated: (previous?.localServices.length ?? 0) > 50,
          observedServices: previous?.localServices.slice(0, 50).map(service => ({
            id: service.id, kind: service.kind, name: service.name,
            version: service.version, verification: service.verification, reason: service.reason,
          })) ?? null,
          currentHealthChecked: false, ownerOrderAuthorizationChecked: false,
        },
        quoteChecked: false, executionAuthorized: false, orderIntakeEnabled: 'not_observed',
      })
    },
    presentCall: () => ({ card: 'generic', title: '查看千手当前能力 · 按来源核实', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_capabilities',
    description: 'Read the live Shanghai semantic capability registry, independently of the developer task-type entry. A registry name is discovery only: use compute_pool for current worker declarations and a separate Host quote/owner confirmation before any order. Failed authentication or network reads return unknown, never an empty catalog. This does not check Guangzhou service health, install a plugin, dispatch or charge.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum registry names to return, 1 to 50, default 30.' },
      offset: { type: 'integer', description: 'Registry offset, 0 to 5000, default 0.' },
    }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const limit = args.limit ?? 30
      const offset = args.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 50
        || !Number.isInteger(offset) || offset < 0 || offset > 5000) throw new ComputeError('INVALID_COMPUTE_LIMIT')
      const discovery = await ctx.computeCore.capabilityDiscovery(exec.signal)
      const registry = discovery.registry
      const taskTypes = discovery.requestableTaskTypes.items
      const names = taskTypes === null ? null : new Set(taskTypes.map(item => item.taskType))
      const page = registry.capabilities?.slice(offset, offset + limit).map(item => ({
        id: item.capability,
        implementations: item.implementations,
        legacyTaskTypes: item.legacyTaskTypes,
        namedDeveloperTaskTypes: names === null ? null : item.legacyTaskTypes.filter(name => names.has(name)),
      })) ?? null
      return JSON.stringify({
        registry: {
          status: registry.status, observedAt: registry.observedAt, reason: registry.reason,
          version: registry.registryVersion, total: registry.capabilities?.length ?? null,
          offset, limit, items: page,
        },
        developerEntry: {
          status: discovery.requestableTaskTypes.status,
          observedAt: discovery.requestableTaskTypes.observedAt,
          reason: discovery.requestableTaskTypes.reason,
          namedTaskTypeCount: taskTypes?.length ?? null,
        },
        liveWorkersChecked: false, quoteChecked: false, ownerExecutionAuthorized: false,
      })
    },
    presentCall: () => ({ card: 'generic', title: '查询上海能力目录', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_local_capabilities',
    description: 'Read only exact capability/version pairs currently registered as local executors on this PC. A registered executor is not a health check, a verified plugin installation, owner consent to accept orders, or Shanghai dispatch eligibility. Empty means no local executor is registered now. Does not run a task, advertise a node, submit an order or change policy.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const items = ctx.computeCore.executors.list().map(({ capabilityId, version }) => ({ capabilityId, version }))
      return JSON.stringify({
        total: items.length,
        items,
        health: 'not_observed',
        ownerOrderAuthorization: 'not_observed',
        shanghaiDispatchEligibility: 'not_observed',
      })
    },
    presentCall: () => ({ card: 'generic', title: '查询本机已注册能力', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_pool',
    description: 'Ask the scheduler who currently declares a named capability. Returns three independent facts: whether the name is in the contract registry, how many workers declare it, and how many of those are available now. A missing scheduler answer is reported as unreachable, never as an empty pool. This is not a dispatch, quote, ranking, or reservation. Catalogue presence from compute_capabilities is not available-now.',
    parameters: {
      capability: { type: 'string', required: true, description: 'Contract capability id such as media.transcode.' },
      limit: { type: 'integer', description: 'Maximum named workers to include, 1 to 30, default 10. Counts are never truncated.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const limit = args.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new ComputeError('INVALID_COMPUTE_LIMIT')
      const snapshot = await ctx.computeCore.pool(args.capability, exec.signal)
      return JSON.stringify({ ...snapshot, provides: snapshot.provides.slice(0, limit) })
    },
    presentCall: args => ({ card: 'generic', title: '查询算力池谁有这能力', kind: 'read', rawInput: args.capability }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_account',
    description: 'Read this Qianshou account identity, copied money strings, and the ledger tail. Missing figures are null plus 上游没返回这一项, never an invented 0. Ledger amounts are copied verbatim and never re-rounded. Rewards are not summed from ledger rows. Cumulative withdrawal lists only type=WITHDRAW rows and does not total them. Local token usage is not account balance and is not added. This does not charge, withdraw, or submit.',
    parameters: { include: { type: 'string', description: 'Optional slice: balance, ledger, or rewards.' } },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify(await ctx.computeCore.account(args.include, exec.signal))
    },
    presentCall: args => ({ card: 'generic', title: '查询算力账户', kind: 'read', rawInput: args.include }),
  }))
  registerPlanning(defineTool({
    name: 'compute_dispatch_chain',
    description: 'Save a LOCAL chain of semantic capabilities as a reviewable card. Host validates every step against the current Shanghai registry; unknown or unreachable names fail closed. Existing accepted recipes may be reused only for previously supported and verified mappings; a newly registered plugin name does not become an executable or successful recipe by appearing in the registry. This does NOT submit, quote, charge or authorize the owner to accept orders. Do not use package names, node ids, or legacy catalogue names as capability. recipe_id is optional. Budget is a proposed upper limit in integer CNY fen.',
    parameters: {
      recipe_id: { type: 'string', description: 'Optional local recipe identity.' },
      steps: { type: 'array', required: true, description: 'Ordered steps. Each item has capability plus input (inline/ref/stream from the task contract).' },
      budgetMinor: { type: 'integer', required: true },
      maxNodes: { type: 'integer', description: 'Requested concurrency upper limit 1–64; omit for automatic.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
      presentationMeta: (_args, value) =>
        chainDraftCardMeta(JSON.parse(value) as Parameters<typeof chainDraftCardMeta>[0]) as unknown as JsonValue,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      return JSON.stringify(await ctx.computeCore.createChain({ ...args, currency: 'CNY', maxNodes: args.maxNodes ?? null }, exec.signal))
    },
    presentCall: _args => ({ card: 'generic', title: '拟定算力链 · 未下单', kind: 'execute' }),
  }))
  registerPlanning(defineTool({
    name: 'compute_plan_draft',
    description: 'Save a LOCAL distributed compute proposal using a capability returned by compute_capabilities. budgetMinor is an initial planning amount in CNY fen and may be 0 before the server prices the task; it is not a quote or payment authorization. The owner must see and confirm Shanghai’s actual quote before submit. maxNodes omitted means automatic. No workload is submitted. Do not store credentials or entire private conversations in the goal.',
    parameters: { capabilityId: { type: 'string', required: true }, goal: { type: 'string', required: true }, budgetMinor: { type: 'integer', required: true }, maxNodes: { type: 'integer', description: 'Requested concurrency upper limit 1–64; omit for automatic.' } },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
      /*
       * 返回的是"给界面渲染的卡片元数据"，它要跨**序列化边界**，所以契约要求 `JsonValue`。
       * `PlanDraftCardMeta` 的每个字段都是原始类型（string / number / null 与字面量 `'CNY'`），
       * 满足该契约；差异只在于它没有索引签名——这是**类型系统层面的形状差异**，
       * 不是"可能带出不可序列化的值"。
       *
       * 所以修在**边界上**（此处做一次显式转换），而不是给领域接口加索引签名：
       * 加了索引签名会让整个接口失去多余属性检查，把一处边界问题扩散成领域类型的漏洞。
       */
      presentationMeta: (_args, value) =>
        planDraftCardMeta(JSON.parse(value) as Parameters<typeof planDraftCardMeta>[0]) as unknown as JsonValue,
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      return JSON.stringify(await ctx.computeCore.createPlan({ ...args, currency: 'CNY', maxNodes: args.maxNodes ?? null }, exec.signal))
    },
    presentCall: args => ({ card: 'generic', title: '拟定算力方案 · 未下单', kind: 'execute', rawInput: args.goal }),
  }))
  /** Existing workloads are readable here; only the trusted Host quote and owner confirmation may create a paid order. */
  registerPlanning(defineTool({
    name: 'compute_submit',
    description: 'Read back an already-submitted compute draft by its real plan id. A draft that has only local approval cannot be submitted by this model tool: Shanghai must first issue an exact quote and the owner must confirm its amount in the Host. If no workload exists, this tool returns COMPUTE_QUOTE_CONFIRMATION_REQUIRED and does not charge or dispatch.',
    parameters: { id: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      return JSON.stringify(await ctx.computeCore.publishPlan({ id: args.id }, exec.signal))
    },
    presentCall: args => ({ card: 'generic', title: '查询算力任务', kind: 'read', rawInput: args.id }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_workload_read',
    description: 'Read an existing Qianshou workload receipt with this account. Supply a real ID from the user or core, never guess. Returns core status and result availability, not billing totals. Does not submit, retry, cancel or charge any workload.',
    parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
    async execute(args, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await ctx.computeCore.workload(args.id, exec.signal)) },
    presentCall: args => ({ card: 'generic', title: '查询算力任务', kind: 'read', rawInput: args.id }),
  }))
  ctx.tools.register(defineTool({
    name: 'compute_workload_result',
    description: 'Read the owner-visible result of an existing Qianshou workload. Supply a real ID from a published plan or compute_workload_read, never guess. Returns inlineOutput or artifactRef without downloading bytes. If artifactRef is a qianshou-media://task/ reference, include that exact reference in your reply as image markdown or a video link so the client can render it through its authenticated media route. Never invent a media reference. This is not settlement, billing or a quote.',
    parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify(await ctx.computeCore.workloadResult(args.id, exec.signal))
    },
    presentCall: args => ({ card: 'generic', title: '查询算力结果', kind: 'read', rawInput: args.id }),
  }))
  ctx.inject(['systemPrompt'], (scope) => {
    const prompt = (scope as {
      systemPrompt?: { section: (section: { name: string; order: number; text: string }) => () => void }
    }).systemPrompt
    if (!prompt) return
    prompt.section({
      name: COMPUTE_HONESTY_SECTION,
      order: COMPUTE_HONESTY_SECTION_ORDER,
      text: COMPUTE_HONESTY_PROMPT,
    })
  })
}
