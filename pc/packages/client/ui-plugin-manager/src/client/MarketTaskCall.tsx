/** One simple market action: describe the job, see Shanghai's exact price, then confirm dispatch. */
import { useEffect, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { createMarketTaskTransport, type MarketTaskQuote, type MarketTaskTransport,
  type MarketTaskType, type MarketTaskParamField, type MarketTaskResult, type MarketTaskAcceptance,
  type MarketTaskWorkload, type MarketInputFile, type MarketProductSelection } from './market-task-transport.ts'
import { marketResultMedia } from './market-result-media.ts'
import { marketResultFile } from './market-result-file.ts'
import { marketInputDraft, serializeMarketInput, type MarketInputDraft } from './market-input-form.ts'
import { isMarketTaskDraft, type MarketTaskDraft } from './market-task-draft.ts'
import { MarketInputFields } from './MarketInputFields.tsx'
import type { LoadMarketInputPresentation } from './market-legacy-input-presentation.ts'
import { marketTaskFileInput } from './market-task-file-input.ts'
import { marketInputLabelsZh, marketTaskStatusZh } from './market-task-copy.ts'
import { MarketTaskProgress } from './MarketTaskProgress.tsx'
import { LegalDocumentTargets, legalTargets } from './LegalDocumentTargets.tsx'
import { VideoCreativeBrief, type VideoCreativeAnswers } from './VideoCreativeBrief.tsx'
import { confirmVideoImageChoice, matchesReviewedVideoSelection,
  stageConfirmedVideoChoice, supportsReviewedFiveSecondVideoPlan, supportsVideoFirstFrameTask,
  videoMarketTaskRequest, type ConfirmedVideoCreativeChoice, type VideoImageChoice,
  type VideoMarketTaskRequest, type VideoStagedAsset } from './video-creative-handoff.ts'
import { zh as defaultProgressLabels, type MarketTaskProgressLabels } from './market-task-progress-locales.ts'
import { validVideoAssetPlan, videoAssetPlanInputIssue,
  type PrepareVideoAssetPlan, type VideoAssetPlan } from './video-asset-plan.ts'
import css from './OrderProductsPanel.module.css'

const defaultTransport = createMarketTaskTransport()
const MAX_AUTOMATIC_RESULT_READ_RETRIES = 3

interface VideoPlaybackState {
  workloadId: string
  reference: string
  attempt: number
  status: 'ready' | 'failed'
}

/** Keep the current video preview when an earlier attempt reports a late media event.
 * @param currentAttempt - Latest media read attempt for this card.
 * @param eventAttempt - Attempt that owns the media element reporting the event.
 * @param previous - Last preview state, if any.
 * @param event - Media result observed by that element.
 * @returns The prior state for a stale event or ready event after failure; otherwise the active state.
 */
export function videoPlaybackAfterEvent(currentAttempt: number, eventAttempt: number,
  previous: VideoPlaybackState | null,
  event: Pick<VideoPlaybackState, 'workloadId' | 'reference' | 'status'>): VideoPlaybackState | null {
  if (currentAttempt !== eventAttempt) return previous
  // A media error is terminal for this element. A queued canplay event cannot
  // clear it; the explicit retry mounts a new element under a new attempt.
  if (previous?.attempt === eventAttempt && previous.workloadId === event.workloadId
    && previous.reference === event.reference && previous.status === 'failed'
    && event.status === 'ready') return previous
  return { ...event, attempt: eventAttempt }
}

function requestActive(signal: AbortSignal): boolean {
  return !signal.aborted
}

function restoredVideoExpert(draft: MarketTaskDraft | undefined): boolean {
  return draft?.videoMode === 'expert' || (draft?.videoMode === undefined && draft?.videoExpert === true)
}

function typedParams(fields: MarketTaskParamField[], draft: Record<string, string | boolean>):
    Record<string, string | number | boolean> | null {
  const result: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const value = draft[field.name]
    if (field.type === 'boolean') {
      result[field.name] = value === true || value === 'true'
      continue
    }
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) { if (field.required) return null; continue }
    if (field.type === 'string') {
      if ((field.minLength !== undefined && raw.length < field.minLength)
        || (field.maxLength !== undefined && raw.length > field.maxLength)
        || (field.choices !== undefined && !field.choices.includes(raw))) return null
      result[field.name] = raw
      continue
    }
    const number = Number(raw)
    if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isSafeInteger(number))
      || (field.minimum !== undefined && number < field.minimum)
      || (field.maximum !== undefined && number > field.maximum)
      || (field.choices !== undefined && !field.choices.includes(number))) return null
    result[field.name] = number
  }
  return result
}

function inlineInput(contract: MarketTaskType | null, text: string, serialized = false): string | null {
  const goal = text
  const form = contract?.inlineForm
  const length = Array.from(goal).length
  if (!goal.trim() || length < (form?.minLength ?? 1)
    || length > (form?.maxLength ?? 8000)) return null
  if (form?.template && !serialized) {
    const { field, constants, minLength, maxLength } = form.template
    if (goal.length < minLength || goal.length > maxLength) return null
    return JSON.stringify({ ...constants, [field]: goal })
  }
  if (form?.mediaType === 'application/json') {
    if (new TextEncoder().encode(goal).byteLength > 16 * 1024) return null
    try {
      const parsed: unknown = JSON.parse(goal, (_key, value: unknown) => {
        if ((typeof value === 'number' && !Number.isFinite(value))
          || (typeof value === 'string' && !value.isWellFormed())) throw new Error('MARKET_INPUT_JSON_INVALID')
        return value
      })
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length === 0) return null
    } catch { return null }
  }
  return goal
}

function failureText(error: unknown, labels: MarketTaskProgressLabels): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'COMPUTE_TASK_PRICING_UNAVAILABLE') return '此能力尚未配置服务端执行价，暂不能报价。请等待提供方配置价目；当前未派单、未扣费。'
  if (code === 'COMPUTE_TASK_PRICING_INVALID') return '此能力的服务端价目无效，暂不能报价。请等待提供方修正价目；当前未派单、未扣费。'
  if (code === 'COMPUTE_INPUT_KIND_UNSUPPORTED') return '此能力需要其他输入形式，当前表单还不能提交。'
  if (code === 'COMPUTE_BALANCE_INSUFFICIENT' || code === 'COMPUTE_QUOTE_BALANCE_INSUFFICIENT') return '余额不足，请充值后重新报价。'
  if (['COMPUTE_QUOTE_EXPIRED', 'COMPUTE_QUOTE_CHANGED', 'COMPUTE_QUOTE_PLAN_CHANGED',
    'COMPUTE_QUOTE_ACCOUNT_CHANGED', 'COMPUTE_QUOTE_CONFIRMATION_INVALID'].includes(code)) return '报价已变化或过期，请重新报价。'
  if (code === 'COMPUTE_CAPABILITY_UNAVAILABLE') return '中央服务器尚未开放此任务合同。'
  if (code === 'COMPUTE_PRODUCT_SELECTION_CHANGED') return labels.selectedProductChanged
  if (code === 'COMPUTE_PRODUCT_SELECTION_UNSUPPORTED') return labels.selectedProductUnsupported
  if (code === 'COMPUTE_PLAN_NOT_APPROVED') return '本地任务草案尚未确认，请重新询价。'
  if (code === 'MARKET_TASK_INVALID_RESPONSE') return '任务回执与此能力不一致，请重新核对。'
  if (code === 'COMPUTE_SUBMISSION_UNKNOWN') return '提交状态待核查，请勿重复发单。'
  return '暂时无法完成，请检查连接后重试。'
}

/** Session-local references only; a restored paid submission may only be reconciled. */
export interface MarketTaskContinuation {
  planId: string | null
  workloadId: string | null
  submission: 'idle' | 'uncertain' | 'submitted'
  amountYuan?: string | undefined
  decision?: { decision: 'accept' | 'reject'; key: string } | undefined
  draft?: MarketTaskDraft | undefined
}

interface MarketTaskCallProps {
  capability: { taskType: string; capabilityId?: string; name: string; category: string }
  /** Exact listing selected by the buyer; Shanghai must echo it in the quote. */
  selectedProduct?: MarketProductSelection
  initialGoal?: string
  /** Displayed draft survives refresh; new quotes and paid dispatch require a fresh catalog. */
  catalogReady?: boolean
  draftOnly?: boolean
  /** Conversation-only @出视频 requests never launch an agent or a parameter form. */
  directVideoEntry?: boolean
  catalogStatus?: 'loading' | 'unavailable' | 'not-callable'
  /** Retry catalog metadata only; never submit or repeat an existing paid task. */
  refreshCatalog?: () => Promise<void>
  loadInputPresentation?: LoadMarketInputPresentation | undefined
  prepareVideoAssetPlan?: PrepareVideoAssetPlan | undefined
  transport?: MarketTaskTransport
  continuation?: MarketTaskContinuation
  onContinuation?: (next: MarketTaskContinuation) => void
  progressLabels?: MarketTaskProgressLabels
}

/** Render direct video requests as dialogue; existing market orders retain their paid lifecycle. */
export function MarketTaskCall(props: MarketTaskCallProps) {
  const video = props.capability.taskType === 'video_generate'
    || props.capability.capabilityId === 'video.render' && props.capability.category === 'video'
  const direct = video && props.selectedProduct === undefined && (props.directVideoEntry || props.draftOnly)
  const continuation = props.continuation
  if (direct && (continuation === undefined || continuation.submission === 'idle' && continuation.workloadId === null)) {
    const labels = props.progressLabels ?? defaultProgressLabels
    const draft = isMarketTaskDraft(continuation?.draft) ? continuation.draft : undefined
    return <div data-video-conversation>
      {draft !== undefined && draft.goal !== props.initialGoal && <p>{draft.goal}</p>}
      <p role="status">{labels.videoConversationUnavailable}</p>
    </div>
  }
  return <MarketTaskCallLifecycle {...props} />
}

function MarketTaskCallLifecycle({ capability, initialGoal = '', transport = defaultTransport,
  continuation, onContinuation, selectedProduct, catalogReady: catalogReadyProp = true,
  draftOnly = false, directVideoEntry = false, catalogStatus = 'loading', refreshCatalog,
  loadInputPresentation, prepareVideoAssetPlan,
  progressLabels = defaultProgressLabels }: MarketTaskCallProps) {
  const catalogReady = catalogReadyProp && !draftOnly
  const videoTask = capability.taskType === 'video_generate'
    || (capability.capabilityId === 'video.render'
      && (capability.category === 'video' || capability.category === 'creative'))
  const catalogState = useRef({ ready: catalogReady, epoch: 0 })
  if (catalogState.current.ready !== catalogReady) catalogState.current = {
    ready: catalogReady, epoch: catalogState.current.epoch + 1,
  }
  const continuationRef = useRef<MarketTaskContinuation>(continuation
    ?? { planId: null, workloadId: null, submission: 'idle' })
  const continuationWriter = useRef(onContinuation)
  continuationWriter.current = onContinuation
  // The Slot may replace this callback while publishing a continuation. Reloading
  // the contract for that callback change would restore an older mode from props.
  const inputPresentationLoader = useRef(loadInputPresentation)
  inputPresentationLoader.current = loadInputPresentation
  const remember = (change: Partial<MarketTaskContinuation>): void => {
    continuationRef.current = { ...continuationRef.current, ...change }
    continuationWriter.current?.(continuationRef.current)
  }
  const [contract, setContract] = useState<MarketTaskType | null>(null)
  const contracts = useRef<MarketTaskType[]>([])
  const [loading, setLoading] = useState(true)
  const [legacyAdvanced, setLegacyAdvanced] = useState(false)
  const savedDraft = isMarketTaskDraft(continuationRef.current.draft) ? continuationRef.current.draft : undefined
  const [goal, setGoal] = useState(savedDraft?.goal ?? initialGoal)
  const [inputDraft, setInputDraft] = useState<MarketInputDraft>(savedDraft?.input ?? {})
  const [paramDraft, setParamDraft] = useState<Record<string, string | boolean>>(savedDraft?.params ?? {})
  const [inputFiles, setInputFiles] = useState<MarketInputFile[]>([...(savedDraft?.files ?? [])])
  const [inputMode, setInputMode] = useState<MarketTaskDraft['inputMode']>(savedDraft?.inputMode
    ?? (savedDraft?.files?.length ? 'files' : undefined))
  const [videoAnswers, setVideoAnswers] = useState<VideoCreativeAnswers>(savedDraft?.videoAnswers
    ?? { subject: '', motion: '', style: '' })
  const [videoExpert, setVideoExpert] = useState(restoredVideoExpert(savedDraft))
  const [videoConfirmation, setVideoConfirmation] = useState<ConfirmedVideoCreativeChoice | null>(null)
  const [videoStaged, setVideoStaged] = useState<VideoStagedAsset | null>(null)
  const [legacyTextMode, setLegacyTextMode] = useState(false)
  const [videoBusy, setVideoBusy] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const [videoContractMismatch, setVideoContractMismatch] = useState(false)
  const videoUpload = useRef<AbortController | null>(null)
  const videoPlanGeneration = useRef(0)
  const [videoAssetPlan, setVideoAssetPlan] = useState<VideoAssetPlan | null>(null)
  const [videoAssetPrompt, setVideoAssetPrompt] = useState('')
  const [videoAssetConfirmed, setVideoAssetConfirmed] = useState(false)
  const [videoAssetBusy, setVideoAssetBusy] = useState(false)
  const [videoAssetError, setVideoAssetError] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(false)
  const uploadLifetime = useRef<AbortController | null>(null)
  const [phase, setPhase] = useState<'idle' | 'quoting' | 'quoted' | 'submitting' | 'submitted' | 'uncertain'>(
    continuationRef.current.workloadId !== null ? 'submitted' : continuationRef.current.submission)
  const [quote, setQuote] = useState<MarketTaskQuote | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [workloadId, setWorkloadId] = useState<string | null>(continuationRef.current.workloadId)
  const [workload, setWorkload] = useState<MarketTaskWorkload | null>(null)
  const [result, setResult] = useState<MarketTaskResult | null>(null)
  const [resultError, setResultError] = useState(false)
  const [videoPlayback, setVideoPlayback] = useState<VideoPlaybackState | null>(null)
  const [videoReadAttempt, setVideoReadAttempt] = useState(0)
  const videoReadEpoch = useRef(0)
  const [progressError, setProgressError] = useState(false)
  const [acceptance, setAcceptance] = useState<MarketTaskAcceptance | null>(null)
  const [acceptanceError, setAcceptanceError] = useState(false)
  const [decisionPending, setDecisionPending] = useState(false)
  const [decisionError, setDecisionError] = useState(false)
  const decisionAttempt = useRef<{ decision: 'accept' | 'reject'; key: string } | null>(continuationRef.current.decision ?? null)
  const [resultRefresh, setResultRefresh] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const planId = useRef<string | null>(continuationRef.current.planId)
  const active = useRef<AbortController | null>(null)
  const autoQuoted = useRef(false)
  const videoAutoQuotePending = useRef(false)
  const invalidateQuote = (change: Partial<MarketTaskDraft> = {}): void => {
    active.current?.abort()
    active.current = null
    setQuote(null)
    planId.current = null
    const draft = { goal, input: inputDraft, params: paramDraft,
      ...(videoTask ? { videoAnswers, videoExpert } : {}),
      ...(inputFiles.length ? { files: inputFiles } : {}),
      ...(inputMode === undefined ? {} : { inputMode }), ...change }
    remember({ planId: null, workloadId: null, submission: 'idle', amountYuan: undefined, decision: undefined,
      draft: isMarketTaskDraft(draft) ? draft : undefined })
    setPhase('idle')
  }
  const invalidateVideoAssetPlan = (): void => {
    videoPlanGeneration.current += 1
    setVideoAssetPlan(null); setVideoAssetPrompt(''); setVideoAssetConfirmed(false)
    setVideoAssetBusy(false); setVideoAssetError(false)
  }

  useEffect(() => {
    const abort = new AbortController()
    setContract(null)
    contracts.current = []
    setLoading(true)
    setLegacyAdvanced(false)
    uploadLifetime.current?.abort(); setUploading(false); setUploadError(false)
    videoUpload.current?.abort(); setVideoBusy(false); setVideoError(false); setVideoContractMismatch(false)
    invalidateVideoAssetPlan()
    videoAutoQuotePending.current = false
    setVideoConfirmation(null); setVideoStaged(null); setLegacyTextMode(false)
    continuationRef.current = continuation ?? { planId: null, workloadId: null, submission: 'idle' }
    const resumed = continuationRef.current
    const restoredDraft = isMarketTaskDraft(resumed.draft) ? resumed.draft : undefined
    setInputFiles([...(restoredDraft?.files ?? [])])
    setInputMode(restoredDraft?.inputMode ?? (restoredDraft?.files?.length ? 'files' : undefined))
    setVideoAnswers(restoredDraft?.videoAnswers ?? { subject: '', motion: '', style: '' })
    setVideoExpert(restoredVideoExpert(restoredDraft))
    setGoal(restoredDraft?.goal ?? initialGoal)
    setPhase(resumed.workloadId !== null ? 'submitted' : resumed.submission)
    setQuote(null)
    setMessage(resumed.submission === 'uncertain' ? '提交状态待核查，请勿重复发单。' : null)
    setWorkloadId(resumed.workloadId)
    setWorkload(null)
    setResult(null)
    setResultError(false)
    setProgressError(false)
    setAcceptance(null)
    setAcceptanceError(false)
    setDecisionError(false)
    decisionAttempt.current = resumed.decision ?? null
    // An idle view obtains a fresh quote for its restored controls. Paid attempts only reconcile.
    planId.current = resumed.submission === 'idle' ? null : resumed.planId
    if (resumed.submission === 'idle' && resumed.planId !== null) remember({ planId: null, amountYuan: undefined })
    autoQuoted.current = resumed.submission !== 'idle' || resumed.workloadId !== null
    void transport.taskTypes(abort.signal).then(async (rows) => {
      if (!requestActive(abort.signal)) return
      contracts.current = rows
      const aliases = rows.filter(row => row.capabilityId === capability.taskType)
      let matched = rows.find(row => row.taskType === capability.taskType)
        ?? (aliases.length === 1 ? aliases.at(0) ?? null : null)
      const legacy = matched?.inlineForm
      if (matched && legacy?.mediaType === 'application/json' && !legacy.structuredDeclared
        && !legacy.structured && !legacy.template && inputPresentationLoader.current) {
        const presentation = await inputPresentationLoader.current(matched.taskType, abort.signal).catch(() => null)
        if (!requestActive(abort.signal)) return
        if (presentation) matched = { ...matched, inlineForm: { ...legacy,
          structured: presentation.rule, presentationFixed: presentation.fixed } }
      }
      setContract(matched)
      if (matched?.inlineForm?.structured) {
        let initial: unknown = restoredDraft?.input
        if (initial === undefined) {
          try { initial = JSON.parse(initialGoal) as unknown } catch {
            if (matched.inlineForm.template) initial = { [matched.inlineForm.template.field]: initialGoal }
            else if (matched.inlineForm.presentationFixed !== undefined) {
              const key = Object.keys(matched.inlineForm.structured.properties ?? {})[0]
              if (key) initial = { [key]: initialGoal }
            }
          }
        }
        setInputDraft(marketInputDraft(matched.inlineForm.structured, initial))
      }
      const fixedFiveSeconds = matched !== null && videoTask
        && supportsReviewedFiveSecondVideoPlan(matched)
      setParamDraft(Object.fromEntries((matched?.paramFields ?? []).map(field => [field.name,
        fixedFiveSeconds && (field.name === 'frames' || field.name === 'fps')
          ? String(field.minimum)
          : restoredDraft?.params[field.name] ?? (field.defaultValue === undefined ? (field.type === 'boolean' ? false
            : field.choices?.length === 1 ? String(field.choices[0]) : '')
            : (field.type === 'boolean' ? field.defaultValue === true : String(field.defaultValue)))])))
      setLoading(false)
    }).catch(() => {
      if (requestActive(abort.signal)) { setLoading(false); setMessage('暂时无法读取中央服务器的任务合同。') }
    })
    return () => { abort.abort(); active.current?.abort(); active.current = null
      uploadLifetime.current?.abort(); videoUpload.current?.abort(); videoPlanGeneration.current += 1 }
  }, [capability.taskType, transport])

  useEffect(() => {
    if (quote === null || phase !== 'quoted') return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [quote, phase])

  useEffect(() => {
    if (workloadId === null) return
    const abort = new AbortController()
    let timer: number | undefined
    let resultReadRetries = 0
    videoReadEpoch.current += 1
    setVideoReadAttempt(videoReadEpoch.current)
    setVideoPlayback(null)
    setResult(null); setResultError(false)
    const retryResultRead = (): void => {
      if (!requestActive(abort.signal)) return
      setResult(null); setResultError(true)
      if (resultReadRetries < MAX_AUTOMATIC_RESULT_READ_RETRIES) {
        resultReadRetries += 1
        timer = window.setTimeout(() => { void refresh() }, 5_000)
      }
    }
    const refresh = async (): Promise<void> => {
      if (!requestActive(abort.signal)) return
      let next: MarketTaskWorkload
      try {
        next = await transport.readWorkload(workloadId, abort.signal)
        if (!requestActive(abort.signal)) return
        setWorkload(next)
        setProgressError(false)
      } catch {
        if (requestActive(abort.signal)) {
          setProgressError(true)
          timer = window.setTimeout(() => { void refresh() }, 5_000)
        }
        return
      }
      try {
        if (next.status === 'DONE') {
          if (!next.resultAvailable) {
            setResult(null); setResultError(false)
            timer = window.setTimeout(() => { void refresh() }, 5_000)
            return
          }
          const delivered = await transport.readResult(workloadId, abort.signal)
          if (requestActive(abort.signal)) {
            if (delivered.id !== workloadId || delivered.status !== 'DONE') {
              retryResultRead()
            } else {
              setResult(delivered); setResultError(false)
            }
          }
          return
        }
        if (next.status === 'QUARANTINED' || next.status === 'FAILED') {
          try {
            const review = await transport.readAcceptance(workloadId, abort.signal)
            if (requestActive(abort.signal)) {
              if (review?.status === 'pending_buyer' && review.workloadStatus !== next.status) {
                setAcceptance(null); setAcceptanceError(true)
                timer = window.setTimeout(() => { void refresh() }, 5_000)
                return
              }
              setAcceptanceError(false)
              setAcceptance(previous => previous?.status === 'accepted' || previous?.status === 'rejected'
                ? previous : review)
              // A just-recorded decision may precede a replica's GET response. Keep polling
              // the workload until Shanghai marks settlement DONE, even if GET is stale.
              if ((next.status === 'QUARANTINED' && review === null)
                || review?.status === 'accepted' || decisionAttempt.current?.decision === 'accept') {
                timer = window.setTimeout(() => { void refresh() }, 5_000)
              }
            }
          } catch {
            if (requestActive(abort.signal)) setAcceptanceError(true)
          }
          return
        }
        if (next.status === 'CANCELLED' || next.status === 'CANCELED') return
        timer = window.setTimeout(() => { void refresh() }, 5_000)
      } catch {
        retryResultRead()
      }
    }
    void refresh()
    return () => { abort.abort(); if (timer !== undefined) window.clearTimeout(timer) }
  }, [workloadId, transport, resultRefresh])

  const isLegalBundle = contract?.taskType === 'legal_doc_bundle_v1'
  const fileInput = contract === null ? null : marketTaskFileInput(contract.taskType)
  const targets = legalTargets(paramDraft.document_plan)
  const legalComplete = !isLegalBundle || targets.every(item => item.title.trim() && item.purpose.trim())
  const params = typedParams(contract?.paramFields ?? [], isLegalBundle
    ? { ...paramDraft, document_plan: JSON.stringify(targets) } : paramDraft)
  const videoSupported = contract !== null && supportsVideoFirstFrameTask(contract)
    && transport.uploadInputFile !== undefined
  const fixedVideoDurationSeconds = contract !== null && supportsReviewedFiveSecondVideoPlan(contract)
    ? 5 : null
  const guidedVideo = videoTask && !legacyTextMode
  const videoParams = typedParams((contract?.paramFields ?? []).filter(field => field.name !== 'prompt'), paramDraft)
  let videoRequest: VideoMarketTaskRequest | null = null
  if (guidedVideo && videoSupported && fixedVideoDurationSeconds === 5 && videoConfirmation !== null
    && videoStaged !== null && videoParams !== null) {
    try { videoRequest = videoMarketTaskRequest(contract, videoConfirmation, videoStaged, videoParams) }
    catch { /* A changed signed form or incomplete parameter leaves quoting closed. */ }
  }
  const structuredInput = contract?.inlineForm?.structured
    ? serializeMarketInput(contract.inlineForm.structured, inputDraft, contract.inlineForm.maxLength)
    : null
  const preparedInput = contract?.inlineForm?.structured
    ? structuredInput === null ? null : inlineInput(contract,
      contract.inlineForm.presentationFixed === undefined ? structuredInput
        : JSON.stringify({ ...contract.inlineForm.presentationFixed, ...JSON.parse(structuredInput) as object }), true)
    : inlineInput(contract, goal)
  const usesFiles = !legacyTextMode && contract?.canQuoteFiles === true && (!contract.canQuoteInline
    || inputMode === 'files' || (inputMode === undefined && inputFiles.length > 0))
  const changeInputMode = (next: 'inline' | 'files'): void => {
    if (legacyTextMode || !contract?.canQuoteInline || !contract.canQuoteFiles || uploading
      || phase === 'submitting' || phase === 'uncertain' || phase === 'submitted'
      || (next === 'files') === usesFiles) return
    setInputMode(next)
    setMessage(null)
    invalidateQuote({ inputMode: next })
  }
  const rawJson = contract?.inlineForm?.mediaType === 'application/json'
    && contract.inlineForm.structured === undefined && contract.inlineForm.template === undefined
    && contract.inlineForm.structuredDeclared !== true
  const formReady = usesFiles || contract?.inlineForm?.mediaType !== 'application/json'
    || contract.inlineForm.structured !== undefined || contract.inlineForm.template !== undefined || rawJson
  const canQuote = catalogReady && (guidedVideo ? videoRequest !== null
    : (usesFiles ? inputFiles.length > 0 && !uploading : contract?.canQuoteInline === true)
    && formReady && legalComplete && params !== null && (usesFiles || preparedInput !== null)
    && (usesFiles || !rawJson || loadInputPresentation === undefined || legacyAdvanced)
    && (!usesFiles || fileInput === null || inputFiles.every(file => fileInput.supports(file.filename))))
  const uploadInputs = (files: FileList | null): void => {
    if (!files || !transport.uploadInputFile || files.length < 1 || files.length + inputFiles.length > 15
      || Array.from(files).reduce((sum, item) => sum + item.size, inputFiles.reduce((sum, item) => sum + item.bytes, 0)) > 16 * 1024 * 1024
      || (fileInput !== null && Array.from(files).some(file => !fileInput.supports(file.name)))) {
      setUploadError(true); return
    }
    invalidateQuote()
    const abort = new AbortController(); uploadLifetime.current?.abort(); uploadLifetime.current = abort
    setUploading(true); setUploadError(false)
    const upload = transport.uploadInputFile
    void (async () => {
      const completed: MarketInputFile[] = []
      for (const file of Array.from(files)) {
        abort.signal.throwIfAborted()
        completed.push(await upload(file, abort.signal))
      }
      if (!abort.signal.aborted) {
        const next = [...inputFiles, ...completed]
        setInputFiles(next); invalidateQuote({ files: next }); setUploading(false)
      }
    })().catch(() => { if (!abort.signal.aborted) { setUploading(false); setUploadError(true) } })
  }
  const quoteExpired = quote !== null && now >= Date.parse(quote.expiresAt) - 10_000
  const requestQuote = (): void => {
    if (contract === null || !canQuote || phase === 'quoting' || phase === 'submitting' || phase === 'uncertain' || phase === 'submitted') return
    if (guidedVideo) videoAutoQuotePending.current = false
    const abort = new AbortController()
    active.current?.abort()
    active.current = abort
    setPhase('quoting')
    setMessage(null)
    const catalogEpoch = catalogState.current.epoch
    const quoteRequestCurrent = (): boolean => {
      if (!requestActive(abort.signal)) return false
      if (catalogState.current.ready && catalogState.current.epoch === catalogEpoch) return true
      autoQuoted.current = false
      planId.current = null
      remember({ planId: null, amountYuan: undefined })
      setQuote(null); setPhase('idle')
      return false
    }
    void (async () => {
      let request = videoRequest
      if (guidedVideo) {
        const rows = await transport.taskTypes(abort.signal)
        const current = rows.find(row => row.taskType === capability.taskType) ?? null
        if (!quoteRequestCurrent()) return
        setContract(current)
        if (current === null || !supportsReviewedFiveSecondVideoPlan(current)
          || videoConfirmation === null || videoStaged === null || videoParams === null) {
          throw new Error('VIDEO_CREATIVE_INPUT_INVALID')
        }
        const expected = videoConfirmation.expectedVideoReview
        if (expected !== null && !matchesReviewedVideoSelection(current, expected)) {
          throw new Error('VIDEO_CREATIVE_CONTRACT_CHANGED')
        }
        request = videoMarketTaskRequest(current, videoConfirmation, videoStaged, videoParams)
      }
      const id = guidedVideo && request !== null
        ? await (selectedProduct === undefined
          ? transport.createPlan(request.taskType, request.goal, abort.signal, { ...request.params },
            request.files, request.expectedVideoReview)
          : transport.createPlan(request.taskType, request.goal, abort.signal, { ...request.params },
            request.files, request.expectedVideoReview, selectedProduct))
        : planId.current ?? await (usesFiles
          ? selectedProduct === undefined
            ? transport.createPlan(capability.taskType, preparedInput ?? capability.name, abort.signal, params ?? undefined, inputFiles)
            : transport.createPlan(capability.taskType, preparedInput ?? capability.name, abort.signal, params ?? undefined,
              inputFiles, undefined, selectedProduct)
          : selectedProduct === undefined
            ? transport.createPlan(capability.taskType, preparedInput ?? capability.name, abort.signal, params ?? undefined)
            : transport.createPlan(capability.taskType, preparedInput ?? capability.name, abort.signal, params ?? undefined,
              undefined, undefined, selectedProduct))
      if (!quoteRequestCurrent()) return
      planId.current = id
      const draft = { goal, input: inputDraft, params: paramDraft,
        ...(videoTask ? { videoAnswers, videoExpert } : {}),
        ...(inputFiles.length ? { files: inputFiles } : {}),
        ...(inputMode === undefined ? {} : { inputMode }) }
      remember({ planId: id, workloadId: null, submission: 'idle',
        draft: isMarketTaskDraft(draft) ? draft : undefined })
      const priced = await transport.quotePlan(id, abort.signal, capability.taskType)
      if (!quoteRequestCurrent()) return
      const landing = contracts.current.find(row => row.taskType === priced.taskType)
      const original = contract.capabilityId ?? capability.taskType
      const mapped = landing?.capabilityId ?? landing?.taskType
      if (priced.planId !== id || (priced.capabilityId !== undefined && priced.capabilityId !== capability.taskType)
        || mapped !== original || (priced.taskType !== capability.taskType && priced.capabilityId === undefined)) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      if (requestActive(abort.signal)) {
        remember({ amountYuan: priced.amountYuan })
        setNow(Date.now()); setQuote(priced); setPhase('quoted')
      }
    })().catch((error: unknown) => {
      if (requestActive(abort.signal)) {
        setPhase('idle')
        setMessage(error instanceof Error && error.message === 'VIDEO_CREATIVE_CONTRACT_CHANGED'
          ? progressLabels.videoCreativeContractMismatch
          : error instanceof Error && error.message === 'VIDEO_CREATIVE_INPUT_INVALID'
            ? progressLabels.videoCreativeUnsupported : failureText(error, progressLabels))
      }
    })
  }
  useEffect(() => {
    if (videoTask || selectedProduct !== undefined || !catalogReady || autoQuoted.current || !initialGoal.trim() || !canQuote) return
    autoQuoted.current = true
    requestQuote()
  }, [contract, initialGoal, catalogReady, videoTask])
  useEffect(() => {
    if (!guidedVideo || !videoAutoQuotePending.current || videoStaged === null
      || !canQuote || phase !== 'idle') return
    // One free quote per approved creative choice. Catalog changes and quote failures
    // leave the manual retry button available, but cannot start another request.
    videoAutoQuotePending.current = false
    requestQuote()
  }, [guidedVideo, videoStaged, canQuote, phase])
  const dispatch = (): void => {
    if (!catalogReady || (guidedVideo && videoRequest === null) || quote === null || planId.current === null
      || quoteExpired || !quote.balanceEnough || phase !== 'quoted') return
    const abort = new AbortController()
    active.current?.abort()
    active.current = abort
    setPhase('submitting')
    setMessage(null)
    // Persist uncertainty before the paid POST so unmounts and restarts cannot replay it.
    remember({ planId: planId.current, submission: 'uncertain', amountYuan: quote.amountYuan })
    void transport.confirmAndPublish(planId.current, quote.quoteId, abort.signal).then((id) => {
      remember({ workloadId: id, submission: 'submitted' })
      if (requestActive(abort.signal)) { setWorkloadId(id); setPhase('submitted') }
    }).catch((error: unknown) => {
      if (!requestActive(abort.signal)) return
      if (guidedVideo && error instanceof Error && ['COMPUTE_VIDEO_REVIEW_CHANGED',
        'COMPUTE_VIDEO_MIXED_INPUT_INVALID', 'COMPUTE_VIDEO_REVIEW_UNEXPECTED'].includes(error.message)) {
        // Host rejected before recording a paid submission. Preserve the brief,
        // but require a new creative confirmation and a new quote/plan.
        invalidateQuote()
        setVideoConfirmation(null); setVideoStaged(null); setVideoContractMismatch(true)
        setMessage(null)
        return
      }
      setPhase('uncertain'); setMessage(failureText(error, progressLabels))
    })
  }
  const check = (): void => {
    if (planId.current === null) return
    const abort = new AbortController()
    active.current?.abort()
    active.current = abort
    void transport.findWorkload(planId.current, abort.signal).then((id) => {
      if (id !== null) remember({ workloadId: id, submission: 'submitted' })
      if (!requestActive(abort.signal)) return
      if (id === null) setMessage('尚未查到任务回执，请稍后核查；当前不会重复发单。')
      else { setWorkloadId(id); setPhase('submitted'); setMessage(null) }
    }).catch(() => { if (requestActive(abort.signal)) setMessage('暂时无法核查任务回执，请稍后再试。') })
  }
  const pendingBuyerAcceptance = workload?.status === 'QUARANTINED'
    && acceptance?.status === 'pending_buyer' && acceptance.workloadStatus === workload.status
    && !acceptanceError ? acceptance : null
  const decide = (decision: 'accept' | 'reject'): void => {
    if (workloadId === null || pendingBuyerAcceptance === null || decisionPending
      || decision === 'accept' && videoTask
      || (decisionAttempt.current !== null && decisionAttempt.current.decision !== decision)) return
    const previous = decisionAttempt.current
    const key = previous?.key ?? globalThis.crypto.randomUUID()
    decisionAttempt.current = { decision, key }
    remember({ decision: { decision, key } })
    const abort = new AbortController()
    setDecisionPending(true); setDecisionError(false)
    void transport.decideAcceptance(workloadId, decision, key, abort.signal).then((next) => {
      setAcceptance(next); setDecisionPending(false)
      setResultRefresh(value => value + 1)
    }).catch(() => {
      setDecisionPending(false); setDecisionError(true)
    })
  }
  const resultReference = result?.artifactRef ?? null
  const deliveredMedia = resultReference === null || workloadId === null ? null
    : marketResultMedia(resultReference, workloadId, window.location)
  const deliveredFile = resultReference === null || workloadId === null ? null
    : marketResultFile(resultReference, workloadId, window.location)
  const videoPlaybackStatus = deliveredMedia?.kind === 'video' && resultReference !== null
    && videoPlayback?.workloadId === workloadId
    && videoPlayback.reference === resultReference && videoPlayback.attempt === videoReadAttempt
    ? videoPlayback.status : 'pending'
  const missingVideoResult = videoTask && workload?.status === 'DONE' && result !== null
    && (deliveredMedia?.kind !== 'video' || !deliveredMedia.filename.endsWith('.mp4'))
  const unsupportedArtifact = result !== null && result.inlineOutput === null && result.artifactRef !== null
    && deliveredMedia === null && deliveredFile === null
  const resetVideoCreative = (): void => {
    videoUpload.current?.abort()
    videoUpload.current = null
    videoAutoQuotePending.current = false
    setVideoConfirmation(null); setVideoStaged(null); setVideoBusy(false); setVideoError(false)
    setVideoContractMismatch(false)
  }
  const prepareVideoPlan = (choice: VideoImageChoice | null): void => {
    if (prepareVideoAssetPlan === undefined || !goal.trim()) return
    if (videoAssetPlanInputIssue({ sourceGoal: goal.trim(), answers: videoAnswers }) !== null) return
    resetVideoCreative()
    invalidateQuote()
    const generation = ++videoPlanGeneration.current
    const sourceGoal = goal.trim()
    setVideoAssetPlan(null); setVideoAssetPrompt(''); setVideoAssetConfirmed(false)
    setVideoAssetBusy(true); setVideoAssetError(false)
    void prepareVideoAssetPlan({ sourceGoal, answers: videoAnswers,
      ...(choice === null ? {} : { selectedFirstFrame: {
        mimeType: choice.mimeType, bytes: choice.bytes, sha256: choice.sha256 } }) })
      .then((plan) => {
        if (videoPlanGeneration.current !== generation) return
        if (!validVideoAssetPlan(plan, sourceGoal, choice)) throw new Error('VIDEO_ASSET_PLAN_INVALID')
        setVideoAssetPlan(plan); setVideoAssetPrompt(plan.prompt)
      }).catch(() => { if (videoPlanGeneration.current === generation) setVideoAssetError(true) })
      .finally(() => { if (videoPlanGeneration.current === generation) setVideoAssetBusy(false) })
  }
  const confirmVideoCreative = (choice: VideoImageChoice, prompt: string): void => {
    if (fixedVideoDurationSeconds !== 5) { setVideoContractMismatch(true); return }
    if (prepareVideoAssetPlan !== undefined && (!videoAssetConfirmed || videoAssetPlan === null
      || prompt !== videoAssetPrompt || !validVideoAssetPlan(videoAssetPlan, goal.trim(), choice))) {
      setVideoAssetError(true); return
    }
    let confirmed: ConfirmedVideoCreativeChoice
    try { confirmed = confirmVideoImageChoice([choice], choice.id, prompt, contract ?? undefined) }
    catch { setVideoError(true); return }
    resetVideoCreative()
    invalidateQuote()
    setVideoConfirmation(confirmed)
    videoAutoQuotePending.current = true
    const upload = transport.uploadInputFile
    if (!catalogReady || upload === undefined) return
    const abort = new AbortController()
    videoUpload.current = abort
    setVideoBusy(true)
    void (async () => {
      const rows = await transport.taskTypes(abort.signal)
      if (abort.signal.aborted) return null
      const current = rows.find(row => row.taskType === capability.taskType) ?? null
      setContract(current)
      const review = current?.reviewedVideoInput
      const expected = confirmed.expectedVideoReview
      if (current === null || !supportsReviewedFiveSecondVideoPlan(current)
        || review === undefined || expected === null
        || !matchesReviewedVideoSelection(current, expected)
        || !supportsVideoFirstFrameTask(current, choice.mimeType)
        || choice.bytes > review.maxBytes
        || new TextEncoder().encode(prompt).byteLength > review.maxPromptUtf8Bytes) {
        setVideoContractMismatch(true)
        return null
      }
      return stageConfirmedVideoChoice(confirmed, upload, abort.signal)
    })().then((asset) => {
      if (asset === null) return
      if (!abort.signal.aborted) setVideoStaged(asset)
    }).catch(() => { if (!abort.signal.aborted) setVideoError(true) }).finally(() => {
      if (videoUpload.current === abort) { videoUpload.current = null; setVideoBusy(false) }
    })
  }

  return <div className={css.call} data-market-task-call>
    <strong>{capability.name} · 单次调用</strong>
    {selectedProduct !== undefined && phase !== 'submitted' && <p role="status">
      {progressLabels.selectedProductVersionCheck}
    </p>}
    {phase !== 'submitted' && <p>{draftOnly ? progressLabels.videoCreativeDraftOnly
      : '先看本次人民币报价，确认后由中央服务器调度。若需单独购买能力，市场会提前说明。'}</p>}
    {!catalogReady && phase !== 'submitted' && <div>
      <p role="status">{catalogStatus === 'unavailable' ? progressLabels.taskCatalogUnavailable
        : catalogStatus === 'not-callable' ? progressLabels.taskCatalogNotCallable : progressLabels.taskCatalogUpdating}</p>
      {catalogStatus === 'unavailable' && refreshCatalog !== undefined
        && <button type="button" onClick={() => { void refreshCatalog() }}>{progressLabels.taskCatalogRetry}</button>}
    </div>}
    {loading && <span role="status">正在核对任务合同…</span>}
    {!loading && contract === null && message === null && <p role="status">中央服务器尚未开放此任务合同，当前不能发单。</p>}
    {videoTask && legacyTextMode && phase !== 'submitted' && <div role="status">
      <p>{progressLabels.videoLegacyActive}</p>
      <button type="button" disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
        onClick={() => { setLegacyTextMode(false); invalidateQuote() }}>{progressLabels.videoLegacyBack}</button>
    </div>}
    {guidedVideo && !directVideoEntry && !draftOnly && phase !== 'submitted' && !loading && contract !== null && !videoSupported && contract.canQuoteInline
      && <div role="status"><p>{progressLabels.videoLegacyExplain}</p>
        <button type="button" disabled={!catalogReady || phase === 'quoting' || phase === 'submitting'
          || phase === 'uncertain'} onClick={() => {
          resetVideoCreative(); setInputMode('inline'); setLegacyTextMode(true)
          invalidateQuote({ inputMode: 'inline' })
        }}>{progressLabels.videoLegacyContinue}</button></div>}
    {!guidedVideo && !loading && contract !== null && !contract.canQuoteInline && !usesFiles && <p role="status">
      {contract.requiredParams.length > 0
        ? `此能力还需要参数：${contract.requiredParams.join('、')}；平台尚未提供可填写的参数合同。`
        : `此能力需要${contract.acceptedInputKinds.join('、')}输入；当前仅支持文字输入。`}
      暂不能在这里发单。
    </p>}
    {!guidedVideo && !loading && contract?.canQuoteInline === true && !formReady && phase !== 'submitted'
      && <p role="status">此技能正在补充使用表单，暂不能直接调用。</p>}
    {!videoTask && !loading && contract?.canQuoteInline === true && contract.canQuoteFiles === true && phase !== 'submitted'
      && <div role="group" aria-label={progressLabels.taskInputMode}>
        <button type="button" aria-pressed={!usesFiles}
          disabled={uploading || phase === 'submitting' || phase === 'uncertain'}
          onClick={() => { changeInputMode('inline') }}>{progressLabels.taskInputModeText}</button>
        <button type="button" aria-pressed={usesFiles}
          disabled={uploading || phase === 'submitting' || phase === 'uncertain'}
          onClick={() => { changeInputMode('files') }}>{progressLabels.taskInputModeFiles}</button>
      </div>}
    {!guidedVideo && !loading && (contract?.canQuoteInline === true || usesFiles) && formReady && phase !== 'submitted' && <>
      {usesFiles && <fieldset disabled={uploading || phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}>
        <legend>{progressLabels.taskInputAttachments}</legend>
        <input type="file" multiple accept={fileInput?.accept}
          aria-label={progressLabels.taskInputAttachments} onChange={(event) => {
            uploadInputs(event.currentTarget.files); event.currentTarget.value = ''
          }} disabled={transport.uploadInputFile === undefined} />
        <p>{fileInput?.hint ?? progressLabels.taskInputAttachmentHint}</p>
        {fileInput !== null && inputFiles.some(file => !fileInput.supports(file.filename))
          && <p role="alert">材料格式不适合这个能力，请移除并上传所需文件。</p>}
        {inputFiles.map(file => <p key={file.objectKey}>{file.filename} <button type="button" onClick={() => {
          const next = inputFiles.filter(item => item.objectKey !== file.objectKey)
          setInputFiles(next); invalidateQuote({ files: next })
        }}>{progressLabels.taskInputRemove}</button></p>)}
      </fieldset>}
      {uploading && <p role="status">{progressLabels.taskInputUploading}</p>}
      {uploadError && <p role="alert">{progressLabels.taskInputUploadFailed}</p>}
      {!usesFiles && rawJson && loadInputPresentation !== undefined && <details
        onToggle={(event) => { setLegacyAdvanced(event.currentTarget.open) }}>
        <summary>高级输入</summary>
        <p>这个旧版本尚未提供便捷表单。熟悉技能输入格式时，可展开填写；不会自动发单或扣费。</p>
      </details>}
      {!usesFiles && (!rawJson || loadInputPresentation === undefined || legacyAdvanced)
        && (contract.inlineForm?.structured ? <MarketInputFields rule={contract.inlineForm.structured}
          value={inputDraft} labels={marketInputLabelsZh}
          disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
          onChange={(next) => { setInputDraft(next); invalidateQuote({ input: next }) }} /> :
          <label>{contract.inlineForm?.template?.title ?? contract.inlineForm?.title
        ?? (capability.category === 'image' ? '想画什么？' : '描述要完成的事')}
          <textarea value={goal} maxLength={contract.inlineForm?.template?.maxLength ?? contract.inlineForm?.maxLength ?? 8000} rows={3}
            disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
            onChange={(event) => { setGoal(event.currentTarget.value); invalidateQuote({ goal: event.currentTarget.value }) }}
            placeholder={rawJson ? progressLabels.taskRawJsonPlaceholder
              : capability.category === 'image' ? '例如：一只在月光下读书的橘猫，温暖的手绘风格…'
                : '粘贴要处理的内容'} /></label>)}
      {!usesFiles && rawJson && (loadInputPresentation === undefined || legacyAdvanced) && <p>{progressLabels.taskRawJsonHint}</p>}
      {!usesFiles && rawJson && (loadInputPresentation === undefined || legacyAdvanced) && goal.trim() && preparedInput === null
        && <p role="alert">{progressLabels.taskRawJsonInvalid}</p>}
      {isLegalBundle && <LegalDocumentTargets value={targets} labels={progressLabels}
        disabled={uploading || phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
        onChange={(value) => { const next = { ...paramDraft, document_plan: JSON.stringify(value) }
          setParamDraft(next); invalidateQuote({ params: next }) }} />}
      {(contract.paramFields ?? []).filter(field => !(isLegalBundle && field.name === 'document_plan')).map(field => <label key={field.name}>{field.title}
        {field.type === 'boolean' ? <input type="checkbox" checked={paramDraft[field.name] === true}
          disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
          onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.checked }; setParamDraft(next)
            invalidateQuote({ params: next }) }} />
          : field.choices !== undefined ? <select value={String(paramDraft[field.name] ?? '')}
            disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
            onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.value }; setParamDraft(next)
              invalidateQuote({ params: next }) }}>
            {!field.required && <option value="">不指定</option>}
            {field.required && paramDraft[field.name] === '' && <option value="">请选择</option>}
            {field.choices.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
          </select> : <input type={field.type === 'string' ? 'text' : 'number'}
            value={String(paramDraft[field.name] ?? '')} required={field.required}
            min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength}
            step={field.type === 'integer' ? 1 : 'any'}
            disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
            onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.value }; setParamDraft(next)
              invalidateQuote({ params: next }) }} />}
      </label>)}
      {phase !== 'uncertain' && <button type="button" disabled={!canQuote || phase === 'quoting' || phase === 'submitting'}
        onClick={requestQuote}>{phase === 'quoting' ? '正在向中央服务器询价…' : quote === null || quoteExpired ? '查看单次报价' : '重新报价'}</button>}
    </>}
    {guidedVideo && !directVideoEntry && phase !== 'submitted' && <>
      <VideoCreativeBrief goal={goal} answers={videoAnswers} approved={videoConfirmation !== null}
        canConfirm={catalogReady && videoSupported && fixedVideoDurationSeconds === 5} expert={videoExpert}
        fixedDurationSeconds={fixedVideoDurationSeconds}
        busy={videoBusy || phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
        labels={progressLabels}
        assetPlan={videoAssetPlan} assetPlanPrompt={videoAssetPrompt} assetPlanConfirmed={videoAssetConfirmed}
        assetPlanBusy={videoAssetBusy} assetPlanError={videoAssetError}
        onPrepareAssetPlan={prepareVideoAssetPlan === undefined ? undefined : prepareVideoPlan}
        onAssetPlanPromptChange={(next) => { resetVideoCreative(); setVideoAssetPrompt(next)
          setVideoAssetConfirmed(false); invalidateQuote() }}
        onConfirmAssetPlan={() => { if (videoAssetPlan !== null && videoAssetPrompt.trim()
          && new TextEncoder().encode(videoAssetPrompt).byteLength <= 8192) setVideoAssetConfirmed(true) }}
        onGoalChange={(next) => { resetVideoCreative(); invalidateVideoAssetPlan()
          setGoal(next); invalidateQuote({ goal: next }) }}
        onAnswersChange={(next) => { resetVideoCreative(); invalidateVideoAssetPlan()
          setVideoAnswers(next); invalidateQuote({ videoAnswers: next }) }}
        onExpertChange={(next) => {
          if (!next && videoExpert) {
            const defaults = { ...paramDraft }
            for (const field of contract?.paramFields ?? []) {
              if (field.name === 'prompt' || field.required) continue
              defaults[field.name] = field.defaultValue === undefined
                ? field.type === 'boolean' ? false : ''
                : field.type === 'boolean' ? field.defaultValue === true : String(field.defaultValue)
            }
            setParamDraft(defaults)
            invalidateQuote({ params: defaults, videoExpert: next })
          }
          setVideoExpert(next)
          if (next) invalidateQuote({ videoExpert: next })
        }}
        onChange={() => { resetVideoCreative(); invalidateVideoAssetPlan(); invalidateQuote() }}
        onConfirm={confirmVideoCreative} />
      {videoStaged !== null && <details>
        <summary>{progressLabels.videoCreativeUploadedManifest}</summary>
        <p role="status">{progressLabels.videoCreativeUploadReceipt.replace('{version}',
          videoStaged.file.objectVersionId)}</p>
        <p>{progressLabels.videoCreativeObjectKey}：<code>{videoStaged.file.objectKey}</code></p>
        <p>{progressLabels.videoCreativeAssetSha256}：<code>{videoStaged.file.sha256}</code></p>
      </details>}
      {videoError && <p role="alert">{progressLabels.videoCreativeCheckFailed}</p>}
      {videoContractMismatch && <p role="alert">{progressLabels.videoCreativeContractMismatch}</p>}
      {catalogReady && !loading && contract !== null && !videoSupported && videoConfirmation !== null
        && <p role="status">{progressLabels.videoCreativeUnsupported}</p>}
      {videoSupported && <p>{progressLabels.videoCreativeReviewedOptionsHint}</p>}
      {videoSupported && (contract.paramFields ?? []).some(field => field.name !== 'prompt'
        && (videoExpert || field.required)) && <strong>{progressLabels.videoCreativeReviewedOptions}</strong>}
      {videoSupported && (contract.paramFields ?? []).filter(field => field.name !== 'prompt'
        && (videoExpert || field.required))
        .map(field => <label key={field.name}>{field.title}
          {field.type === 'boolean' ? <input type="checkbox" checked={paramDraft[field.name] === true}
            disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
            onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.checked }
              setParamDraft(next); invalidateQuote({ params: next }) }} />
            : field.choices !== undefined ? <select value={String(paramDraft[field.name] ?? '')}
              disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'}
              onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.value }
                setParamDraft(next); invalidateQuote({ params: next }) }}>
              {!field.required && <option value="">不指定</option>}
              {field.required && paramDraft[field.name] === '' && <option value="">请选择</option>}
              {field.choices.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
            </select> : <input type={field.type === 'string' ? 'text' : 'number'}
              value={String(paramDraft[field.name] ?? '')} required={field.required}
              min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength}
              step={field.type === 'integer' ? 1 : 'any'}
              disabled={phase === 'quoting' || phase === 'submitting' || phase === 'uncertain'
                || fixedVideoDurationSeconds === 5 && (field.name === 'frames' || field.name === 'fps')}
              onChange={(event) => { const next = { ...paramDraft, [field.name]: event.currentTarget.value }
                setParamDraft(next); invalidateQuote({ params: next }) }} />}
        </label>)}
      {videoConfirmation !== null && phase !== 'uncertain'
        && <button type="button" disabled={!canQuote || phase === 'quoting' || phase === 'submitting'}
          onClick={requestQuote}>{phase === 'quoting' ? '正在向中央服务器询价…'
            : quote === null || quoteExpired ? '查看单次报价' : '重新报价'}</button>}
    </>}
    {phase === 'quoted' && quote !== null && <div className={css.quote} role="status">
      <strong>本次执行价 ¥{quote.amountYuan}</strong>
      <span>报价有效至 {new Date(quote.expiresAt).toLocaleTimeString('zh-CN')}</span>
      {!quote.balanceEnough && <span>余额不足，当前不能确认派单。</span>}
      <button type="button" disabled={!catalogReady || (guidedVideo && videoRequest === null)
          || quoteExpired || !quote.balanceEnough} onClick={dispatch}>
        {quoteExpired ? '报价已过期，请重新报价' : '确认价格并派单'}
      </button>
    </div>}
    {phase === 'submitting' && <span role="status">正在提交，等待中央服务器任务回执…</span>}
    {phase === 'uncertain' && <button type="button" onClick={check}>核查任务回执</button>}
    {phase === 'submitted' && <div className={css.deliverable} role="status">
      {workload?.status === 'DONE' ? <p>{result === null
        ? resultError ? progressLabels.taskResultUnavailable : progressLabels.taskResultLoading
        : missingVideoResult ? progressLabels.taskVideoResultMissing
          : unsupportedArtifact ? progressLabels.taskResultUnavailable
            : deliveredMedia?.kind === 'image' ? progressLabels.taskImageCompleted
              : deliveredMedia?.kind === 'video' ? videoPlaybackStatus === 'ready'
                ? progressLabels.taskVideoPreviewReady : videoPlaybackStatus === 'failed'
                  ? progressLabels.taskVideoReadFailed : progressLabels.taskVideoReadablePending
                : progressLabels.taskCompleted}</p>
        : !['FAILED', 'CANCELLED', 'CANCELED', 'QUARANTINED'].includes(workload?.status ?? '')
          && <p>{progressLabels.taskReceived}</p>}
      {workload !== null && workload.status !== 'DONE' && <p>任务状态：{workload.status === 'QUARANTINED'
        ? acceptance?.status === 'pending_buyer' ? marketTaskStatusZh.pendingBuyer : marketTaskStatusZh.quarantine
        : workload.status === 'RUNNING'
          ? marketTaskStatusZh[workload.executionStage ?? 'unconfirmed']
          : Object.hasOwn(marketTaskStatusZh, workload.status)
            ? marketTaskStatusZh[workload.status as keyof typeof marketTaskStatusZh] : marketTaskStatusZh.unconfirmed}</p>}
      <MarketTaskProgress key={workloadId} workload={workload} disconnected={progressError}
        labels={progressLabels} videoTask={videoTask} />
      {progressError && <p role="alert">{progressLabels.taskProgressDisconnected}</p>}
      {progressError && <button type="button" onClick={() => { setResultRefresh(value => value + 1) }}>
        {progressLabels.taskProgressRefresh}</button>}
      <details><summary>{progressLabels.taskDetails}</summary>
        <p>{progressLabels.taskAbility}：{capability.name}</p>
        {continuationRef.current.amountYuan !== undefined
          && <p>{progressLabels.taskPrice}：¥{continuationRef.current.amountYuan}</p>}
        <details><summary>{progressLabels.taskDiagnostics}</summary>
          <p>{progressLabels.taskNumber}：<code>{workloadId}</code></p>
          <p>{progressLabels.taskNumberHint}</p>
        </details>
      </details>
      {workload?.status === 'DONE' && result !== null && <>
        {result.inlineOutput !== null && !missingVideoResult
          && <pre className={css.resultText}>{result.inlineOutput}</pre>}
        {resultReference !== null && workloadId !== null && !missingVideoResult && <MarketResultArtifact
          key={`${workloadId}:${resultReference}:${videoReadAttempt}`}
          reference={resultReference} workloadId={workloadId} labels={progressLabels}
          onVideoReady={() => { setVideoPlayback(previous => videoPlaybackAfterEvent(
            videoReadEpoch.current, videoReadAttempt, previous,
            { workloadId, reference: resultReference, status: 'ready' })) }}
          onVideoError={() => { setVideoPlayback(previous => videoPlaybackAfterEvent(
            videoReadEpoch.current, videoReadAttempt, previous,
            { workloadId, reference: resultReference, status: 'failed' })) }} />}
        {result.inlineOutput === null && result.artifactRef === null && !videoTask
          && <p>任务已完成，但平台尚未提供可展示的结果。</p>}
      </>}
      {workload?.status === 'DONE' && result === null && !resultError && <p>正在读取任务结果…</p>}
      {['FAILED', 'CANCELLED', 'CANCELED'].includes(workload?.status ?? '') && acceptance?.status !== 'rejected'
        && <p>任务未完成，请在任务记录中查看平台回执。</p>}
      {pendingBuyerAcceptance !== null && <>
        <p>结果已通过格式检查，等待你验收。托管金额 ¥{pendingBuyerAcceptance.heldAmount}，确认后中央服务器才会结算；拒绝则退回托管。</p>
        <pre className={css.resultText}>{JSON.stringify(pendingBuyerAcceptance.inlineOutput, null, 2)}</pre>
        {videoTask && <p role="alert">{progressLabels.taskVideoAcceptanceUnavailable}</p>}
        <div className={css.acceptanceActions}>
          {!videoTask && <button type="button" disabled={decisionPending || decisionAttempt.current?.decision === 'reject'}
            onClick={() => { decide('accept') }}>确认结果并结算</button>}
          <button type="button" disabled={decisionPending || decisionAttempt.current?.decision === 'accept'}
            onClick={() => { decide('reject') }}>拒绝结果并退款</button>
        </div>
      </>}
      {acceptance?.status === 'accepted' && workload?.status !== 'DONE' && <p>已确认结果，等待中央服务器完成结算。</p>}
      {acceptance?.status === 'rejected' && <p>已拒绝结果；中央服务器已按回执处理退款。</p>}
      {workload?.status === 'QUARANTINED' && acceptance === null && !acceptanceError
        && <p>正在等待独立验收；完成后会在这里显示结果。</p>}
      {acceptanceError && <p>暂时无法核查验收状态，请稍后重试。</p>}
      {decisionError && <p>确认状态待核查；请先刷新验收状态，勿重新发单。</p>}
      {(acceptanceError || decisionError) && <button type="button" onClick={() => {
        setAcceptance(null); setAcceptanceError(false); setDecisionError(false)
        setResultRefresh(value => value + 1)
      }}>刷新验收状态</button>}
      {resultError && <p>暂时无法读取结果，任务已受理；请核查任务状态。</p>}
      {workload?.status === 'DONE' && deliveredMedia?.kind === 'video' && !missingVideoResult && <button type="button"
        onClick={() => { videoReadEpoch.current += 1; setVideoPlayback(null); setVideoReadAttempt(videoReadEpoch.current) }}>
        {progressLabels.taskVideoRetry}</button>}
      {(resultError || missingVideoResult || (result !== null && result.inlineOutput === null && result.artifactRef === null))
        && <button type="button" onClick={() => { setResultError(false); setResultRefresh(value => value + 1) }}>重新读取结果</button>}
    </div>}
    {message !== null && <p role="alert">{message}</p>}
  </div>
}

function MarketResultArtifact({ reference, workloadId, labels, onVideoReady, onVideoError }: {
  reference: string
  workloadId: string
  labels: MarketTaskProgressLabels
  onVideoReady: () => void
  onVideoError: () => void
}) {
  const file = marketResultFile(reference, workloadId, window.location)
  if (file !== null) return <a className={css.resultDownload} href={file.href} download>{labels.taskDownloadFile}</a>
  const media = marketResultMedia(reference, workloadId, window.location)
  if (media?.kind === 'image') return <MarkdownText text={`![${labels.imageTitle}](/qianshou-result)`}
    pathImages={{ resolve: path => path === '/qianshou-result' ? media.src : undefined }} labels={{
      code: { copyLabel: labels.imageCodeCopy, copiedLabel: labels.imageCodeCopied }, footnotes: labels.imageFootnotes,
      image: { title: labels.imageTitle, preview: labels.imagePreview, close: labels.imageClose,
        copy: labels.imageCopy, copied: labels.imageCopied, copyFailed: labels.imageCopyFailed,
        download: labels.imageDownload, downloaded: labels.imageDownloaded, downloadFailed: labels.imageDownloadFailed,
        zoomIn: labels.imageZoomIn, zoomOut: labels.imageZoomOut, zoomLevel: labels.imageZoomLevel, fit: labels.imageFit },
    }} />
  if (media?.kind === 'video') return <>
    <video className={css.resultMedia} src={media.src} controls preload="metadata"
      onCanPlay={onVideoReady} onError={onVideoError} />
    <a className={css.resultDownload} href={media.src} download={media.filename}>{labels.taskDownloadFile}</a>
  </>
  return <><p>{labels.taskArtifactUnavailable}</p>
    <details><summary>{labels.taskDiagnostics}</summary><code>{reference}</code></details></>
}
