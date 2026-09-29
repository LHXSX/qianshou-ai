/** Buyer-side video brief and real, locally selected first-frame candidates. */
import { useEffect, useRef, useState } from 'react'
import type { MarketTaskProgressLabels } from './market-task-progress-locales.ts'
import { asksForSpecificVideoDuration, asksForUnverifiedVideoDuration,
  prepareVideoImageChoices, type VideoImageChoice } from './video-creative-handoff.ts'
import { recommendVideoImageFiles } from './video-image-recommendations.ts'
import { validVideoAssetPlan, videoAssetPlanInputIssue, type VideoAssetPlan } from './video-asset-plan.ts'
import css from './VideoCreativeBrief.module.css'

export interface VideoCreativeAnswers {
  subject: string
  motion: string
  style: string
  purpose?: string
  story?: string
  storyboard?: string
  sound?: string
  camera?: string
  avoid?: string
  duration?: string
}

interface FrameCandidate {
  choice: VideoImageChoice
  originalName: string
  preview: string
  source: 'selected' | 'folder'
  matchedKeywords: readonly string[]
}

/** Keep the original request and optional answers legible to a video executor. */
export function videoCreativePrompt(goal: string, answers: VideoCreativeAnswers,
  labels: MarketTaskProgressLabels): string {
  return [goal.trim(),
    answers.purpose?.trim() ? `${labels.videoCreativePurposePrompt}：${answers.purpose.trim()}` : '',
    answers.subject.trim() ? `${labels.videoCreativeSubjectPrompt}：${answers.subject.trim()}` : '',
    answers.story?.trim() ? `${labels.videoCreativeStoryPrompt}：${answers.story.trim()}` : '',
    answers.storyboard?.trim() ? `${labels.videoCreativeStoryboardPrompt}：${answers.storyboard.trim()}` : '',
    answers.motion.trim() ? `${labels.videoCreativeMotionPrompt}：${answers.motion.trim()}` : '',
    answers.style.trim() ? `${labels.videoCreativeStylePrompt}：${answers.style.trim()}` : '',
    answers.sound?.trim() ? `${labels.videoCreativeSoundPrompt}：${answers.sound.trim()}` : '',
    answers.camera?.trim() ? `${labels.videoCreativeCameraPrompt}：${answers.camera.trim()}` : '',
    answers.avoid?.trim() ? `${labels.videoCreativeAvoidPrompt}：${answers.avoid.trim()}` : '',
    answers.duration?.trim() ? `${labels.videoCreativeDurationPrompt}：${answers.duration.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** Only omit questions when the buyer's own words contain an unambiguous clue. */
function coveredBriefDetails(goal: string): { subject: boolean; motion: boolean; style: boolean } {
  return {
    subject: /(?:一只|一位|一个|两只|两位|两个|人物|角色|主体).{1,30}(?:在|位于).{1,30}/u.test(goal)
      || /(?:小狗|小猫|猫咪|人物|女孩|男孩|孩子|老人|汽车|飞船).{0,12}(?:在|奔跑|行走|飞行|跳跃)/u.test(goal),
    motion: /(?:镜头|运镜|机位).{0,20}(?:跟随|跟拍|推进|推近|拉远|环绕|平移|摇|俯拍|航拍)/u.test(goal)
      || /(?:奔跑|追逐|行走|散步|飞行|跳跃|跳舞|转身|落下|升起|游泳|摇曳)/u.test(goal),
    style: /(?:写实|纪实|手绘|水彩|油画|动画|卡通|电影感|国风|赛博朋克|像素风|黑白|自然光)/u.test(goal),
  }
}

type BriefQuestion = keyof Pick<VideoCreativeAnswers, 'subject' | 'motion' | 'style' | 'purpose'
  | 'story' | 'storyboard' | 'camera' | 'sound' | 'avoid' | 'duration'>

const expertQuestions: readonly BriefQuestion[] = ['purpose', 'story', 'storyboard', 'camera', 'sound', 'avoid', 'duration']

function firstUnansweredQuestion(goal: string, answers: VideoCreativeAnswers, expert: boolean): number {
  const covered = coveredBriefDetails(goal)
  const simple = (['subject', 'motion', 'style'] as const).filter(name => !covered[name])
  const questions: readonly BriefQuestion[] = expert
    ? [...simple, ...expertQuestions.filter(name => name !== 'duration' || !asksForSpecificVideoDuration(goal))] : simple
  const index = questions.findIndex(name => !(answers[name] ?? '').trim())
  return index < 0 ? questions.length : index
}

/** The preview shows only files the buyer picked; no decorative cover is a frame candidate. */
export function VideoCreativeBrief({ goal, answers, approved, busy, canConfirm, expert, labels, onGoalChange,
  onAnswersChange, onExpertChange, onChange, onConfirm, fixedDurationSeconds,
  assetPlan, assetPlanPrompt, assetPlanConfirmed, assetPlanBusy, assetPlanError,
  onPrepareAssetPlan, onAssetPlanPromptChange, onConfirmAssetPlan }: {
  goal: string
  answers: VideoCreativeAnswers
  approved: boolean
  busy: boolean
  canConfirm: boolean
  fixedDurationSeconds: number | null
  expert: boolean
  labels: MarketTaskProgressLabels
  onGoalChange: (value: string) => void
  onAnswersChange: (value: VideoCreativeAnswers) => void
  onExpertChange: (value: boolean) => void
  onChange: () => void
  onConfirm: (choice: VideoImageChoice, prompt: string) => void
  assetPlan?: VideoAssetPlan | null
  assetPlanPrompt?: string
  assetPlanConfirmed?: boolean
  assetPlanBusy?: boolean
  assetPlanError?: boolean
  onPrepareAssetPlan?: ((choice: VideoImageChoice | null) => void) | undefined
  onAssetPlanPromptChange?: (prompt: string) => void
  onConfirmAssetPlan?: () => void
}) {
  const [candidates, setCandidates] = useState<FrameCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(new Set())
  const [fileError, setFileError] = useState(false)
  const [folderError, setFolderError] = useState(false)
  const [folderUnmatched, setFolderUnmatched] = useState(false)
  const [folderBrief, setFolderBrief] = useState<string | null>(null)
  const [showAllQuestions, setShowAllQuestions] = useState(false)
  const [questionIndex, setQuestionIndex] = useState(() => firstUnansweredQuestion(goal, answers, expert))
  const [preparing, setPreparing] = useState(false)
  const selectionGeneration = useRef(0)
  const lastAutomaticFramePlan = useRef<string | null>(null)
  const lastAutomaticAnswerPlan = useRef(`${goal.trim()}\u0000${JSON.stringify(answers)}`)
  const prepareAssetPlan = useRef(onPrepareAssetPlan)
  prepareAssetPlan.current = onPrepareAssetPlan
  const previewUrls = useRef(new Set<string>())
  const folderFiles = useRef<readonly File[] | null>(null)
  useEffect(() => () => {
    selectionGeneration.current += 1
    for (const url of previewUrls.current) URL.revokeObjectURL(url)
    previewUrls.current.clear()
  }, [])
  const chooseFiles = (files: FileList | readonly File[] | null, source: FrameCandidate['source']): void => {
    if (files === null || files.length < 1) return
    const received = Array.from(files)
    const generation = ++selectionGeneration.current
    lastAutomaticFramePlan.current = null
    for (const url of previewUrls.current) URL.revokeObjectURL(url)
    previewUrls.current.clear()
    setCandidates([]); setSelectedId(null); setDecoded(new Set()); onChange()
    setFileError(false); setFolderError(false); setFolderUnmatched(false)
    folderFiles.current = null; setFolderBrief(null)
    let recommended: ReturnType<typeof recommendVideoImageFiles> = []
    if (source === 'folder') {
      try { recommended = recommendVideoImageFiles(received, prompt) }
      catch { setFolderError(true); return }
      if (recommended.length === 0) { setFolderError(true); return }
      folderFiles.current = received
      setFolderBrief(prompt)
      setFolderUnmatched(recommended.every(item => item.matchedKeywords.length === 0))
    }
    const picked = source === 'folder' ? recommended.map(item => item.file) : received
    if (picked.length > 3 || picked.some(file => !['image/png', 'image/jpeg'].includes(file.type)
      || file.size < 1 || file.size > 16 * 1024 * 1024)
      || picked.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024) {
      setPreparing(false)
      if (source === 'folder') setFolderError(true)
      else setFileError(true)
      return
    }
    setPreparing(true)
    void prepareVideoImageChoices(picked).then((choices) => {
      if (generation !== selectionGeneration.current) return
      const next = choices.map((choice, index) => {
        const preview = URL.createObjectURL(choice.file)
        previewUrls.current.add(preview)
        return { choice, originalName: picked[index]?.name ?? choice.file.name, preview, source,
          matchedKeywords: recommended[index]?.matchedKeywords ?? [] }
      })
      setCandidates(next)
    }).catch(() => { if (generation === selectionGeneration.current) {
      if (source === 'folder') setFolderError(true)
      else setFileError(true)
    } })
      .finally(() => { if (generation === selectionGeneration.current) setPreparing(false) })
  }
  const selected = candidates.find(item => item.choice.id === selectedId)
  const prompt = videoCreativePrompt(goal, answers, labels)
  const answersKey = JSON.stringify(answers)
  const planningInputIssue = videoAssetPlanInputIssue({ sourceGoal: goal.trim(), answers })
  const finalPrompt = onPrepareAssetPlan === undefined ? prompt : assetPlanPrompt ?? ''
  const folderStale = candidates.some(item => item.source === 'folder') && folderBrief !== prompt
  const promptTooLong = new TextEncoder().encode(finalPrompt).byteLength > 8192
  const selectedDecoded = selected !== undefined && decoded.has(selected.choice.id)
  const planMatchesSelection = assetPlan !== null && assetPlan !== undefined
    && validVideoAssetPlan(assetPlan, goal.trim(), selected?.choice ?? null)
  const modelPlanReady = planningInputIssue === null && ((expert && onPrepareAssetPlan === undefined)
    || (onPrepareAssetPlan !== undefined && planMatchesSelection && assetPlanConfirmed === true))
  useEffect(() => {
    if (planningInputIssue !== null || selected === undefined || !selectedDecoded
      || preparing || busy || assetPlanBusy || folderStale
      || prepareAssetPlan.current === undefined) return
    const key = `${prompt}\u0000${selected.choice.id}`
    if (lastAutomaticFramePlan.current === key && (planMatchesSelection || assetPlanError)) return
    const timer = window.setTimeout(() => {
      if (lastAutomaticFramePlan.current === key && (planMatchesSelection || assetPlanError)) return
      lastAutomaticFramePlan.current = key
      prepareAssetPlan.current?.(selected.choice)
    }, 250)
    return () => { window.clearTimeout(timer) }
  }, [prompt, selected?.choice.id, selectedDecoded, preparing, busy, assetPlanBusy, assetPlanError,
    folderStale, planMatchesSelection, expert, planningInputIssue?.kind,
    planningInputIssue?.kind === 'answer' ? planningInputIssue.field : undefined])
  useEffect(() => {
    if (planningInputIssue !== null || expert || selected !== undefined || preparing || candidates.length > 0
      || !goal.trim() || busy || assetPlanBusy
      || prepareAssetPlan.current === undefined) return
    const key = `${goal.trim()}\u0000${answersKey}`
    if (lastAutomaticAnswerPlan.current === key && (planMatchesSelection || assetPlanError)) return
    const timer = window.setTimeout(() => {
      if (lastAutomaticAnswerPlan.current === key && (planMatchesSelection || assetPlanError)) return
      lastAutomaticAnswerPlan.current = key
      prepareAssetPlan.current?.(null)
    }, 450)
    return () => { window.clearTimeout(timer) }
  }, [answersKey, goal, expert, selected?.choice.id, candidates.length, preparing, busy,
    assetPlanBusy, assetPlanError, planMatchesSelection, planningInputIssue?.kind,
    planningInputIssue?.kind === 'answer' ? planningInputIssue.field : undefined])
  const covered = coveredBriefDetails(goal)
  const simpleQuestions: BriefQuestion[] = (['subject', 'motion', 'style'] as const)
    .filter(name => showAllQuestions || !covered[name])
  const questions = [...simpleQuestions,
    ...expertQuestions.filter(name => name !== 'duration' || !asksForSpecificVideoDuration(goal))]
  const activeQuestion = expert && goal.trim() ? questions[questionIndex] : undefined
  const planReady = goal.trim().length > 0 && activeQuestion === undefined
  const briefReady = Boolean(goal.trim()) && (!expert || planReady)
  const durationUnverified = fixedDurationSeconds !== 5
    || asksForUnverifiedVideoDuration(`${goal}\n${answers.duration ?? ''}\n${finalPrompt}`,
      fixedDurationSeconds)
  const questionLabels: Record<BriefQuestion, string> = {
    subject: labels.videoCreativeSubject, motion: labels.videoCreativeMotion, style: labels.videoCreativeStyle,
    purpose: labels.videoCreativePurpose, story: labels.videoCreativeStory,
    storyboard: labels.videoCreativeStoryboard, camera: labels.videoCreativeCamera,
    sound: labels.videoCreativeSound, avoid: labels.videoCreativeAvoid,
    duration: labels.videoCreativeDuration,
  }
  const requestAssetPlan = (): void => {
    if (onPrepareAssetPlan === undefined || planningInputIssue !== null) return
    if (selected === undefined) lastAutomaticAnswerPlan.current = `${goal.trim()}\u0000${answersKey}`
    else lastAutomaticFramePlan.current = `${prompt}\u0000${selected.choice.id}`
    onPrepareAssetPlan(selected?.choice ?? null)
  }
  const switchToSimple = (): void => {
    if (!expert) return
    onChange()
    lastAutomaticFramePlan.current = null
    setQuestionIndex(firstUnansweredQuestion(goal, answers, false))
    onExpertChange(false)
  }
  return <section className={css.brief} aria-label={labels.videoCreativeTitle}>
    <div className={css.mode} role="group" aria-label={labels.videoCreativeMode}>
      <button type="button" aria-pressed={!expert} disabled={busy}
        onClick={switchToSimple}>
        {labels.videoCreativeSimpleMode}</button>
      <button type="button" aria-pressed={expert} disabled={busy}
        onClick={() => { if (!expert) { onChange(); lastAutomaticFramePlan.current = null
          setQuestionIndex(firstUnansweredQuestion(goal, answers, true))
          onExpertChange(true) } }}>
        {labels.videoCreativeExpertMode}</button>
    </div>
    <p className={css.modeHint}>{expert ? labels.videoCreativeExpertHint : labels.videoCreativeSimpleHint}</p>
    {planningInputIssue?.kind === 'goal' && <p role="alert">{labels.videoCreativeAiGoalInputLimit}</p>}
    {planningInputIssue?.kind === 'answer' && <p role="alert">
      {labels.videoCreativeAiAnswerInputLimit.replace('{field}', questionLabels[planningInputIssue.field])}
    </p>}
    {!expert && <div className={css.requestCard}>
      <strong>{labels.videoCreativeRequest}</strong>
      {goal.trim() ? <>
        <p className={css.requestText}>{goal.trim()}</p>
        <details className={css.optional}>
          <summary>{labels.videoCreativeEditRequest}</summary>
          <label>{labels.videoCreativeRequest}
            <textarea value={goal} maxLength={6000} rows={3} disabled={busy}
              placeholder={labels.videoCreativeRequestHint}
              onChange={(event) => { onGoalChange(event.currentTarget.value) }} />
          </label>
        </details>
      </> : <label>{labels.videoCreativeRequest}
        <textarea value={goal} maxLength={6000} rows={3} disabled={busy}
          placeholder={labels.videoCreativeRequestHint}
          onChange={(event) => { onGoalChange(event.currentTarget.value) }} />
      </label>}
    </div>}
    {!expert && goal.trim() && <details className={css.optional}>
      <summary>{labels.videoCreativeOptionalDetails}</summary>
      {(['subject', 'motion', 'style', 'purpose', 'story', 'storyboard', 'camera', 'sound',
        'avoid', 'duration'] as const).map(name => <label key={name}>{questionLabels[name]}
        {name === 'story' || name === 'storyboard'
          ? <textarea value={answers[name] ?? ''} maxLength={600} rows={3} disabled={busy}
            onChange={(event) => { onAnswersChange({ ...answers, [name]: event.currentTarget.value }) }} />
          : <input type="text" value={answers[name] ?? ''} maxLength={200} disabled={busy}
            onChange={(event) => { onAnswersChange({ ...answers, [name]: event.currentTarget.value }) }} />}
      </label>)}
      <p>{labels.videoCreativeSoundHint}</p>
    </details>}
    {expert && <>
      <p className={css.step}>{labels.videoCreativeRequestStep}</p>
      <label>{labels.videoCreativeRequest}
        <textarea value={goal} maxLength={6000} rows={3} disabled={busy}
          placeholder={labels.videoCreativeRequestHint}
          onChange={(event) => { setQuestionIndex(0); setShowAllQuestions(false)
            onGoalChange(event.currentTarget.value) }} />
      </label>
      <fieldset className={css.questions} disabled={busy || !goal.trim()}>
        <legend>{labels.videoCreativeQuestionsStep}</legend>
        <p>{goal.trim() ? labels.videoCreativeQuestionsHint : labels.videoCreativeStartHint}</p>
        {activeQuestion !== undefined && <div className={css.questionCard}>
          <span className={css.questionNumber}>{labels.videoCreativeQuestionNumber
            .replace('{current}', String(questionIndex + 1)).replace('{total}', String(questions.length))}</span>
          <label>{questionLabels[activeQuestion]}
            {activeQuestion === 'story' || activeQuestion === 'storyboard'
              ? <textarea value={answers[activeQuestion] ?? ''} maxLength={600} rows={3}
                onChange={(event) => { onAnswersChange({ ...answers,
                  [activeQuestion]: event.currentTarget.value }) }} />
              : <input type="text" value={answers[activeQuestion] ?? ''} maxLength={200}
                onChange={(event) => { onAnswersChange({ ...answers,
                  [activeQuestion]: event.currentTarget.value }) }} />}
          </label>
          <div className={css.questionActions}>
            <button type="button" onClick={() => { setQuestionIndex(index => index + 1) }}>
              {(answers[activeQuestion] ?? '').trim()
                ? labels.videoCreativeNextQuestion : labels.videoCreativeSkipQuestion}
            </button>
            {questionIndex > 0 && <button type="button" onClick={() => { setQuestionIndex(index => index - 1) }}>
              {labels.videoCreativePreviousQuestion}
            </button>}
            <button type="button" onClick={switchToSimple} title={labels.videoCreativeSimpleHint}>
              {labels.videoCreativeSimpleMode}</button>
          </div>
          <p>{labels.videoCreativeSimpleHint}</p>
        </div>}
        {planReady && <p role="status">{labels.videoCreativePlanReady}</p>}
        {goal.trim() && <button type="button" onClick={() => { onChange(); setShowAllQuestions(true); setQuestionIndex(0) }}>
          {labels.videoCreativeEditAllQuestions}
        </button>}
        <p>{labels.videoCreativeExpertPromptHint}</p>
      </fieldset>
    </>}
    {goal.trim() && (expert ? <div className={css.planCard}>
      <strong>{planReady ? labels.videoCreativePlanTitle : labels.videoCreativeAiStartTitle}</strong>
      <p>{labels.videoCreativePlanIntro}</p>
      <p>{assetPlan === null || assetPlan === undefined ? labels.videoCreativeManualPlan
        : labels.videoCreativeManualDraft}</p>
      <p className={css.planText}>{prompt}</p>
      {durationUnverified && <p role="alert">{labels.videoCreativeDurationUnverified}</p>}
      {onPrepareAssetPlan !== undefined && <>
        <button type="button" disabled={planningInputIssue !== null || busy || preparing || assetPlanBusy || folderStale
          || selected !== undefined && !selectedDecoded}
        onClick={requestAssetPlan}>
          {assetPlanBusy ? labels.videoCreativeAiPlanning : labels.videoCreativeAiPrepare}
        </button>
        {assetPlanError && planningInputIssue === null && <p role="alert">{labels.videoCreativeAiFailed}</p>}
        {planMatchesSelection && assetPlan !== null && assetPlan !== undefined && <>
          <p role="status">{labels.videoCreativeAiReceipt}</p>
          <p>{labels.videoCreativeAiGuidance}：{assetPlan.assetGuidance}</p>
          <p>{labels.videoCreativeAiDuration}</p>
          <label>{labels.videoCreativeAiPrompt}
            <textarea rows={5} maxLength={8000} value={assetPlanPrompt ?? ''} disabled={busy || assetPlanBusy}
              onChange={(event) => { onAssetPlanPromptChange?.(event.currentTarget.value) }} />
          </label>
          <button type="button" disabled={planningInputIssue !== null || busy || assetPlanBusy || !selectedDecoded
            || !(assetPlanPrompt ?? '').trim() || promptTooLong || durationUnverified}
          onClick={onConfirmAssetPlan}>{labels.videoCreativeAiConfirm}</button>
          {assetPlanConfirmed && <p role="status">{labels.videoCreativeAiConfirmed}</p>}
        </>}
      </>}
      <button type="button" disabled={busy} onClick={() => { onChange(); setQuestionIndex(0) }}>
        {labels.videoCreativeRevisePlan}
      </button>
    </div> : <div className={css.planCard}>
      <strong>{labels.videoCreativePlanTitle}</strong>
      {onPrepareAssetPlan === undefined ? <p role="alert">{labels.videoCreativeAiUnavailable}</p> : <>
        {assetPlanBusy && <p role="status">{labels.videoCreativeAiPlanning}</p>}
        {assetPlanError && planningInputIssue === null && <p role="alert">{labels.videoCreativeAiFailed}</p>}
        {!assetPlanBusy && !assetPlanError && !planMatchesSelection && planningInputIssue === null
          && <p role="status">{selected === undefined
            ? labels.videoCreativeAiPending : labels.videoCreativeFramePlanPending}</p>}
        {!assetPlanBusy && (assetPlanError || !planMatchesSelection) && <button type="button"
          disabled={planningInputIssue !== null || busy || preparing || folderStale
            || selected !== undefined && !selectedDecoded}
          onClick={requestAssetPlan}>
          {labels.videoCreativeAiRetry}
        </button>}
        {planMatchesSelection && assetPlan !== null && assetPlan !== undefined && <>
          <p role="status">{labels.videoCreativeAiReceipt}</p>
          <p>{labels.videoCreativeAiGuidance}：{assetPlan.assetGuidance}</p>
          <p>{labels.videoCreativeAiDuration}</p>
          <p className={css.planText}>{assetPlanPrompt ?? assetPlan.prompt}</p>
          <details className={css.optional}>
            <summary>{labels.videoCreativeEditAiPrompt}</summary>
            <label>{labels.videoCreativeAiPrompt}
              <textarea rows={5} maxLength={8000} value={assetPlanPrompt ?? ''}
                disabled={busy || assetPlanBusy}
                onChange={(event) => { onAssetPlanPromptChange?.(event.currentTarget.value) }} />
            </label>
          </details>
          {selectedDecoded && <button type="button" disabled={planningInputIssue !== null
            || busy || assetPlanBusy || folderStale
            || !(assetPlanPrompt ?? '').trim() || promptTooLong || durationUnverified}
          onClick={onConfirmAssetPlan}>{labels.videoCreativeAiConfirm}</button>}
          {assetPlanConfirmed && <p role="status">{labels.videoCreativeAiConfirmed}</p>}
        </>}
      </>}
      {durationUnverified && <p role="alert">{labels.videoCreativeDurationUnverified}</p>}
    </div>)}
    {briefReady && <div className={css.frames}>
      <p className={css.step}>{expert ? labels.videoCreativeFramesStep : labels.videoCreativeSimpleFramesStep}</p>
      <p>{labels.videoCreativeFramesHint}</p>
      <div className={css.sourceActions}>
        <label className={css.sourceAction} aria-disabled={busy || preparing}>{labels.videoCreativeChooseFolder}
          <input className={css.fileInput} type="file" accept="image/png,image/jpeg" multiple
            disabled={busy || preparing} ref={(input) => { input?.setAttribute('webkitdirectory', '') }}
            onChange={(event) => { chooseFiles(event.currentTarget.files, 'folder'); event.currentTarget.value = '' }} />
        </label>
        <label className={css.sourceAction} aria-disabled={busy || preparing}>{labels.videoCreativeChooseImages}
          <input className={css.fileInput} type="file" accept="image/png,image/jpeg" multiple
            disabled={busy || preparing}
            onChange={(event) => { chooseFiles(event.currentTarget.files, 'selected'); event.currentTarget.value = '' }} />
        </label>
      </div>
      <p>{labels.videoCreativeFolderHint}</p>
      {preparing && <p role="status">{labels.videoCreativeChecking}</p>}
      {fileError && <p role="alert">{labels.videoCreativeFileError}</p>}
      {folderError && <p role="alert">{labels.videoCreativeFolderError}</p>}
      {candidates.length > 0 && folderUnmatched && <p role="status">{labels.videoCreativeFolderUnmatched}</p>}
      {folderStale && <div role="status">
        <span>{labels.videoCreativeFolderStale}</span>
        <button type="button" disabled={busy || preparing || folderFiles.current === null}
          onClick={() => { chooseFiles(folderFiles.current, 'folder') }}>
          {labels.videoCreativeRefreshFolder}
        </button>
      </div>}
      {candidates.length === 0 && <p role="status">{labels.videoCreativeNoImages}</p>}
      {candidates.length > 0 && <div className={css.grid} role="group" aria-label={labels.videoCreativeFrameOptions}>
        {candidates.map(item => <button key={item.choice.id} type="button" className={css.frame}
          aria-pressed={item.choice.id === selectedId} disabled={busy || preparing}
          onClick={() => { if (selectedId !== item.choice.id) {
            setSelectedId(item.choice.id); onChange()
          } }}>
          <img src={item.preview} alt={item.originalName}
            onLoad={() => { setDecoded(previous => new Set(previous).add(item.choice.id)) }}
            onError={() => {
              URL.revokeObjectURL(item.preview); previewUrls.current.delete(item.preview)
              setCandidates(previous => previous.filter(candidate => candidate.choice.id !== item.choice.id))
              setSelectedId(previous => previous === item.choice.id ? null : previous)
              if (item.source === 'folder') setFolderError(true)
              else setFileError(true)
              onChange()
            }} />
          <strong>{item.originalName}</strong>
          <small>{item.source === 'folder' ? labels.videoCreativeFolderSource
            : labels.videoCreativeLocalSource}</small>
          {item.matchedKeywords.length > 0 && <small>{labels.videoCreativeNameMatch.replace('{keywords}',
            item.matchedKeywords.slice(0, 4).join('、'))}</small>}
        </button>)}
      </div>}
    </div>}
    {briefReady && <div className={css.confirm}>
      <p className={css.step}>{expert ? labels.videoCreativeConfirmStep
        : labels.videoCreativeSimpleConfirmStep}</p>
      {promptTooLong && <p role="alert">{labels.videoCreativePromptTooLong}</p>}
      {selected !== undefined && <p>{labels.videoCreativeChosenFrame.replace('{name}', selected.originalName)}</p>}
      {selected !== undefined && <details className={css.assetCard}>
        <summary>{labels.videoCreativeAssetList}</summary>
        <p>{assetPlan === null || assetPlan === undefined ? labels.videoCreativeAssetSource
          : labels.videoCreativeAiAssetSource}</p>
        <dl>
          <dt>{labels.videoCreativeAssetPrompt}</dt><dd>{assetPlan === null || assetPlan === undefined
            ? labels.videoCreativeAssetBuyerInput : labels.videoCreativeAssetAiDraft}</dd>
          <dt>{labels.videoCreativeAssetFrame}</dt><dd>{selected.originalName}</dd>
          <dt>{labels.videoCreativeAssetFormat}</dt><dd>{selected.choice.mimeType}</dd>
          <dt>{labels.videoCreativeAssetBytes}</dt><dd>{selected.choice.bytes}</dd>
          <dt>{labels.videoCreativeAssetSha256}</dt><dd><code>{selected.choice.sha256}</code></dd>
        </dl>
      </details>}
      <p>{labels.videoCreativePriceNotice}</p>
      <p role="status">{canConfirm ? labels.videoCreativeSupplyNotice : labels.videoCreativeUnsupported}</p>
      {selected !== undefined && !decoded.has(selected.choice.id)
        && <p role="status">{labels.videoCreativeChecking}</p>}
      <button type="button" disabled={!canConfirm || !modelPlanReady || busy || preparing || !finalPrompt
        || promptTooLong || durationUnverified || folderStale || selected === undefined
        || !decoded.has(selected.choice.id)}
      onClick={() => { if (selected !== undefined && finalPrompt) onConfirm(selected.choice, finalPrompt) }}>
        {busy ? labels.videoCreativeChecking : labels.videoCreativeConfirm}
      </button>
      {approved && <p role="status">{labels.videoCreativeApproved}</p>}
    </div>}
  </section>
}
