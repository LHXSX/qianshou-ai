/** Model-facing private plugin creation and owner-approved local use tools. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './service.ts'
import { parsePluginDraftId } from './plugin-draft.ts'
import { inspectComfyApiWorkflow } from './comfy-workflow-inspection.ts'
import { probeLocalComfy } from './comfy-local-probe.ts'
import { preflightLocalComfyWorkflow } from './comfy-workflow-preflight.ts'
import { preparePrivateComfyDraftAsset } from './comfy-draft-asset.ts'
import { ComputeError } from './errors.ts'
import { installReviewedMacVideoDraft, MAC_VIDEO_DRAFT_TEMPLATE,
  type PrivateMacVideoInstallManager } from './private-mac-video-draft-package.ts'
import type { MacDrawnVideoFactory } from './mac-drawn-video-factory.ts'
import { safeLocalWorkflow, safeLocalWorkflowSpec, type SafeLocalWorkflowRef } from './safe-local-workflows.ts'
import { LEGAL_DOCUMENT_NODE_CONTRACT, legalDocumentDraftTemplate } from './legal-document-contract.ts'
import type { LegalDocumentRuntime } from './legal-document-plugin.ts'

export const name = 'qianshou-plugin-draft-tools'
export const inject = ['tools', 'computeCore']

export const PLUGIN_DRAFT_PROMPT_SECTION = 'qianshou:plugin-draft-creator'
export const PLUGIN_DRAFT_PROMPT = `先读当前会话和已给的目标、材料及约束，再自然对话。短回复承接仍有效的目标，机主否定某个方案时调整方案，不要求他重述整件事。不要用固定词表把请求硬分成“出图”或“本机插件”，也不要一开口索要模型 ID、工作流 JSON、manifest 或打包参数。机主只是在问问题或要完成一次任务时，先回答或处理这件事；机主明确说“给我做成插件”“保存为插件”等，就是制作本机私有草稿的请求，无需反问“是否要做插件”。仅当一次任务有可信的成功回执且机主尚未提出复用时，才顺势问一次是否整理为插件。插件可涉及文字、图片、视频、音频、数据、本机工具和分布式能力，具体范围由真实后端决定。预设里存在某项专用工具不代表这台电脑安装了对应软件；先核对真实 Host 观察与已注册执行器，不主动把任意需求引向 ComfyUI 或固定模板。
开始创作时先用 compute_capability_landscape 核对本机、广州和上海的不同能力来源，再用 plugin_draft_creation_context 查看该草稿所需的 Host 观察，并以对话理解目标与可复用的操作。上海语义注册表只是能力名称清单；开发者任务入口、实时节点、报价和可运行证明要分别核实。本机观察可能过时，pending 仅是候选。若目标涉及共享算力，可按具体能力用 compute_pool 核对当前声明；不要据此自动下单、扣费或开放机主设备接单。只用可信工具和机主提供的材料填入已经证实的事实；对于缺失的权限、处理数据范围、可能费用和最终启用决定，简短说明影响并只问当前必须的一件事。技术字段由你在后台整理，机主想看时再展开。
用普通话向机主说明“想完成什么 → 千手能确认什么 → 草稿将做什么 → 用一个样例验证 → 能否安装自用”。机主明确要求制作或保存插件，已授权保存本机私有草稿；事实与必填字段足够时，复述产物、输入输出、数据去向、所需授权和未验证项后直接调用 plugin_draft_save，不再单独问能否保存。缺少必填的真实能力绑定或材料时，先查已有只读事实；仍缺才简短问当前必须的一项，不能编造绑定来凑草稿。一般草稿为 private-draft，不能自行安装或执行；plugin_draft_preview 只是打包计划。若每项操作都能匹配本机已安装且由 Host 注册的精确适配器，机主要求试跑时可用 plugin_draft_try_sample 逐项给出样例输入，并由 Host 再次请求本次运行授权；真实样例输出只证明这次本机试跑；若机主进一步要求私用，使用 plugin_private_activate 对精确制品请求 Host 本次授权，随后才能用 plugin_private_run 逐次授权调用。纯数据制品本身不能执行，也不能发布或接单。不要把任意模型文字或临时命令注册为适配器。若目前只能完成草稿或样例，就说明已完成的部分与下一步，不把“尚不能安装、发布或接单”说成“不能制作插件”。私有启用、固定模板安装、上传、出售和开放接单各需独立授权与真实回执；plugin_private_list 可查看私有安装，plugin_private_uninstall 经机主授权后使其失效。机主要求列出已有草稿时直接用 plugin_draft_read，没有就报告空列表。询问助手能做什么时按实际工具与回执说明，不预告尚无的安装或发布能力。
专用工具只在机主明确提出对应环境，或可信 Host 观察证明目标操作确实绑定到该环境时使用；先按各工具说明做受限只读核对，再对保存、试跑、安装分别取得所需授权。不要因预设有某个工具便假设本机有该软件。成功样例只证明该次操作，不能替其他操作或另一台设备背书；状态不明时核原作业，不换 key 重试。
若草稿每项操作确实属于本机内置的 qianshou.string-map.v1 纯字符串映射，可按机主的制作要求用 plugin_reviewable_build 保存包含完整程序的本机候选；再用 plugin_reviewable_try_sample 经机主本次授权试跑每项样例。此候选与普通只含适配器声明的草稿不同，但仍未独立审核、安装、上架、售卖或接单。其他模型、工作流、工具不能伪装为字符串映射；缺少实现内容就说明缺口。固定 Mac 绘图视频和离线 CSV 仅是两条已审查的私有试用入口。只有目标与固定模板完全相符且机主要求安装，才调用对应专用工具并核对活动 Loader 与执行器；其他 ComfyUI 或任意模型草稿不得借固定模板安装；通用私用仅能绑定当前可信 Host 已注册的精确适配器，不装载草稿中的任意代码。不要扫描任意路径、读取凭据、调用上传或发布入口，也不要把草稿、样例、目录声明称为已上架、可接单或已收费。失败时报告真实原因和可行的下一步。`

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

function checkedName(value: string): string {
  const displayName = value.trim()
  if (displayName.length === 0 || displayName.length > 80 || !/[\u3400-\u9fff]/u.test(displayName)) {
    throw new ComputeError('COMPUTE_PLUGIN_SAFE_WORKFLOW_NAME_INVALID', 400)
  }
  return displayName
}

/** Register only local observation and draft read/write tools in a deliberately narrow agent scope. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'plugin_legal_document_template',
    description: '读取法律附件批量文书的真实节点合同和15件交付模板。它与法律机械自检是不同任务。仅提供原生节点候选，不运行模型、收费、发布或授予接单权。',
    parameters: { displayName: { type: 'string', required: true, description: '机主要求的中文名称。' },
      providerId: { type: 'string', required: true, description: '该节点实际配置的法律provider逻辑ID；不得编造。' } }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const runtime = ctx.get('qianshouLegalDocumentRuntime') as LegalDocumentRuntime | undefined
      return JSON.stringify({ state: 'native-node-contract-candidate',
        runtime: runtime?.state() ?? { localExecution: 'unavailable', marketDispatch: 'not-registered' },
        contract: LEGAL_DOCUMENT_NODE_CONTRACT,
        spec: legalDocumentDraftTemplate(args.providerId, checkedName(args.displayName)),
        installed: false, published: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '读取法律文书节点合同', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_text_statistics_create',
    description: '为机主创建文本统计私有候选包。只用于准确匹配该功能，不安装、不运行、不发布或接单。',
    parameters: {
      displayName: { type: 'string', required: true, description: '机主确认的简短中文插件名称。' },
      pluginId: { type: 'string', description: '仅在机主明确给出合法逻辑 ID 时填写。' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      const displayName = checkedName(args.displayName)
      const saved = await ctx.computeCore.saveLocalPluginDraft({
        spec: safeLocalWorkflowSpec('qianshou:text-statistics-v2', displayName, args.pluginId),
      })
      exec.signal.throwIfAborted()
      const candidate = await ctx.computeCore.prepareLocalPluginCandidate(saved.id)
      return JSON.stringify({ state: 'private-candidate', displayName, draftId: saved.id,
        packageName: candidate.packageName, packagePath: candidate.packagePath, toolName: candidate.toolName,
        sourceDigest: candidate.sourceDigest, packageDigest: candidate.packageDigest,
        installed: false, enabled: false, published: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '创建文本统计插件候选包 · 未安装', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_safe_workflow_create',
    description: '仅按 Host 已审阅的固定文本工作流创建私有候选包。其他类别走技能助手的通用创作流程，不能冒充固定工作流。',
    parameters: {
      workflowRef: { type: 'string', required: true, description: '准确的 Host 已审阅逻辑 ID。' },
      displayName: { type: 'string', required: true, description: '机主确认的简短中文插件名称。' },
      pluginId: { type: 'string', description: '仅在机主明确给出合法逻辑 ID 时填写。' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      const workflow = safeLocalWorkflow(args.workflowRef)
      if (!workflow || args.workflowRef === 'qianshou:text-statistics-v1') {
        throw new ComputeError('COMPUTE_PLUGIN_CANDIDATE_UNSUPPORTED', 409)
      }
      const displayName = checkedName(args.displayName)
      const saved = await ctx.computeCore.saveLocalPluginDraft({
        spec: safeLocalWorkflowSpec(args.workflowRef as SafeLocalWorkflowRef, displayName, args.pluginId),
      })
      exec.signal.throwIfAborted()
      const candidate = await ctx.computeCore.prepareLocalPluginCandidate(saved.id)
      return JSON.stringify({ state: 'private-candidate', workflowRef: args.workflowRef, displayName,
        draftId: saved.id, packageName: candidate.packageName, packagePath: candidate.packagePath,
        toolName: candidate.toolName, sourceDigest: candidate.sourceDigest, packageDigest: candidate.packageDigest,
        installed: false, enabled: false, published: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '创建本机插件候选包 · 未安装', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_candidate_prepare',
    description: '仅为已保存且准确匹配 Host 已审阅固定文本工作流的草稿准备私有候选包；不安装、不运行、不发布。',
    parameters: { id: { type: 'string', required: true, description: 'plugin_draft_save 返回的草稿 ID。' } }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      return JSON.stringify(await ctx.computeCore.prepareLocalPluginCandidate(args.id))
    },
    presentCall: () => ({ card: 'generic', title: '准备本机插件候选包 · 未安装', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_creation_context',
    description: 'Read current Host facts to begin a natural-language plugin conversation: last completed local supply observation, exact locally registered executors and operation adapters, and Shanghai live semantic registry plus a separate developer-task entry status. A new plugin capability stays visible even without an old task-type mapping. An adapter registration still needs a real sample and package. Registry membership is not live worker availability, plugin readiness, price, order permission or owner supply consent. No scan, fresh local probe, pool reservation, draft write, execution, order, or advertisement occurs.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const observed = ctx.computeCore.lastObservedSupply()
      const localExecutors = ctx.computeCore.executors.list().map(item => ({ capabilityId: item.capabilityId, version: item.version }))
      const status = ctx.computeCore.status()
      let catalog: { lookup: 'unconfigured' | 'unreachable' | 'read'; observedAt: string | null;
        reason: string | null; version: string | null; total: number | null;
        items: { id: string; implementations: readonly string[]; legacyTaskTypes: readonly string[] }[] | null;
        developerEntryStatus: 'observed' | 'unreachable' | null } = {
          lookup: status.configured ? 'unreachable' : 'unconfigured', observedAt: null,
          reason: status.configured ? 'request_failed' : 'not_configured', version: null, total: null,
          items: null, developerEntryStatus: null,
        }
      if (status.configured) {
        try {
          const discovery = await ctx.computeCore.capabilityDiscovery(exec.signal)
          const registry = discovery.registry
          catalog = { lookup: registry.status === 'observed' ? 'read' : 'unreachable',
            observedAt: registry.observedAt, reason: registry.reason,
            version: registry.registryVersion, total: registry.capabilities?.length ?? null,
            items: registry.capabilities?.slice(0, 50).map(item => ({ id: item.capability,
              implementations: item.implementations, legacyTaskTypes: item.legacyTaskTypes })) ?? null,
            developerEntryStatus: discovery.requestableTaskTypes.status }
        } catch {
          exec.signal.throwIfAborted()
        }
      }
      return JSON.stringify({ local: {
        observedAt: observed?.observedAt ?? null,
        services: (observed?.localServices ?? []).slice(0, 30).map(item => ({ id: item.id, name: item.name,
          kind: item.kind, verification: item.verification })),
        executors: localExecutors.slice(0, 30),
        adapters: ctx.computeCore.listPluginAdapterBindings().slice(0, 30),
      }, distributed: { catalog, quotingConfigured: status.capabilities.quoting,
        submissionConfigured: status.capabilities.submission,
        liveWorkersChecked: false, priceMinor: null }, pluginReadinessChecked: false, ownerExecutionAuthorized: false })
    },
    presentCall: () => ({ card: 'generic', title: '查看已有能力 · 未开始任务', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_mac_video_template',
    description: 'Read the exact reviewed Mac 5-second drawn-video plugin design. This is a fixed Host template, not a discovery of arbitrary model/workflow code. It does not save, install, execute, publish, bill or advertise a capability.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      exec.signal.throwIfAborted()
      return Promise.resolve(JSON.stringify({ spec: MAC_VIDEO_DRAFT_TEMPLATE,
        state: 'reviewed-private-template', platformCandidate: process.platform === 'darwin',
        requiresHostToolCheck: true, requiresOwnerApproval: true,
        marketInstalled: false, dispatchable: false }))
    },
    presentCall: () => ({ card: 'generic', title: '查看 Mac 五秒视频插件模板', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_model_candidates',
    description: 'Read only local-model candidates from the Host-owned last completed supply observation. Returns their logical IDs, names, verification states and observation time, or an empty list with null observation time if no observation exists. An inventory candidate is not proof of inference, adapter compatibility or plugin readiness. This never probes, publishes a capability, scans paths, downloads, executes or saves a draft.',
    parameters: {}, output,
    execute(_args, exec) {
      exec.signal.throwIfAborted()
      const observed = ctx.computeCore.lastObservedSupply()
      return Promise.resolve(JSON.stringify({ observedAt: observed?.observedAt ?? null,
        models: (observed?.localServices ?? []).filter(service => service.kind === 'local-model' && service.verification !== 'unavailable')
          .map(service => ({ id: service.id, name: service.name, verification: service.verification })) }))
    },
    presentCall: () => ({ card: 'generic', title: '查看本机模型候选 · 尚未试跑', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_inspect_comfy_workflow',
    description: 'Inspect an owner-provided ComfyUI API-format JSON graph up to 256 KiB and 128 nodes. Returns only node IDs, class names and candidate input field names; prompt text, model filenames and other input values are never returned. The owner must confirm every mapping. This does not read files, contact ComfyUI, run a workflow, save a draft or publish a capability.',
    parameters: { workflow: { type: 'json', required: true, description: 'The object exported by ComfyUI using Export Workflow (API), not the editor UI JSON.' } }, output,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      exec.signal.throwIfAborted()
      return Promise.resolve(JSON.stringify(inspectComfyApiWorkflow(args.workflow)))
    },
    presentCall: () => ({ card: 'generic', title: '分析工作流结构 · 未运行', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_probe_local_comfy',
    description: 'Only when the owner asks to inspect this computer\'s ComfyUI, read localhost version, GPU capacity, common model-file counts and availability of up to 32 owner-named node classes. Defaults to port 8188; another local port must come from the owner. Never returns filenames, system launch arguments, workflow contents or arbitrary HTTP responses. This does not execute, package, publish or advertise a capability.',
    parameters: {
      port: { type: 'number', description: 'Optional owner-provided local ComfyUI TCP port; defaults to 8188.' },
      classTypes: { type: 'json', description: 'Optional array of up to 32 class names from an owner-provided API workflow inspection.' },
    }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify(await probeLocalComfy(args, exec.signal))
    },
    presentCall: () => ({ card: 'generic', title: '查看本机 ComfyUI · 未试跑', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_preflight_comfy_workflow',
    description: 'Only when the owner explicitly asks to compare their ComfyUI API graph with this computer, read at most 32 distinct node classes from loopback object_info. Return only graph SHA-256, node IDs/classes and boolean or unknown class/model-selector availability. Never return prompt or model filenames, run /prompt, package, publish or advertise.',
    parameters: {
      workflow: { type: 'json', required: true, description: 'Owner-provided ComfyUI API-format graph, up to 256 KiB and 128 nodes.' },
      port: { type: 'number', description: 'Optional owner-provided local ComfyUI port; defaults to 8188.' },
    }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify(await preflightLocalComfyWorkflow(args, exec.signal))
    },
    presentCall: () => ({ card: 'generic', title: '核对本机工作流选项 · 未试跑', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_bind_comfy_workflow',
    description: 'Save one owner-provided ComfyUI API graph as a PRIVATE asset of an existing draft operation whose logical binding begins with comfy:. The owner must confirm the input/output mapping and separately approve this exact Host action. A missing, rejected or unavailable Host approval refuses the write. Graph text and model names are not returned. No model execution, package, upload, advertisement or sale occurs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Opaque plugin_draft_* ID of an existing private design.' },
      operationId: { type: 'string', required: true, description: 'Existing workflow operation ID in that draft.' },
      workflow: { type: 'json', required: true, description: 'Owner-provided ComfyUI API-format graph, at most 256 KiB and 128 nodes; no paths, URLs, credentials or arbitrary nested input objects.' },
      mapping: { type: 'json', required: true, description: 'Owner-confirmed {prompt, optional negativePrompt/seed/width/height, outputNodeId}; each field reference is {nodeId,field} from graph inspection.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      const id = parsePluginDraftId(args.id)
      const asset = preparePrivateComfyDraftAsset({ operationId: args.operationId,
        workflow: args.workflow, mapping: args.mapping })
      const draft = (await ctx.computeCore.localPluginDrafts()).find(item => item.id === id)
      if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      const operation = draft.spec.operations.find(item => item.id === asset.operationId)
      if (operation?.binding.kind !== 'workflow' || !operation.binding.ref.startsWith('comfy:')) {
        throw new ComputeError('COMPUTE_COMFY_DRAFT_ASSET_INVALID', 400)
      }
      const approval = (ctx as unknown as { get: (name: string) => { request: (request: {
        agent: unknown
        toolName: string
        callId?: unknown
        reason: string
        signal: AbortSignal
      }) => Promise<string> } | undefined }).get('approval')
      if (approval === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_OWNER_APPROVAL_REQUIRED', 403)
      const outcome = await approval.request({ agent: exec.agent, toolName: 'plugin_draft_bind_comfy_workflow',
        callId: exec.callId, signal: exec.signal,
        reason: `把 ${asset.nodeCount} 个节点的 ComfyUI API 图绑定到本机私有草稿 ${id} 的操作 ${asset.operationId}（草稿版本 ${draft.updatedAt}）；图 SHA-256 ${asset.graphSha256}。图中的提示词和模型名称仅存在本机私有文件。此操作不运行、安装、上传、发布或接单。仅授权这一次保存吗？` })
      if (outcome !== 'allowed-once') throw new ComputeError('COMPUTE_PLUGIN_DRAFT_OWNER_APPROVAL_REQUIRED', 403)
      exec.signal.throwIfAborted()
      return JSON.stringify(await ctx.computeCore.bindLocalPluginComfyAsset({ id, expectedUpdatedAt: draft.updatedAt,
        operationId: asset.operationId, workflow: args.workflow, mapping: args.mapping }))
    },
    presentCall: () => ({ card: 'generic', title: '保存本机私有工作流 · 尚未试跑', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_try_comfy_sample',
    description: 'Only after the owner explicitly asks for ONE local PNG sample from a previously bound comfy: private draft operation. The Host rereads the saved API graph, preflights exact local classes/model choices, asks the real user-approval service for a fresh one-shot GPU decision, and submits at most once to 127.0.0.1. No arbitrary graph, model/path/URL, external order, market publication, billing or capability advertisement. Unknown POST/cancel states must be reconciled; do not retry with another call.',
    parameters: {
      id: { type: 'string', required: true, description: 'Existing opaque private draft ID; first use plugin_draft_read to select it.' },
      operationId: { type: 'string', required: true, description: 'Existing bound comfy: workflow operation ID from that draft.' },
      prompt: { type: 'string', required: true, description: 'Owner-confirmed positive prompt, maximum 2,000 characters.' },
      negativePrompt: { type: 'string', description: 'Optional owner-confirmed negative prompt, only if mapped.' },
      seed: { type: 'number', description: 'Optional safe integer seed, only if mapped.' },
      width: { type: 'number', description: 'Optional width, 256–1024 and divisible by 64, only if mapped.' },
      height: { type: 'number', description: 'Optional height, 256–1024 and divisible by 64, only if mapped.' },
      port: { type: 'number', description: 'Owner-provided local ComfyUI port; defaults to 8188.' },
    }, output, timeoutMs: 660_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      const id = parsePluginDraftId(args.id)
      return JSON.stringify(await ctx.computeCore.runLocalPluginComfyTrial({ draftId: id,
        operationId: args.operationId, prompt: args.prompt,
        ...(args.negativePrompt === undefined ? {} : { negativePrompt: args.negativePrompt }),
        ...(args.seed === undefined ? {} : { seed: args.seed }),
        ...(args.width === undefined ? {} : { width: args.width }),
        ...(args.height === undefined ? {} : { height: args.height }),
        port: args.port ?? 8188, agent: exec.agent, callId: exec.callId, signal: exec.signal }))
    },
    presentCall: () => ({ card: 'generic', title: '本机出一张样例 · 等待机主审批', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_save',
    description: 'Save or update a PRIVATE local design recipe for one future plugin. An explicit owner request to make a plugin authorizes this private draft save; exploratory questions and unrelated task requests do not. The spec can contain multiple freely named operations, but every binding must be a factual logical local-model/workflow/tool ID rather than an invented value, path, URL or command. The Host validates fields but does not establish binding availability. This does not discover, run, package, install, advertise, sell or publish anything.',
    parameters: {
      id: { type: 'string', description: 'Opaque plugin_draft_* ID returned by an earlier save; omit to create.' },
      spec: { type: 'json', required: true, description: 'PluginDraftSpec: pluginId, version, displayName and operations. Each operation needs id, title, description, binding {kind: local-model|workflow|tool, ref: namespace:id}, inputSchema, outputSchema, permissions, dataScope, networkOrigins, dependencies and resources. Object schemas require type:object, properties, required and additionalProperties:false. Never include paths, commands or credentials.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED')
      const saved = await ctx.computeCore.saveLocalPluginDraft({ ...(args.id === undefined ? {} : { id: args.id }), spec: args.spec })
      return JSON.stringify(saved)
    },
    presentCall: () => ({ card: 'generic', title: '保存私有插件草稿 · 未安装', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_install_mac_video',
    description: 'Only after the owner asks to install the exact saved reviewed Mac 5-second drawn-video template. Supply its opaque draft ID and revision returned by plugin_draft_save/read; never a path, package URL, code, approval result, or arbitrary workflow. The Host asks the real owner for one-shot approval, materializes verified embedded bundle bytes, installs through the current profile plugin manager and checks the active Loader and executor. This private unsigned package is not market-installed, Shanghai-dispatchable or billable.',
    parameters: {
      id: { type: 'string', required: true, description: 'Opaque ID of the saved exact Mac drawn-video template.' },
      expectedUpdatedAt: { type: 'string', required: true, description: 'Exact updatedAt revision from the owner-local saved draft.' },
    }, output, timeoutMs: 180_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      const host = ctx as unknown as { get(name: string): unknown }
      const profile = host.get('profileContext') as { dir: string; home: string } | undefined
      const manager = host.get('pluginManager') as PrivateMacVideoInstallManager | undefined
      const factory = host.get('macDrawnVideoFactory') as MacDrawnVideoFactory | undefined
      const approval = host.get('approval') as { request(value: { agent: unknown; toolName: string;
        callId: unknown; reason: string; signal: AbortSignal }): Promise<string> } | undefined
      if (!profile || !manager || !factory || !approval) {
        throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_HOST_UNAVAILABLE', 503)
      }
      const result = await installReviewedMacVideoDraft({ draftId: args.id,
        expectedUpdatedAt: args.expectedUpdatedAt, drafts: { list: () => ctx.computeCore.localPluginDrafts() },
        packageRoot: join(profile.home, 'qianshou', 'private-packages'), profileDir: profile.dir,
        manager, executors: ctx.computeCore.executors, factory, signal: exec.signal,
        approve: reason => approval.request({ agent: exec.agent, toolName: 'plugin_draft_install_mac_video',
          callId: exec.callId, reason, signal: exec.signal }) })
      return JSON.stringify(result)
    },
    presentCall: () => ({ card: 'generic', title: '安装已审核 Mac 视频私有插件 · 等待机主审批', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_read',
    description: 'Read only owner-local private plugin design drafts. With no ID returns up to 20 brief draft summaries; with an opaque ID returns the selected design for editing. This never reads an arbitrary file, executes a binding, or contacts a market or scheduler.',
    parameters: { id: { type: 'string', description: 'Optional opaque plugin_draft_* ID. Omit for brief list.' } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const id = args.id === undefined ? undefined : parsePluginDraftId(args.id)
      const drafts = await ctx.computeCore.localPluginDrafts()
      if (id !== undefined) {
        const found = drafts.find(draft => draft.id === id)
        if (!found) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
        const adapterBindings = (ctx.computeCore.listPluginAdapterBindings?.() ?? []).filter(binding =>
          found.spec.operations.some(operation => operation.id === binding.operationId
            && operation.binding.kind === binding.bindingKind
            && operation.binding.ref === binding.bindingRef))
        const comfyBindings = await ctx.computeCore.localPluginComfyAssetSummaries?.(id) ?? []
        return JSON.stringify({ ...found, adapterBindings,
          ...(comfyBindings.length > 0 ? { comfyBindings } : {}) })
      }
      return JSON.stringify({ total: drafts.length, items: drafts.slice(0, 20).map(draft => ({
        id: draft.id, updatedAt: draft.updatedAt, state: draft.state, installable: draft.installable,
        dispatchable: draft.dispatchable, pluginId: draft.spec.pluginId, displayName: draft.spec.displayName,
        operations: draft.spec.operations.map(operation => operation.id),
      })) })
    },
    presentCall: () => ({ card: 'generic', title: '查看私有插件草稿', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_preview',
    description: 'Read a local private plugin draft package PLAN by opaque ID. Returns a deterministic structural manifest digest and device preflight with unverified items labeled. No model files, code, binding reference, URL, free-text description or credential file is read into the plan. Owner-entered IDs and field names remain visible and should be reviewed before sharing. It is not installable or publishable.',
    parameters: { id: { type: 'string', required: true, description: 'Opaque plugin_draft_* ID returned by save or read.' } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const preview = await ctx.computeCore.previewLocalPluginDraft(parsePluginDraftId(args.id))
      return JSON.stringify({ fileName: preview.fileName, manifestSha256: preview.manifestSha256,
        pluginId: preview.manifest.pluginId, version: preview.manifest.version,
        state: preview.state, summary: preview.summary, host: preview.host, checks: preview.checks,
        installable: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '查看插件打包计划 · 尚不可安装', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_reviewable_build',
    description: 'Build and privately retain one actual, self-contained qianshou.reviewable-execution.v1 candidate from an exact saved draft revision. Each operation must use the bundled tool:qianshou.string-map.v1 binding, flat required string schemas, zero external permissions/dependencies, and a complete declared copy/trim/ASCII-case mapping program. Capability IDs are claims, not registry proof. The Host verifies all implementation bytes and returns only SHA and status. An explicit owner request to create the plugin authorizes this private build; no network, market submission, installation, sale, order or automatic supply enablement occurs.',
    parameters: {
      id: { type: 'string', required: true, description: 'Opaque saved plugin_draft_* ID.' },
      expectedUpdatedAt: { type: 'string', required: true, description: 'Exact updatedAt from plugin_draft_read.' },
      capabilityIds: { type: 'json', required: true, description: 'Map of each operation ID to its claimed logical capability ID.' },
      programs: { type: 'json', required: true, description: 'Map of each operation ID to {mappings:[{from,to,transform}]}; transform is copy, trim, ascii-lower or ascii-upper. No code, path, URL or literal values.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      if (args.capabilityIds === null || typeof args.capabilityIds !== 'object' || Array.isArray(args.capabilityIds)
        || Object.values(args.capabilityIds).some(value => typeof value !== 'string')
        || args.programs === null || typeof args.programs !== 'object' || Array.isArray(args.programs)) {
        throw new ComputeError('COMPUTE_REVIEWABLE_EXECUTION_INVALID', 400)
      }
      const built = await ctx.computeCore.buildReviewableExecutionCandidate({ draftId: args.id,
        expectedUpdatedAt: args.expectedUpdatedAt,
        capabilityIds: args.capabilityIds as Readonly<Record<string, string>>,
        programs: args.programs as Readonly<Record<string, unknown>> })
      return JSON.stringify({ packageSha256: built.packageSha256, format: built.manifest.format,
        pluginId: built.manifest.pluginId, version: built.manifest.version,
        operations: built.manifest.operations.map(item => ({ operationId: item.operationId,
          capabilityId: item.capabilityId, implementationSha256: item.implementationSha256 })),
        state: 'built-private-review-candidate', verificationScope: built.verificationScope,
        exportPath: `/api/qianshou/compute/plugin-drafts/reviewable-execution/export?sha256=${built.packageSha256}`,
        reviewed: false, installable: false, publishable: false, dispatchable: false })
    },
    presentCall: () => ({ card: 'generic', title: '制作可审核插件候选 · 仅本机', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_reviewable_try_sample',
    description: 'After fresh one-shot owner approval, run every operation of an exact locally retained qianshou.reviewable-execution.v1 candidate on owner-provided sample inputs. The Host re-verifies complete bytes and executes only the bounded bundled pure string-map interpreter. Samples and actual outputs are shown in this conversation, not stored in the public candidate. No plugin install, remote order, publication or supply activation occurs.',
    parameters: {
      packageSha256: { type: 'string', required: true, description: 'Exact SHA-256 returned by plugin_reviewable_build.' },
      samples: { type: 'json', required: true, description: 'One {operationId,input} per operation, with input matching its flat string schema.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      if (!Array.isArray(args.samples) || args.samples.length < 1 || args.samples.length > 16
        || args.samples.some(item => item === null || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).length !== 2 || typeof item.operationId !== 'string' || !Object.hasOwn(item, 'input'))
        || Buffer.byteLength(JSON.stringify(args.samples)) > 64 * 1024) {
        throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_INVALID', 400)
      }
      const samples = args.samples as Array<{ operationId: string; input: unknown }>
      const candidate = await ctx.computeCore.exportReviewableExecutionCandidate(args.packageSha256)
      const manifest = JSON.parse(candidate.contents) as { operations: Array<{ operationId: string }> }
      const operations = manifest.operations.map(item => item.operationId)
      if (samples.length !== operations.length
        || new Set(samples.map(item => item.operationId)).size !== operations.length
        || operations.some(id => !samples.some(item => item.operationId === id))) {
        throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_INVALID', 400)
      }
      const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as
        { request(value: { agent: unknown; toolName: string; callId: unknown;
          reason: string; signal: AbortSignal }): Promise<string> } | undefined
      if (!approval) throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_OWNER_APPROVAL_REQUIRED', 403)
      const sampleDigest = createHash('sha256').update(JSON.stringify(samples)).digest('hex')
      const result = await approval.request({ agent: exec.agent, toolName: 'plugin_reviewable_try_sample',
        callId: exec.callId, signal: exec.signal,
        reason: `仅在本机试跑可审核插件候选 ${args.packageSha256} 的 ${samples.length} 项纯字符串映射；样例摘要 ${sampleDigest}。输出会显示在本次对话。此授权仅限本次试跑，不安装、上传、出售或开放接单。` })
      if (result !== 'allowed-once') throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_OWNER_APPROVAL_REQUIRED', 403)
      exec.signal.throwIfAborted()
      const trial = await ctx.computeCore.tryReviewableExecutionCandidate(args.packageSha256, samples)
      return JSON.stringify({ ...trial, sampleExecuted: true, scope: 'bundled-pure-string-map-interpreter' })
    },
    presentCall: () => ({ card: 'generic', title: '试跑可审核插件样例 · 等待机主授权', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_draft_try_sample',
    description: 'Run one owner-approved private sample for EVERY operation of an exact saved draft, using only executable adapters already registered by trusted installed Host packages. The model cannot provide code, a command, URL, path, adapter registration or approval result. Host checks every contract and input before execution, checks each actual output, and builds a private data-only candidate. No market upload, installation, sale, order-taking or automatic retry occurs. Outputs can contain the owner sample data; show them only in this conversation.',
    parameters: {
      id: { type: 'string', required: true, description: 'Opaque saved plugin_draft_* ID.' },
      expectedUpdatedAt: { type: 'string', required: true, description: 'Exact revision returned by plugin_draft_read.' },
      samples: { type: 'json', required: true,
        description: 'One array entry {operationId,input} per saved operation. Input must match the saved bounded schema; no paths, code or adapter IDs.' },
    }, output, timeoutMs: 180_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      const id = parsePluginDraftId(args.id)
      const draft = (await ctx.computeCore.localPluginDrafts()).find(item => item.id === id)
      if (!draft) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      if (draft.updatedAt !== args.expectedUpdatedAt) {
        throw new ComputeError('COMPUTE_PLUGIN_DRAFT_REVISION_STALE', 409)
      }
      const sampleInput = args.samples
      if (!Array.isArray(sampleInput) || sampleInput.length !== draft.spec.operations.length) {
        throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_INPUT_INVALID', 400)
      }
      const samples = sampleInput.map(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_INPUT_INVALID', 400)
        }
        const row = item as Record<string, unknown>
        if (Object.keys(row).length !== 2 || typeof row.operationId !== 'string'
          || !Object.hasOwn(row, 'input')) {
          throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_INPUT_INVALID', 400)
        }
        return { operationId: row.operationId, input: row.input }
      })
      if (new Set(samples.map(item => item.operationId)).size !== samples.length
        || draft.spec.operations.some(operation => !samples.some(item => item.operationId === operation.id))) {
        throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_INPUT_INVALID', 400)
      }
      const registered = ctx.computeCore.listPluginAdapterBindings()
      for (const operation of draft.spec.operations) {
        const matches = registered.filter(item => item.operationId === operation.id
          && item.bindingKind === operation.binding.kind && item.bindingRef === operation.binding.ref)
        if (matches.length !== 1) throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_ADAPTER_UNAVAILABLE', 409)
      }
      const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as
        { request(value: { agent: unknown; toolName: string; callId: unknown;
          reason: string; signal: AbortSignal }): Promise<string> } | undefined
      if (!approval || typeof approval.request !== 'function') {
        throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_OWNER_APPROVAL_REQUIRED', 403)
      }
      const operations = draft.spec.operations.map(item => item.id).join('、')
      const permissionSet = [...new Set(draft.spec.operations.flatMap(item => item.permissions))]
      const permissions = permissionSet.length === 0 ? '无额外权限' : permissionSet.join('、')
      const outcome = await approval.request({ agent: exec.agent,
        toolName: 'plugin_draft_try_sample', callId: exec.callId, signal: exec.signal,
        reason: `在这台电脑试跑私有插件草稿「${draft.spec.displayName}」的 ${draft.spec.operations.length} 项操作（${operations}），只使用本机已注册的精确适配器。本次权限：${permissions}；数据范围见草稿。样例输入和输出会留在本机私有候选中，可能含你提供的数据。草稿版本 ${draft.updatedAt}。此授权仅限这一次试跑；不会安装、上传、出售或开放接单。` })
      if (outcome !== 'allowed-once') throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_OWNER_APPROVAL_REQUIRED', 403)
      exec.signal.throwIfAborted()
      const result = await ctx.computeCore.runPrivatePluginSamples(id, draft.updatedAt, samples, exec.signal)
      return JSON.stringify({ id: result.id, draftId: result.draftId,
        pluginId: result.candidate.pluginId, version: result.candidate.version,
        samples: result.samples, results: result.results,
        candidateSha256: result.candidate.candidateSha256,
        packageSha256: result.artifact.packageSha256,
        stored: result.stored, state: 'private-sample-completed',
        scope: 'host-registered-in-process-callback',
        reviewVerified: false, installable: false, dispatchable: false,
        note: '样例通过只证明本机这次运行；若机主要求私用，可对精确制品另取授权启用当前可信 Host 适配器。候选尚未经过独立审核、公开发布或接单准入。' })
    },
    presentCall: () => ({ card: 'generic', title: '试跑本机插件样例 · 等待机主授权', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_private_list',
    description: 'List persisted PRIVATE local plugin installs and their current availability. An unavailable row cannot run. No market publication, public sale, node dispatch, file content or sample data is returned.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      return JSON.stringify(await ctx.computeCore.listPrivatePluginActivations())
    },
    presentCall: () => ({ card: 'generic', title: '查看本机私有插件', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_private_activate',
    description: 'Privately activate one exact SHA-256 pinned, previously sampled data-only archive. The Host rechecks the stored archive, saved draft and every currently registered trusted adapter, then asks the owner for one-shot approval. The model cannot approve or register an adapter. No ZIP code is loaded; no public sale or node dispatch.',
    parameters: {
      packageSha256: { type: 'string', required: true, description: 'Exact private archive SHA-256 returned by plugin_draft_try_sample.' },
      candidateSha256: { type: 'string', required: true, description: 'Exact candidate SHA-256 returned by plugin_draft_try_sample.' },
    }, output, timeoutMs: 180_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      return JSON.stringify(await ctx.computeCore.activatePrivatePlugin(args.packageSha256,
        args.candidateSha256, { agent: exec.agent, callId: exec.callId, signal: exec.signal }))
    },
    presentCall: () => ({ card: 'generic', title: '启用本机私有插件 · 等待机主授权', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_private_run',
    description: 'Use one currently active PRIVATE plugin operation in this conversation. The Host rechecks the exact stored archive, saved draft, live trusted adapter and JSON schemas, then requests one-shot owner approval for this input digest. Retrying the same Host call ID and input returns its saved result; a new approved call ID may repeat the input. An uncertain attempt blocks this operation. This does not publish, bill or dispatch.',
    parameters: {
      packageSha256: { type: 'string', required: true, description: 'Exact installed private archive SHA-256.' },
      candidateSha256: { type: 'string', required: true, description: 'Exact installed candidate SHA-256.' },
      operationId: { type: 'string', required: true, description: 'One operation ID listed for this active private plugin.' },
      input: { type: 'json', required: true, description: 'JSON input matching this operation schema; it is sent only to the current trusted Host adapter.' },
    }, output, timeoutMs: 180_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      return JSON.stringify(await ctx.computeCore.runPrivatePluginOperation(args.packageSha256,
        args.candidateSha256, args.operationId, args.input,
        { agent: exec.agent, callId: exec.callId, signal: exec.signal }))
    },
    presentCall: () => ({ card: 'generic', title: '调用本机私有插件 · 等待机主授权', kind: 'execute' }),
  }))
  ctx.tools.register(defineTool({
    name: 'plugin_private_uninstall',
    description: 'Uninstall one exact PRIVATE local plugin activation after one-shot Host owner approval. Its stored sample archive remains separate and cannot run after uninstall. No market or public state changes.',
    parameters: {
      packageSha256: { type: 'string', required: true, description: 'Exact installed private archive SHA-256.' },
      candidateSha256: { type: 'string', required: true, description: 'Exact installed candidate SHA-256.' },
    }, output, timeoutMs: 180_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      return JSON.stringify(await ctx.computeCore.uninstallPrivatePlugin(args.packageSha256,
        args.candidateSha256, { agent: exec.agent, callId: exec.callId, signal: exec.signal }))
    },
    presentCall: () => ({ card: 'generic', title: '卸载本机私有插件 · 等待机主授权', kind: 'execute' }),
  }))
  ctx.inject(['systemPrompt'], (scope) => {
    const prompt = (scope as {
      systemPrompt?: { section: (section: { name: string; order: number; text: string }) => () => void }
    }).systemPrompt
    prompt?.section({ name: PLUGIN_DRAFT_PROMPT_SECTION, order: 611, text: PLUGIN_DRAFT_PROMPT })
  })
}
