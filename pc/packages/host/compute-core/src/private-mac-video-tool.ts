/** One conversation-scoped, owner-approved trial of the reviewed private Mac video bundle. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ComputeError } from './errors.ts'
import { issueLocalExecutionApproval } from './local-execution-admission.ts'
import { macDrawnVideoHostPath, runAuthorizedMacDrawnVideoTrial, type LocalVideoAttachmentStore, type LocalVideoFileRef } from './local-video-trial.ts'
import { verifyPrivateMacVideoInstallation, type PrivateMacVideoBundleManager } from './private-mac-video-install.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from './protocol.ts'
import { planRoute, type RouterNodeOffer } from './router.ts'
import type { ComputeExecutorRegistry } from './executor.ts'
import type { ComputeLocalTaskRunner } from './local-task-runner.ts'
import type { MacDrawnVideoFactory } from './mac-drawn-video-factory.ts'

export const name = 'qianshou-private-mac-video-tool'
export const inject = ['tools', 'computeCore']
export const PRIVATE_MAC_VIDEO_PROMPT_SECTION = 'qianshou:private-mac-video'
export const PRIVATE_MAC_VIDEO_PROMPT = `结合当前对话理解机主是否要使用已安装的五秒 Mac 绘制视频插件；机主仅询问能力时先说明，不调用试跑。当前轮是机主真实消息且模型调用工具时，Host 会核对 qianshou-mac-drawn-video@0.1.0 的安装包字节和活动状态，再展示固定模板、输出和范围，请机主逐次决定是否执行。不从单句关键词判断意图。模型不能提供脚本、路径、URL、审批结果或运行机器。拒绝、缺包、缺工具或运行失败时必须如实告知，不得声称视频已生成。成功时对话中的工具结果卡会确定性展示播放器；模型只看到附件 ID 和完成状态，不会收到本机路径。这个能力仅供本机私有试用，不代表插件市场上架、上海接单或收费。`

const MAX_VIDEO_BYTES = 20 * 1024 * 1024
const TOOL = 'plugin_drawn_video_try_local'
const NODE = 'mac-local-owner'
// Bounded process-local replay guard. After expiry, any new run still requires
// a fresh visible Host approval; no approval token is stored here.
const startedCalls = new Map<string, number>()
const CALL_GUARD_TTL_MS = 60 * 60 * 1000
const MAX_CALL_GUARD_ENTRIES = 4096

interface TrialContext {
  readonly profileDir: string
  readonly home: string
  readonly manager: PrivateMacVideoBundleManager
  readonly executors: Pick<ComputeExecutorRegistry, 'resolve'>
  readonly factory: Pick<MacDrawnVideoFactory, 'available'>
  readonly runner: Pick<ComputeLocalTaskRunner, 'run'>
  readonly attachments: LocalVideoAttachmentStore<LocalVideoFileRef>
}

interface TrialInvocation {
  readonly userText: string
  readonly sessionId: string
  readonly callId: string
  readonly title: string
  readonly subtitle: string
  readonly signal: AbortSignal
  approve(reason: string): Promise<string>
}

function validCaption(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= 128
}

/** Complete only a private local trial; the returned path is from the durable attachment store. */
export async function runPrivateMacVideoTrial(context: TrialContext, invocation: TrialInvocation): Promise<{
  readonly status: 'completed'
  readonly scope: 'private-local-trial'
  readonly marketInstalled: false
  readonly dispatchable: false
  readonly charged: false
  readonly attachmentId: string
  readonly bytes: number
  readonly durationSeconds: 5
  readonly mediaMarkdown: string
}> {
  invocation.signal.throwIfAborted()
  // The current turn must come from a real user. Intent is resolved from the full
  // conversation by the agent, while execution is admitted by the visible Host
  // approval after the exact installed package has been verified.
  if (invocation.userText.trim().length === 0 || invocation.userText.length > 4000
    || !validCaption(invocation.title, 16) || !validCaption(invocation.subtitle, 32)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(invocation.sessionId)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(invocation.callId)) {
    throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_REQUEST_INVALID', 403)
  }
  const callKey = `${invocation.sessionId}:${invocation.callId}`
  const nowMs = Date.now()
  for (const [key, startedAt] of startedCalls) {
    if (nowMs - startedAt > CALL_GUARD_TTL_MS) startedCalls.delete(key)
  }
  if (startedCalls.has(callKey)) throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_CALL_REPEATED', 409)
  if (startedCalls.size >= MAX_CALL_GUARD_ENTRIES) throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_CALL_GUARD_FULL', 503)
  startedCalls.set(callKey, nowMs)
    const installed = await verifyPrivateMacVideoInstallation(context)
    const reason = `本次只在这台 Mac 上运行私有试用插件 ${installed.packageName}@${installed.packageVersion}（包 SHA-256 ${installed.pluginDigest}），生成一个固定海边骑车画面的 5 秒 MP4，标题“${invocation.title}”、副标题“${invocation.subtitle}”。视频文件保存在本机附件并回到当前对话；模型只看到附件 ID，不收到本机路径。不收费、不向上海接单或发布市场。是否仅授权这一次？`
    const decision = await invocation.approve(reason)
    if (decision !== 'allowed-once') throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_OWNER_APPROVAL_REQUIRED', 403)
    invocation.signal.throwIfAborted()
    // The package can change while the owner is reading the approval sheet.
    const current = await verifyPrivateMacVideoInstallation(context)
    if (current.pluginDigest !== installed.pluginDigest) throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_CHANGED', 409)

    const now = new Date()
    const issuedAt = now.toISOString()
    const deadlineAt = new Date(now.getTime() + 240_000).toISOString()
    const token = createHash('sha256').update(callKey).digest('hex')
    const taskId = `mac-video-${token.slice(0, 32)}`
    const intentId = `mac-video-intent-${token.slice(0, 32)}`
    const idempotencyKey = `mac-video-${token}`
    const offer: RouterNodeOffer = {
      offerId: `private-video-${token.slice(0, 16)}`, nodeId: NODE,
      capabilityId: current.capabilityId, capabilityVersion: current.capabilityVersion,
      pluginDigest: current.pluginDigest, health: 'ok', available: true, ownerAuthorized: true,
      platform: 'darwin-arm64', modelIds: [], vramBytes: 0, dataScopes: ['task-inputs'],
      privacy: 'private', queueDepth: 0, maxConcurrency: 1, runningTasks: 0,
      estimatedLatencyMs: 180_000, priceMinor: 0, currency: 'CNY', successRate: 1,
      observedAt: issuedAt, expiresAt: deadlineAt,
    }
    const plan = planRoute({ now: issuedAt, intent: {
      version: 'qianshou.intent.v1', intentId, capabilityId: current.capabilityId,
      capabilityVersion: current.capabilityVersion, requiredPlatform: 'darwin-arm64',
      requiredPluginDigest: current.pluginDigest, dataScope: 'task-inputs', privacy: 'private',
      ownerAuthorization: 'approved', allowedNodeIds: [NODE], budgetMinor: 0,
      currency: 'CNY', deadlineAt, idempotencyKey,
    }, offers: [offer] })
    const approval = issueLocalExecutionApproval({ plan, ownerAuthorization: 'approved',
      approvalId: `owner-${randomUUID()}`, executionId: `trial-${randomUUID()}`,
      taskId, workflowId: `local-video-${token.slice(0, 16)}`, intentId, idempotencyKey,
      issuedAt, expiresAt: deadlineAt })
    const task: ComputeTaskEnvelope = {
      version: 'qianshou.task.v1', taskId: ComputeTaskId(taskId),
      capabilityId: ComputeCapabilityId(current.capabilityId), capabilityVersion: current.capabilityVersion,
      inputRefs: [], parameters: { title: invocation.title, subtitle: invocation.subtitle },
      deadlineAt, maxOutputBytes: MAX_VIDEO_BYTES, idempotencyKey,
    }
    const receipt = await runAuthorizedMacDrawnVideoTrial({ runner: context.runner,
      approval, task, workspaceRootPath: join(context.home, 'qianshou', 'private-video-trials'),
      attachments: context.attachments, signal: invocation.signal, reportProgress: () => undefined,
      now: new Date().toISOString(), localNodeId: NODE, pluginDigest: current.pluginDigest })
    const path = macDrawnVideoHostPath(receipt.result, context.attachments)
    return Object.freeze({ status: 'completed', scope: 'private-local-trial', marketInstalled: false,
      dispatchable: false, charged: false, attachmentId: receipt.result.attachment.attachmentId,
      bytes: receipt.result.attachment.bytes, durationSeconds: 5,
      mediaMarkdown: `[播放视频](${encodeURIComponent(path)})` })
}

function realUserText(agent: { session: { deriveMessages(): readonly { role: string; source: { kind: string }; content: readonly { type: string; text?: string }[] }[] } }): string | null {
  const users = agent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'user')
  const last = users.at(-1)
  if (!last || last.content.length !== 1 || last.content[0]?.type !== 'text') return null
  return last.content[0].text ?? null
}

/** Mount only in owner conversation presets, never in worker/dispatch presets. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: TOOL,
    description: 'When the current owner conversation asks to use the installed 5-second Mac video capability, verify the exact active reviewed private package, show real one-shot Host approval for this precise run, draw fixed seaside cycling MP4 locally and return a durable playable conversation link. Use the full conversation for meaning; a short follow-up can refer to an earlier request. Do not call for a mere capability question. No arbitrary script, path, remote order, marketplace claim or billing.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short on-screen title, at most 16 characters, from the owner request.' },
      subtitle: { type: 'string', required: true, description: 'Short on-screen subtitle, at most 32 characters, from the owner request.' },
    },
    timeoutMs: 300_000,
    output: { schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => {
        const result = JSON.parse(value) as { mediaMarkdown: string; [key: string]: unknown }
        const { mediaMarkdown: _privatePath, ...modelSafe } = result
        return [{ type: 'text' as const, text: JSON.stringify(modelSafe) }]
      },
      // Session tool-result metadata is UI-only; it is not projected into model messages.
      presentationMeta: (_args: unknown, value: string) => {
        const result = JSON.parse(value) as { mediaMarkdown: string; [key: string]: unknown }
        return { kind: 'qianshou.private-mac-video-result.v1', ...result }
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new ComputeError('COMPUTE_AGENT_REQUIRED', 403)
      const userText = realUserText(exec.agent) // Never take the authorization text from model arguments.
      if (userText === null) throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_REQUEST_INVALID', 403)
      const host = ctx as unknown as { get(name: string): unknown }
      const profile = host.get('profileContext') as { dir: string; home: string } | undefined
      const manager = host.get('pluginManager') as PrivateMacVideoBundleManager | undefined
      const factory = host.get('macDrawnVideoFactory') as MacDrawnVideoFactory | undefined
      const attachments = host.get('attachments') as LocalVideoAttachmentStore<LocalVideoFileRef> | undefined
      const approval = host.get('approval') as { request(value: { agent: unknown; toolName: string;
        callId: unknown; reason: string; signal: AbortSignal }): Promise<string> } | undefined
      if (!profile || !manager || !factory || !attachments || !approval) {
        throw new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_HOST_UNAVAILABLE', 503)
      }
      const result = await runPrivateMacVideoTrial({ profileDir: profile.dir, home: profile.home,
        manager, factory, executors: ctx.computeCore.executors,
        runner: { run: (task, request) => ctx.computeCore.executeTask(task, request) }, attachments }, {
        userText, sessionId: String(exec.agent.id), callId: String(exec.callId),
        title: args.title, subtitle: args.subtitle, signal: exec.signal,
        approve: reason => approval.request({ agent: exec.agent, toolName: TOOL, callId: exec.callId,
          reason, signal: exec.signal }),
      })
      return JSON.stringify(result)
    },
    presentCall: () => ({ card: 'generic', title: 'Mac 私有视频试跑 · 等待机主审批', kind: 'execute' }),
  }))
  ctx.inject(['systemPrompt'], scope => {
    const prompt = (scope as { systemPrompt?: { section(value: { name: string; order: number; text: string }): () => void } }).systemPrompt
    prompt?.section({ name: PRIVATE_MAC_VIDEO_PROMPT_SECTION, order: 613, text: PRIVATE_MAC_VIDEO_PROMPT })
  })
}
