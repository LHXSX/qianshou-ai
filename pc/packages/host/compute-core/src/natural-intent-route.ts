/**
 * Conservative, local first pass for a human sentence. It never executes a
 * task, sends the sentence to a server, changes the owner's supply policy, or
 * treats a phrase such as "让我的电脑接单" as a permission grant.
 *
 * This is an explicit-phrase baseline, not a calibrated model confidence.
 * Unknown and mixed intentions must stay in the conversation for clarification.
 */
import { ComputeError } from './errors.ts'
import type { CapabilityPoolSnapshot } from './core-client.ts'

export const NATURAL_INTENT_ROUTE_VERSION = 'qianshou.natural-intent-route.v1' as const

/** Capability ids are open so a verified local plugin can introduce a new kind of work. */
export type NaturalCapability = string
/** Plain-language phrases supplied by a live, locally registered executor. */
export interface NaturalCapabilityHint {
  readonly capabilityId: string
  readonly phrases: readonly string[]
}
export type NaturalRoutePath = 'chat' | 'local' | 'guangzhou' | 'borrowed' | 'clarify' | 'unavailable' | 'supply-review'
export type GuangzhouAccountState = 'signed-in' | 'signed-out' | 'unknown'

export interface NaturalIntentRequest {
  readonly text: string
  readonly attachmentCount?: number
}

export interface NaturalIntent {
  readonly kind: 'chat' | 'task' | 'supply' | 'uncertain'
  readonly capability: NaturalCapability | null
  readonly preferred: 'local' | 'guangzhou' | 'borrowed' | null
  /** `explicit` means only that this small rule set matched words, not a probability. */
  readonly evidence: 'explicit' | 'ambiguous' | 'none'
  readonly reason: 'clear' | 'mixed-destinations' | 'mixed-tasks' | 'unsupported-task' | 'missing-task' | 'attachment-needs-context'
}

export interface NaturalRouteFacts {
  /** Only executors actually registered in this Host. A software probe alone is insufficient. */
  readonly localExecutorCapabilities: readonly string[]
  readonly guangzhouAccount: GuangzhouAccountState
  /** Shanghai read only registry snapshot. It is not a reservation or price quote. */
  readonly borrowedPool: CapabilityPoolSnapshot | null
  /** Saved owner policy. Null means unavailable; neither state authorizes a new offer here. */
  readonly ownerSupplyMode: 'off' | 'idle' | 'allowed' | null
}

export interface NaturalRouteDecision {
  readonly version: typeof NATURAL_INTENT_ROUTE_VERSION
  readonly path: NaturalRoutePath
  readonly capability: NaturalCapability | null
  readonly evidence: NaturalIntent['evidence']
  readonly reason: string
  readonly message: string
  readonly nextAction: 'continue-chat' | 'ask-one-question' | 'review-local-permission' | 'use-guangzhou-intent'
    | 'check-quote-and-confirm' | 'open-account' | 'check-capability' | 'open-supply-settings'
  /** A route preview can never be replayed as an execution or charging grant. */
  readonly executionAuthorized: false
  readonly dispatchable: false
  readonly quoteAmountMinor: null
}

/** Reject client-supplied availability, price, authorization and other policy facts. */
export function parseNaturalIntentRequest(value: unknown): NaturalIntentRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'text' && key !== 'attachmentCount')) throw invalid()
  const text = input.text
  const count = input.attachmentCount ?? 0
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 2000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 16) throw invalid()
  return Object.freeze({ text: text.trim(), attachmentCount: count })
}

/** Classify only task forms whose destination and capability can be checked. */
export function classifyNaturalIntent(request: NaturalIntentRequest, hints: readonly NaturalCapabilityHint[] = []): NaturalIntent {
  const text = request.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const asksForMeaning = /(?:是什么意思|是什么|怎么理解|如何理解)[？?]?$/u.test(text)
    || /^(?:请)?(?:解释一下|介绍一下|什么是)/u.test(text)
  if (asksForMeaning) return { kind: 'chat', capability: null, preferred: null, evidence: 'none', reason: 'clear' }
  const supply = /(?:我的|本机|这台).{0,10}(?:电脑|设备|算力).{0,12}(?:接单|出租|出借|共享|赚钱|借给|给别人用)|(?:出借|出租|共享).{0,8}(?:本机|我的|电脑|设备|算力)/u.test(text)
  const local = /(?:本机|本地|我的电脑|这台电脑|在电脑上|在这台).{0,24}(?:打开|整理|处理|运行|安装|编辑|修改|生成|制作|压缩|转码|转换|渲染|剪辑|写|分析|识别|总结)/u.test(text)
  const guangzhou = /(?:广州|千手云|云端|在线接口).{0,16}(?:生成|画|绘制|处理|调用|制作)|(?:用|调用).{0,8}(?:广州|千手云|云端|在线接口)/u.test(text)
  const borrowed = /(?:借用|借|找|调用|使用).{0,16}(?:别人|他人|其他人|别人的|其他设备|其他电脑|算力池|共享算力).{0,12}(?:算力|设备|电脑|显卡|GPU)?/iu.test(text)
  const destinations = [local, guangzhou, borrowed].filter(Boolean).length
  const matched: NaturalCapability[] = []
  if (/(?:生成|画|绘制|出).{0,10}(?:图片|图像|照片|插画)|(?:图片|图像|照片|插画).{0,10}(?:生成|画|绘制)/u.test(text)) matched.push('image.generate')
  if (/(?:压缩|转码|转换格式|转换).{0,10}(?:视频|影片)|(?:视频|影片).{0,10}(?:压缩|转码|转换格式)/u.test(text)) matched.push('media.transcode')
  if (/(?:3D|三维|模型).{0,10}(?:渲染|出图)|(?:渲染|出图).{0,10}(?:3D|三维|模型)/iu.test(text)) matched.push('render.3d')
  if (local && /(?:文件|文件夹|文档|表格|应用|程序)/u.test(text) && matched.length === 0) matched.push('workspace.operation')
  const normalized = text.toLocaleLowerCase()
  // Plugin names may occur in an ordinary question. A name alone cannot turn
  // conversation into an offer to run a locally installed executor.
  const requestsWork = /(?:帮我|替我|给我|请(?:帮|替|为)|生成|制作|做(?:一个|一份|张|个)|处理|压缩|转换|转码|渲染|分析|识别|运行|执行|整理|写|画)/u.test(text)
  for (const hint of hints) {
    if (requestsWork && hint.phrases.some(phrase => {
      const candidate = phrase.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
      return candidate.length >= 3 && normalized.includes(candidate)
    })) {
      matched.push(hint.capabilityId)
    }
  }
  const capabilities = [...new Set(matched)]
  const unsupported = /(?:生成|制作|做).{0,10}(?:视频|短片|动画)|(?:修改|编辑).{0,10}(?:图片|照片|这张图)/u.test(text)

  if (destinations > 1) return uncertain('mixed-destinations')
  if (supply && (destinations > 0 || capabilities.length > 0)) return uncertain('mixed-tasks')
  if (supply) return { kind: 'supply', capability: null, preferred: null, evidence: 'explicit', reason: 'clear' }
  if (capabilities.length > 1) return uncertain('mixed-tasks')
  if (unsupported && capabilities.length === 0) return uncertain('unsupported-task')
  if (capabilities.length === 1) return {
    kind: 'task', capability: capabilities[0] ?? null,
    preferred: local ? 'local' : guangzhou ? 'guangzhou' : borrowed ? 'borrowed' : null,
    evidence: 'explicit', reason: 'clear',
  }
  if (destinations > 0) return uncertain('missing-task')
  if ((request.attachmentCount ?? 0) > 0) return uncertain('attachment-needs-context')
  if (/(?:做|制作|生成|处理|压缩|转换|渲染|打开|安装|修改|编辑|剪辑|执行|写|画)/u.test(text)) return uncertain('missing-task')
  return { kind: 'chat', capability: null, preferred: null, evidence: 'none', reason: 'clear' }
}

/** Plan a preview from Host owned facts, without creating a dispatchable object. */
export function planNaturalIntentRoute(intent: NaturalIntent, facts: NaturalRouteFacts): NaturalRouteDecision {
  if (intent.kind === 'uncertain') return decision('clarify', intent, intent.reason,
    intent.reason === 'mixed-destinations' ? '你想先在这台电脑做，使用千手云，还是借用其他设备？'
      : intent.reason === 'mixed-tasks' ? '这里有不止一件事。你想先完成哪一件？'
        : intent.reason === 'unsupported-task' ? '这项能力还没有验证可用。你想完成的具体结果是什么？'
          : '我还不能确定要做什么。请说一下目标和要处理的文件或内容。', 'ask-one-question')
  if (intent.kind === 'chat') return decision('chat', intent, 'conversation', '继续对话。', 'continue-chat')
  if (intent.kind === 'supply') return decision('supply-review', intent,
    facts.ownerSupplyMode === 'off' ? 'owner-supply-off' : 'owner-supply-review',
    '去“我的能力”选择想接的工作。只有你亲自开启后，这台电脑才会进入接单候选。', 'open-supply-settings')

  const capability = intent.capability
  if (capability === null) return decision('clarify', intent, 'missing-capability', '你想先完成哪一件事？', 'ask-one-question')
  const localReady = facts.localExecutorCapabilities.includes(capability)
  if (intent.preferred === 'local' || (intent.preferred === null && localReady)) {
    if (localReady) return decision('local', intent, 'local-executor-bound',
      '这台电脑有对应能力。下一步确认要用的内容和权限，再开始处理。', 'review-local-permission')
    return decision('unavailable', intent, 'local-executor-missing',
      '这台电脑还没准备好做这件事。可以看看有没有合适的插件，或换一种方式。', 'check-capability')
  }
  if (intent.preferred === 'guangzhou' || (intent.preferred === null && capability === 'image.generate')) {
    if (capability !== 'image.generate') return decision('unavailable', intent, 'guangzhou-route-unverified',
      '这项任务还没有接通广州接口，请换一种方式或先确认能力。', 'check-capability')
    if (facts.guangzhouAccount === 'signed-out') return decision('unavailable', intent, 'account-required',
      '请先登录千手账号，再使用千手云出图。', 'open-account')
    if (facts.guangzhouAccount === 'unknown') return decision('unavailable', intent, 'account-unavailable',
      '暂时读不到千手账号状态，请先在千手账号页查看。', 'open-account')
    return decision('guangzhou', intent, 'account-authenticated',
      '可以用千手云出图。开始前会核对账号可用额度。', 'use-guangzhou-intent')
  }
  const pool = facts.borrowedPool
  if (pool?.capability === capability && pool.lookup === 'found' && (pool.availableNow?.count ?? 0) > 0) {
    return decision('borrowed', intent, 'online-declaration-only',
      '其他设备可能能帮忙。先看实际报价、等待时间和要传送的内容，再决定是否下单。', 'check-quote-and-confirm')
  }
  return decision('unavailable', intent,
    pool?.lookup === 'not_in_registry' ? 'capability-not-in-registry'
      : pool?.lookup === 'found' ? 'no-online-declaration' : 'pool-unreachable',
    '暂时没有找到能接这项工作的设备。你还没有下单，也不会产生费用。', 'check-capability')
}

function uncertain(reason: NaturalIntent['reason']): NaturalIntent {
  return { kind: 'uncertain', capability: null, preferred: null, evidence: 'ambiguous', reason }
}

function decision(path: NaturalRoutePath, intent: NaturalIntent, reason: string, message: string,
  nextAction: NaturalRouteDecision['nextAction']): NaturalRouteDecision {
  return Object.freeze({ version: NATURAL_INTENT_ROUTE_VERSION, path, capability: intent.capability,
    evidence: intent.evidence, reason, message, nextAction, executionAuthorized: false, dispatchable: false,
    quoteAmountMinor: null })
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_NATURAL_INTENT_INVALID', 422) }
