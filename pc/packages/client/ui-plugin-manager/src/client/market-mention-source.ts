/** One @ entry for Shanghai's task-type catalog, regardless of who supplied an implementation. */
import type { InputTriggerSource, ClientSessionContext, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { MarketInputFile, MarketTaskType } from './market-task-transport.ts'
import type { MarketCapabilitiesController, MarketCapabilityView } from './market-capabilities-controller.ts'
import { canCallMarketCapability } from './market-capabilities-controller.ts'
import { canComposeMarketCapability } from './market-selection.ts'
import type { MarketUsageRanking } from './market-usage.ts'
import { supportsVideoFirstFrameTask } from './video-creative-handoff.ts'
import type { ImageTrialKey } from './image-trial-locales.ts'
import { imageTrialSize, type ImageTrialSize } from './image-trial-transport.ts'
import type { VideoTrialSubmission } from './conversation-video-trial.tsx'
import type { VideoTrialFrame } from './video-trial-transport.ts'
import type { VideoTrialKey } from './video-trial-locales.ts'
import { videoTrialFrame, videoTrialPromptError } from './video-trial-input.ts'
import type { FormalMediaKey } from './formal-media-locales.ts'

const CATEGORY_LABELS: Record<string, string> = {
  text: '文字', writing: '文字', document: '文档', doc: '文档', pdf: '文档',
  translation: '翻译', image: '图片', illustration: '图片',
  audio: '音频', voice: '音频', music: '音乐', video: '视频',
  animation: '动图', ppt: 'PPT', presentation: 'PPT',
  spreadsheet: '表格', data: '数据', analytics: '数据', compute: '算力', ai: '智能',
  research: '研究', search: '检索', code: '开发', development: '开发',
  web: '网页', network: '网络', automation: '自动化', design: '设计',
  legal: '法律', finance: '财务', business: '商务',
  marketing: '营销', education: '教育', office: '办公', other: '其他',
  encoding: '编码', crawl: '采集', file: '文件', render: '渲染',
}

export function categoryLabel(category: string, provided?: string): string {
  return provided?.trim() || CATEGORY_LABELS[category.toLowerCase()] || `其他 · ${category}`
}

function categoryGroup(item: MarketCapabilityView): string {
  return categoryLabel(item.category, item.categoryLabelZh)
}

const MARKET_PREFIX = '市场/'
/** Local drafting identity only. This row is never inserted into Shanghai's catalog. */
export const videoDraftCapability: MarketCapabilityView = {
  taskType: 'video_generate', capabilityId: 'video.render', name: '出视频',
  description: '在对话里描述视频和参数；自动成片暂未接通', category: 'video', categoryLabelZh: '视频',
  acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file', requiredParams: ['input_manifest', 'prompt'],
  outputKind: 'artifact_ref', contractVersion: 'draft-only', publisherKind: 'official',
  publisherKinds: ['official'], executionMode: 'device', availability: 'unavailable', formReady: false,
  requiresQuote: true, executionQuotePath: null, currency: 'CNY', products: [],
}
const videoDraftCandidate = { name: 'video_generate', label: '出视频',
  description: '直接在对话里描述内容、秒数、画质和横竖屏；自动成片暂未接通',
  section: '创作', value: 'market:video-draft' }
const imageEntryValue = 'market:image-entry'
const imageUnavailableText = '官方出图执行合同尚未开放；当前不能报价或派单。请稍后重试。'
const imageEntryCandidate = (ready: boolean) => ({ name: 'image.generate', label: '出图',
  description: ready ? '输入画面描述，查看官方单次报价并确认派单' : imageUnavailableText,
  section: '创作', value: imageEntryValue })
const videoEntryHint = '直接描述视频内容，可补充秒数、画质和横竖屏；按你提供的原文生成，当前自动成片暂未接通'
const videoAttachmentPendingHint = '视频调用暂未开放，需求和附件已保留在输入框；当前没有上传、派单或扣费。'
const GROUP_ORDER = ['文字', '文档', '翻译', '图片', '动图', '视频', '音频', '音乐',
  'PPT', '表格', '数据', '算力', '智能', '研究', '检索', '开发', '网页', '网络', '自动化',
  '设计', '法律', '财务', '商务', '营销', '教育', '办公', '编码', '采集', '文件', '渲染', '其他']

function groups(products: readonly MarketCapabilityView[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const product of products) {
    const label = categoryGroup(product)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].sort(([left], [right]) =>
    (GROUP_ORDER.indexOf(left) < 0 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(left))
    - (GROUP_ORDER.indexOf(right) < 0 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(right)))
    .map(([label, count]) => ({ label, count }))
}

function matchRank(item: MarketCapabilityView, query: string): number {
  if (!query) return 0
  if (query === '出视频' && item.capabilityId === 'video.render' && item.category === 'video') return 0
  const name = item.name.toLocaleLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  return [item.description, item.taskType, item.category, item.categoryLabelZh,
    categoryLabel(item.category)].some(value => value.toLocaleLowerCase().includes(query)) ? 3 : 4
}

function candidate(item: MarketCapabilityView, section = `市场 · ${categoryGroup(item)}`, alias = false) {
  return {
    name: item.taskType, label: alias ? '出视频' : item.name,
    description: `${item.publisherKinds.includes('official') ? '官方能力' : '用户市场'} · 按次报价 · ${item.description}`,
    section, value: `market:capability:${item.taskType}`,
  }
}

function videoAlias(catalog: readonly MarketCapabilityView[], forms: readonly MarketTaskType[]): MarketCapabilityView | undefined {
  // Capability/category labels do not prove a reviewed first-frame publication.
  // The Host-parsed current task form must carry the exact reviewed input and publication.
  const videos = catalog.filter(item => item.capabilityId === 'video.render' && item.category === 'video'
    && item.executionMode === 'device'
    && item.acceptedInputKinds.includes('multi_file')
    && forms.some(form => form.taskType === item.taskType && supportsVideoFirstFrameTask(form))
    && canComposeMarketCapability(item, catalog))
  const item = videos.length === 1 ? videos[0] : undefined
  return item !== undefined && !catalog.some(other => other.taskType !== item.taskType && other.name === '出视频')
    ? item : undefined
}

/** A public image entry binds only one current, official, quoted text-to-image contract. */
function imageAlias(catalog: readonly MarketCapabilityView[]): MarketCapabilityView | undefined {
  const images = catalog.filter(item => item.capabilityId === 'image.generate'
    && item.category === 'image' && item.publisherKind === 'official'
    && item.executionMode === 'device'
    && item.acceptedInputKinds.includes('inline') && canCallMarketCapability(item))
  return images.length === 1 ? images[0] : undefined
}

function quickCandidates(available: readonly MarketCapabilityView[], usage: MarketUsageRanking) {
  const byTask = new Map(available.map(item => [item.taskType, item]))
  const picked = new Set<string>()
  const result: ReturnType<typeof candidate>[] = []
  const append = (ids: readonly string[], section: string, limit: number) => {
    for (const id of ids) {
      const item = byTask.get(id)
      if (item === undefined || picked.has(id)) continue
      picked.add(id)
      result.push(candidate(item, section))
      if (result.length >= limit) break
    }
  }
  append(usage.frequent, '常用能力', 3)
  append(usage.recent, '最近使用', 6)
  return result
}

/** Market claims stay in their submitting Session; Shanghai pricing still requires a separate owner click. */
export function createMarketMentionSource(input: {
  capabilities: MarketCapabilitiesController
  /** Current Host-parsed signed task forms; absent keeps the short video alias closed. */
  videoTaskTypes?: (signal: AbortSignal) => Promise<readonly MarketTaskType[]>
  callCapability: (session: ClientSessionContext, capability: MarketCapabilityView,
    goal: string, files?: readonly MarketInputFile[], directVideoEntry?: true) => boolean
  /** Draft only. This callback cannot create a plan, quote, or paid order. */
  callVideoDraft?: (session: ClientSessionContext, goal: string) => boolean
  /** The call preset exposes only the two official buyer entries. */
  callingMode?: (session: ClientSessionContext) => boolean
  /** Explicit Host opt-in; the composer action submits an unbilled research job. */
  imageTrial?: {
    enabled(signal?: AbortSignal): Promise<boolean>
    open(session: ClientSessionContext, goal: string, size: ImageTrialSize): boolean | Promise<boolean>
    text(key: ImageTrialKey): string
  }
  videoTrial?: {
    enabled(signal?: AbortSignal): Promise<boolean>
    open(session: ClientSessionContext, goal: string, frame?: VideoTrialFrame, sha256?: string): Promise<VideoTrialSubmission>
    text(key: VideoTrialKey): string
  }
  /** Official media overrides the separately enabled trial only when Shanghai reports billing ready. */
  formalMedia?: {
    enabled(signal?: AbortSignal): Promise<boolean>
    open(session: ClientSessionContext, capability: 'image' | 'video', goal: string, attachments: readonly SubmitAttachment[]):
    Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
    text(key: FormalMediaKey): string
  }
  prepareAttachments?: ((session: ClientSessionContext, attachments: readonly SubmitAttachment[]) => Promise<MarketInputFile[]>) | undefined
  usage?: { rankedTaskTypes(): Promise<MarketUsageRanking> }
}): InputTriggerSource {
  let formalMediaReady = false
  const refreshFormalMedia = async (session: ClientSessionContext, signal?: AbortSignal): Promise<void> => {
    if (!input.callingMode?.(session) || input.formalMedia === undefined) { formalMediaReady = false; return }
    try { formalMediaReady = await input.formalMedia.enabled(signal) && !signal?.aborted }
    catch { formalMediaReady = false }
  }
  let imageTrialReady = false
  const refreshImageTrial = async (session: ClientSessionContext, signal?: AbortSignal): Promise<boolean> => {
    if (!input.callingMode?.(session) || input.imageTrial === undefined) return false
    try { imageTrialReady = await input.imageTrial.enabled(signal) }
    catch { imageTrialReady = false }
    return imageTrialReady && !signal?.aborted
  }
  let videoForms: readonly MarketTaskType[] = []
  let videoReadGeneration = 0
  const refreshVideoForms = async (signal: AbortSignal): Promise<readonly MarketTaskType[]> => {
    const generation = ++videoReadGeneration
    try {
      const forms = await input.videoTaskTypes?.(signal) ?? []
      if (signal.aborted || generation !== videoReadGeneration) return []
      videoForms = forms
      return forms
    } catch {
      if (generation === videoReadGeneration) videoForms = []
      return []
    }
  }
  const claimFor = (session: ClientSessionContext, item: MarketCapabilityView,
    alias?: 'image' | 'video') => ({
    name: item.taskType,
    token: `@${alias === 'video' ? '出视频' : alias === 'image' ? '出图' : item.name} `,
    hint: alias === 'video' ? videoEntryHint
      : '描述要完成的事，中央服务器报价后由你确认',
    attachments: alias === undefined && input.prepareAttachments !== undefined && item.acceptedInputKinds.includes('multi_file'),
    async submit(args: string, _actx: unknown, attachments: readonly SubmitAttachment[]) {
      if (input.callingMode?.(session) && alias === undefined) {
        return { kind: 'error' as const, text: '调用模式当前只开放出图和出视频。' }
      }
      if (alias === 'video' && attachments.length > 0) {
        return { kind: 'error' as const, text: videoAttachmentPendingHint }
      }
      if (alias === 'image' && attachments.length > 0) {
        return { kind: 'error' as const, text: '出图当前只接受文字。附件和草稿已保留。' }
      }
      if (attachments.length > 0 && (input.prepareAttachments === undefined || !item.acceptedInputKinds.includes('multi_file'))) {
        return { kind: 'error' as const, text: '此技能当前只接受文字。附件和草稿已保留，请选择支持文件的技能。' }
      }
      const goal = args.trim()
      if (!goal) return { kind: 'error' as const, text: '请描述要完成的事。' }
      if (goal.length > 8000) return { kind: 'error' as const, text: '任务描述不能超过 8000 字。' }
      const snapshot = input.capabilities.store.getSnapshot()
      if (!snapshot.loaded || snapshot.loading || snapshot.error) {
        return { kind: 'error' as const, text: '此能力目前不能调用，请刷新市场后重试。' }
      }
      const catalog = snapshot.capabilities
      const current = catalog.find(row => row.taskType === item.taskType)
      if (current === undefined || !(alias === 'image'
        ? imageAlias(catalog) === current : canComposeMarketCapability(current, catalog))) {
        return { kind: 'error' as const, text: '此能力目前不能调用，请刷新市场后重试。' }
      }
      if (alias === 'video' && videoAlias(catalog, await refreshVideoForms(new AbortController().signal)) !== current) {
        return { kind: 'error' as const, text: '出视频能力已变化，请重新选择当前能力。' }
      }
      let files: MarketInputFile[] | undefined
      if (attachments.length > 0) {
        if (!current.acceptedInputKinds.includes('multi_file')) return { kind: 'error' as const, text: '此技能当前只接受文字。附件和草稿已保留，请选择支持文件的技能。' }
        try { files = await input.prepareAttachments?.(session, attachments) }
        catch { return { kind: 'error' as const, text: '附件还没准备好，草稿已保留；请检查文件上传后重试。当前没有发单。' } }
      }
      const recorded = alias === 'video' ? input.callCapability(session, current, goal, undefined, true)
        : files === undefined ? input.callCapability(session, current, goal)
          : input.callCapability(session, current, goal, files)
      if (!recorded) {
        return { kind: 'error' as const, text: '当前会话尚未准备好，请稍后重试。' }
      }
      return { kind: 'success' as const }
    },
  })
  const claimImageUnavailable = () => ({
    name: 'image.generate', token: '@出图 ', hint: imageUnavailableText, attachments: false,
    submit() { return Promise.resolve({ kind: 'error' as const, text: imageUnavailableText }) },
  })
  const claimImage = (session: ClientSessionContext, image: MarketCapabilityView | undefined) => {
    const official = () => image === undefined ? claimImageUnavailable() : claimFor(session, image, 'image')
    const trial = input.imageTrial
    if (!input.callingMode?.(session) || (trial === undefined && input.formalMedia === undefined)) return official()
    type Submission = { kind: 'success' } | { kind: 'error'; text: string }
    let submitted: Promise<Submission> | null = null
    const submit = async (args: string, actx: unknown, attachments: readonly SubmitAttachment[]): Promise<Submission> => {
      if (input.formalMedia !== undefined) {
        try { if (await input.formalMedia.enabled()) return await input.formalMedia.open(session, 'image', args, attachments) }
        catch { return { kind: 'error', text: input.formalMedia.text('quoteFailed') } }
      }
      if (await refreshImageTrial(session)) {
        if (trial === undefined) return { kind: 'error', text: imageUnavailableText }
        if (attachments.length > 0) return { kind: 'error', text: trial.text('attachments') }
        const goal = args.trim()
        if (!goal) return { kind: 'error', text: trial.text('empty') }
        if (goal.length > 4000) return { kind: 'error', text: trial.text('tooLong') }
        const size = imageTrialSize(goal)
        if (size === null) return { kind: 'error', text: trial.text('sizeConflict') }
        return await trial.open(session, goal, size) ? { kind: 'success' }
          : { kind: 'error', text: trial.text('notReady') }
      }
      if (trial !== undefined) return { kind: 'error', text: trial.text('unavailable') }
      await input.capabilities.ensureLoaded()
      const snapshot = input.capabilities.store.getSnapshot()
      const current = snapshot.loaded && !snapshot.loading && !snapshot.error
        ? imageAlias(snapshot.capabilities) : undefined
      if (current === undefined) return claimImageUnavailable().submit()
      return claimFor(session, current, 'image').submit(args, actx, attachments)
    }
    return {
      name: 'image.generate', token: '@出图 ', attachments: input.formalMedia !== undefined,
      hint: formalMediaReady && input.formalMedia !== undefined ? input.formalMedia.text('hint')
        : trial !== undefined ? trial.text(imageTrialReady ? 'hint' : 'unavailable')
          : input.formalMedia?.text('hint') ?? official().hint,
      submit(args: string, actx: unknown, attachments: readonly SubmitAttachment[]) {
        // Re-entering this exact composer claim joins its one submission. A fresh user message gets a fresh claim.
        submitted ??= submit(args, actx, attachments).then((result) => {
          if (result.kind === 'error') submitted = null
          return result
        }, (failure: unknown) => { submitted = null; throw failure })
        return submitted
      },
    }
  }
  const claimVideoDraft = (session: ClientSessionContext) => ({
    name: 'video_generate', token: '@出视频 ',
    hint: videoEntryHint, attachments: false,
    submit(args: string, _actx: unknown, attachments: readonly SubmitAttachment[]) {
      if (attachments.length > 0) return Promise.resolve({ kind: 'error' as const, text: videoAttachmentPendingHint })
      const goal = args.trim()
      if (!goal) return Promise.resolve({ kind: 'error' as const, text: '请描述要完成的事。' })
      if (goal.length > 8000) return Promise.resolve({ kind: 'error' as const, text: '任务描述不能超过 8000 字。' })
      return Promise.resolve(input.callVideoDraft?.(session, goal) === true ? { kind: 'success' as const }
        : { kind: 'error' as const, text: '当前会话尚未准备好，请稍后重试。' })
    },
  })
  const claimVideo = (session: ClientSessionContext, alias?: MarketCapabilityView) => {
    const fallback = () => alias === undefined ? claimVideoDraft(session) : claimFor(session, alias, 'video')
    const trial = input.videoTrial
    if (!input.callingMode?.(session) || (trial === undefined && input.formalMedia === undefined)) return fallback()
    type Submission = { kind: 'success' } | { kind: 'error'; text: string }
    let submitted: Promise<Submission> | null = null
    let unknown = false
    const submit = async (args: string, actx: unknown, attachments: readonly SubmitAttachment[]): Promise<Submission> => {
      if (input.formalMedia !== undefined) {
        try { if (await input.formalMedia.enabled()) return await input.formalMedia.open(session, 'video', args, attachments) }
        catch { return { kind: 'error', text: input.formalMedia.text('quoteFailed') } }
      }
      if (trial === undefined || !(await trial.enabled())) {
        await input.capabilities.ensureLoaded()
        const snapshot = input.capabilities.store.getSnapshot()
        const current = snapshot.loaded && !snapshot.loading && !snapshot.error
          ? videoAlias(snapshot.capabilities, await refreshVideoForms(new AbortController().signal)) : undefined
        return (current === undefined ? claimVideoDraft(session) : claimFor(session, current, 'video')).submit(args, actx, attachments)
      }
      const goal = args.trim()
      const error = videoTrialPromptError(goal)
      if (error !== null) return { kind: 'error', text: trial.text(error) }
      let inputFrame: Awaited<ReturnType<typeof videoTrialFrame>>
      try { inputFrame = await videoTrialFrame(attachments) }
      catch { return { kind: 'error', text: trial.text('attachments') } }
      const result = await trial.open(session, goal, inputFrame.frame, inputFrame.sha256)
      if (result.outcome === 'accepted') return { kind: 'success' }
      unknown = result.outcome === 'unknown'
      return { kind: 'error', text: trial.text(unknown ? 'uncertain'
        : result.outcome === 'notReady' ? 'notReady' : result.outcome === 'busy' ? 'busy' : 'refused') }
    }
    return { name: 'video_generate', token: '@出视频 ', attachments: true, hint: input.formalMedia?.text('hint') ?? trial?.text('hint') ?? videoEntryHint,
      submit(args: string, actx: unknown, attachments: readonly SubmitAttachment[]) {
        // An unknown outcome keeps this claim locked to its original request. Its activity offers GET-only reconciliation.
        submitted ??= submit(args, actx, attachments).then((result) => {
          if (result.kind === 'error' && !unknown) submitted = null
          return result
        }, () => { unknown = true; return { kind: 'error' as const, text: trial?.text('uncertain') ?? input.formalMedia?.text('uncertain') ?? videoAttachmentPendingHint } })
        return submitted
      },
    }
  }
  return {
    trigger: '@', name: 'market-capabilities', namespace: MARKET_PREFIX, order: -20, showGroupTitle: false,
    async candidates(session, { query, quoted, signal }) {
      const aborted = () => signal.aborted
      if (quoted) return []
      await Promise.all([input.capabilities.ensureLoaded(), refreshImageTrial(session, signal), refreshFormalMedia(session, signal)])
      if (aborted()) return []
      let usage: MarketUsageRanking = { frequent: [], recent: [] }
      if (input.usage !== undefined && !input.capabilities.store.getSnapshot().error) {
        try { usage = await input.usage.rankedTaskTypes() }
        catch (_failure) { /* Optional picker preferences do not affect selection or calls. */ }
      }
      if (aborted()) return []
      const snapshot = input.capabilities.store.getSnapshot()
      const formal = formalMediaReady ? input.formalMedia : undefined
      const formalVideo = { ...videoDraftCandidate, description: formal?.text('hint') ?? videoDraftCandidate.description }
      const activeImageTrial = imageTrialReady ? input.imageTrial : undefined
      if (query.trim() === '出图' && formal !== undefined) return [{ ...imageEntryCandidate(true), description: formal.text('hint') }]
      if (query.trim() === '出图') return [activeImageTrial !== undefined && input.callingMode?.(session)
        ? { ...imageEntryCandidate(true), description: activeImageTrial.text('hint') }
        : input.callingMode?.(session) && input.imageTrial !== undefined
          ? { ...imageEntryCandidate(false), description: input.imageTrial.text('unavailable') }
          : imageEntryCandidate(snapshot.loaded && !snapshot.error && imageAlias(snapshot.capabilities) !== undefined)]
      if (query.trim() === '出视频' && input.callVideoDraft !== undefined) {
        if (formal !== undefined) return [formalVideo]
        const alias = snapshot.loaded && !snapshot.error
          ? videoAlias(snapshot.capabilities, await refreshVideoForms(signal)) : undefined
        if (aborted()) return []
        return alias === undefined ? [videoDraftCandidate] : [candidate(alias, '市场 · 视频', true)]
      }
      if (input.callingMode?.(session) && query === '') {
        const ready = snapshot.loaded && !snapshot.loading && !snapshot.error
        const image = ready ? imageAlias(snapshot.capabilities) : undefined
        const video = ready && input.callVideoDraft !== undefined
          ? videoAlias(snapshot.capabilities, await refreshVideoForms(signal)) : undefined
        if (aborted()) return []
        return [formal !== undefined ? { ...imageEntryCandidate(true), description: formal.text('hint') }
          : activeImageTrial !== undefined ? { ...imageEntryCandidate(true), description: activeImageTrial.text('hint') }
            : input.imageTrial !== undefined ? { ...imageEntryCandidate(false), description: input.imageTrial.text('unavailable') }
              : imageEntryCandidate(image !== undefined), ...(input.callVideoDraft === undefined ? []
          : [formal !== undefined ? formalVideo : video === undefined ? videoDraftCandidate : candidate(video, '创作', true)])]
      }
      if (input.callingMode?.(session)) return []
      const available = snapshot.capabilities.filter(item => canComposeMarketCapability(item, snapshot.capabilities))
      const needle = query.trim().toLocaleLowerCase()
      const categoryPath = query.startsWith(MARKET_PREFIX)
        ? query.slice(MARKET_PREFIX.length).split('/', 2) : null
      const group = categoryPath?.[0] ?? ''
      const inGroup = categoryPath !== null && group !== '' && query.includes('/', MARKET_PREFIX.length)
      const browse = !needle || ['市场', '插件市场', '技能市场'].some(name => name.includes(needle))
        ? [{ name: 'market', label: '选择市场能力', description: '在对话内按类别选择官方和用户能力',
          section: '市场', value: 'market:browse', drill: true }] : []
      if (!snapshot.loaded || snapshot.loading || snapshot.error) return browse
      if (query === '' || query === MARKET_PREFIX) {
        return [...(query === '' ? quickCandidates(available, usage) : []), ...browse, ...groups(available).map(category => ({
          name: category.label, label: category.label, description: `${category.count} 项能力`,
          section: '市场分类', value: `market:category:${category.label}`, drill: true,
        }))]
      }
      const search = inGroup ? (categoryPath[1] ?? '').trim().toLocaleLowerCase() : needle
      const rankedUsage = [...new Set([...usage.frequent, ...usage.recent])]
      const usageRank = (taskType: string) => {
        const rank = rankedUsage.indexOf(taskType)
        return rank < 0 ? rankedUsage.length : rank
      }
      const alias = needle === '出视频' ? videoAlias(snapshot.capabilities, await refreshVideoForms(signal)) : undefined
      return [...available.filter(item =>
        (needle !== '出视频' || item === alias) &&
        (!inGroup || categoryGroup(item) === group) && matchRank(item, search) < 4)
        .sort((left, right) => matchRank(left, search) - matchRank(right, search)
          || usageRank(left.taskType) - usageRank(right.taskType))
        .map(item => candidate(item, `市场 · ${categoryGroup(item)}`, item === alias)), ...browse]
    },
    header(_session, { query }) {
      if (!query.startsWith(MARKET_PREFIX)) return undefined
      const group = query.slice(MARKET_PREFIX.length).split('/')[0] ?? ''
      return group === '' ? [{ label: '市场', value: 'market:root', current: true }]
        : [{ label: '市场', value: 'market:root' },
          { label: group, value: `market:category:${group}`, current: true }]
    },
    warm() { void input.capabilities.ensureLoaded() },
    onPick({ candidate, position, session }) {
      const id = candidate.value
      if (id === imageEntryValue) {
        const snapshot = input.capabilities.store.getSnapshot()
        const image = snapshot.loaded && !snapshot.loading && !snapshot.error
          ? imageAlias(snapshot.capabilities) : undefined
        return position === 'leading'
          ? { claim: claimImage(session, image) }
          : { text: '@出图 ' }
      }
      if (id === 'market:video-draft' && input.callVideoDraft !== undefined) return position === 'leading'
        ? { claim: claimVideo(session) } : { text: '@出视频 ' }
      if (input.callingMode?.(session)
        && !(id?.startsWith('market:capability:') && candidate.label === '出视频')) return undefined
      if (id === 'market:root') return { text: `@${MARKET_PREFIX}`, continue: true }
      if (id?.startsWith('market:category:')) {
        const group = id.slice('market:category:'.length)
        const available = input.capabilities.store.getSnapshot().capabilities.filter(canCallMarketCapability)
        if (!groups(available).some(item => item.label === group)) return undefined
        return { text: `@${MARKET_PREFIX}${group}/`, continue: true }
      }
      if (id === 'market:browse') return { text: `@${MARKET_PREFIX}`, continue: true }
      if (!id?.startsWith('market:capability:')) return undefined
      const snapshot = input.capabilities.store.getSnapshot()
      if (!snapshot.loaded || snapshot.loading || snapshot.error) return undefined
      const taskType = id.slice('market:capability:'.length)
      const item = input.capabilities.store.getSnapshot().capabilities.find(item => item.taskType === taskType)
      if (item === undefined || !canComposeMarketCapability(item, input.capabilities.store.getSnapshot().capabilities)) return undefined
      const alias = candidate.label === '出视频' && videoAlias(snapshot.capabilities, videoForms) === item
      if (input.callingMode?.(session) && !alias) return undefined
      if (position === 'leading') return { claim: alias ? claimVideo(session, item) : claimFor(session, item) }
      return { text: `@${alias ? '出视频' : item.name} ` }
    },
    matchSpace(session, token) {
      const snapshot = input.capabilities.store.getSnapshot()
      if (token === '@出图') {
        const image = snapshot.loaded && !snapshot.loading && !snapshot.error
          ? imageAlias(snapshot.capabilities) : undefined
        return { claim: claimImage(session, image) }
      }
      if (token === '@出视频' && input.callVideoDraft !== undefined) {
        const alias = snapshot.loaded && !snapshot.error ? videoAlias(snapshot.capabilities, videoForms) : undefined
        return { claim: claimVideo(session, alias) }
      }
      if (!snapshot.loaded || snapshot.loading || snapshot.error) return undefined
      const alias = token === '@出视频' ? videoAlias(snapshot.capabilities, videoForms) : undefined
      if (token === '@出视频') return alias === undefined ? undefined : { claim: claimFor(session, alias, 'video') }
      if (input.callingMode?.(session)) return undefined
      const found = input.capabilities.store.getSnapshot().capabilities.filter(item => token === `@${item.name}`)
      const item = found[0]
      return found.length === 1 && item !== undefined
        && canComposeMarketCapability(item, input.capabilities.store.getSnapshot().capabilities)
        ? { claim: claimFor(session, item) } : undefined
    },
    async matchEnter(session, line, signal, envelope) {
      const aborted = () => signal.aborted
      if (line.startsWith(`@${MARKET_PREFIX}`)) {
        throw new Error('请在 @市场/ 目录中选择一个具体能力，再填写任务；市场目录不是本机文件路径。')
      }
      const asksForVideo = line === '@出视频' || (line.startsWith('@出视频')
        && /^\s/u.test(line.slice('@出视频'.length)))
      const asksForImage = line === '@出图' || (line.startsWith('@出图')
        && /^\s/u.test(line.slice('@出图'.length)))
      if (asksForImage) {
        if (envelope.attachments > 0 && !(input.callingMode?.(session) && input.formalMedia !== undefined)) {
          throw new Error('出图当前只接受文字。附件和草稿已保留。')
        }
        if (input.callingMode?.(session) && input.formalMedia !== undefined) return { claim: claimImage(session, undefined) }
        await input.capabilities.ensureLoaded()
        if (signal.aborted) return undefined
        const snapshot = input.capabilities.store.getSnapshot()
        const image = snapshot.loaded && !snapshot.loading && !snapshot.error
          ? imageAlias(snapshot.capabilities) : undefined
        return { claim: claimImage(session, image) }
      }
      if (asksForVideo && input.callVideoDraft !== undefined) {
        if (signal.aborted) return undefined
        if (input.callingMode?.(session) && (input.videoTrial !== undefined || input.formalMedia !== undefined)) {
          return { claim: claimVideo(session) }
        }
        if (envelope.attachments > 0) {
          throw new Error(videoAttachmentPendingHint)
        }
        await input.capabilities.ensureLoaded()
        if (aborted()) return undefined
        const current = input.capabilities.store.getSnapshot()
        const alias = current.loaded && !current.error
          ? videoAlias(current.capabilities, await refreshVideoForms(signal)) : undefined
        if (aborted()) return undefined
        return { claim: claimVideo(session, alias) }
      }
      await input.capabilities.ensureLoaded()
      const snapshot = input.capabilities.store.getSnapshot()
      if (signal.aborted) return undefined
      if (!snapshot.loaded || snapshot.loading || snapshot.error) {
        if (asksForVideo) throw new Error('暂时无法核对出视频能力，请刷新市场后重试。')
        return undefined
      }
      if (asksForVideo) {
        const alias = videoAlias(snapshot.capabilities, await refreshVideoForms(signal))
        if (alias === undefined) throw new Error('目前没有唯一可用的出视频能力，请在市场中选择具体能力。')
        if (envelope.attachments > 0) {
          throw new Error(videoAttachmentPendingHint)
        }
        return { claim: claimFor(session, alias, 'video') }
      }
      const matches = input.capabilities.store.getSnapshot().capabilities.filter(item =>
        line === `@${item.name}` || (line.startsWith(`@${item.name}`)
          && /^\s/u.test(line.slice(item.name.length + 1))))
      if (input.callingMode?.(session) && matches.length > 0) {
        throw new Error('调用模式当前只开放 @出图 和 @出视频。')
      }
      if (matches.length !== 1) return undefined
      const item = matches[0]
      if (item === undefined) return undefined
      if (envelope.attachments > 0 && (input.prepareAttachments === undefined || !item.acceptedInputKinds.includes('multi_file'))) {
        throw new Error('此技能当前只接受文字。附件和草稿已保留，请选择支持文件的技能。')
      }
      if (!canCallMarketCapability(item)) {
        throw new Error('此能力目前不能调用，请刷新市场后重试。')
      }
      return { claim: claimFor(session, item) }
    },
  }
}
