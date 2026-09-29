/** A local file-and-prompt flow. Saving, testing and creating a skill are separate actions. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  H3OwnerSetupInspection, H3OwnerSetupSelection, H3OwnerSelfTestStatus, H3OwnerSetupContextId,
} from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'
import type { NodeTranslate } from './NodeStatusPanel.tsx'
import type { NodeCopyKey } from './locales.ts'
import type { H3OwnerSetupTransport } from './h3-owner-setup-transport.ts'
import { h3OwnerErrorCopy } from './h3-owner-setup-copy.ts'
import css from './h3-owner-setup.module.css'

type FilePurpose = 'first-frame' | 'workflow' | 'model' | 'python' | 'ffmpeg' | 'ffprobe'
type FileField = 'firstFramePath' | 'workflowPath' | 'modelPath' | 'pythonPath' | 'ffmpegPath' | 'ffprobePath'

/** Desktop-only chooser returns an actual OS path, never a browser File.name. */
export type H3FileChooser = (purpose: FilePurpose) => Promise<string | null>

/** The Desktop-owned directory dialog selects the actual adapter output root. */
export async function chooseH3OutputFolder(): Promise<string | null> {
  const bridge = (window as unknown as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  if (bridge === undefined) throw new Error('H3_SETUP_PICKER_UNAVAILABLE')
  return bridge.pick()
}

/** Only the owned Desktop preload provides this narrow native file picker. */
export async function chooseH3LocalFile(purpose: FilePurpose): Promise<string | null> {
  const bridge = (window as unknown as {
    __DSH_H3_FILE_PICKER__?: { file(purpose: FilePurpose): Promise<string | null> }
  }).__DSH_H3_FILE_PICKER__
  if (bridge === undefined) throw new Error('H3_SETUP_PICKER_UNAVAILABLE')
  return bridge.file(purpose)
}

/** Integration may inject transport and chooser; opening the card only reads state. */
export interface H3OwnerWizardProps {
  readonly transport?: H3OwnerSetupTransport
  readonly t: NodeTranslate
  readonly chooseFile?: H3FileChooser
  readonly chooseDirectory?: () => Promise<string | null>
}

const FILES: readonly { readonly field: FileField; readonly purpose: FilePurpose; readonly label: NodeCopyKey }[] = [
  { field: 'firstFramePath', purpose: 'first-frame', label: 'h3SetupFirstFrame' },
  { field: 'workflowPath', purpose: 'workflow', label: 'h3SetupWorkflow' },
  { field: 'modelPath', purpose: 'model', label: 'h3SetupModel' },
  { field: 'pythonPath', purpose: 'python', label: 'h3SetupPython' },
  { field: 'ffmpegPath', purpose: 'ffmpeg', label: 'h3SetupFfmpeg' },
  { field: 'ffprobePath', purpose: 'ffprobe', label: 'h3SetupFfprobe' },
]

const OPERATION_COPY: Record<H3OwnerSelfTestStatus['state'], NodeCopyKey> = {
  pending: 'h3SetupPending', unknown: 'h3SetupUnknown', ready: 'h3SetupVerified', failed: 'h3SetupFailed',
}

function filename(path: string): string { return path.split(/[\\/]/u).at(-1) ?? '' }

/** Local setup card with retained progress and no automatic GPU or publication action. */
export function H3OwnerWizard({ transport, t, chooseFile = chooseH3LocalFile,
  chooseDirectory = chooseH3OutputFolder }: H3OwnerWizardProps) {
  const [open, setOpen] = useState(false)
  const transportKey = useMemo(() => randomUUID(), [transport])
  return <section className={css.card} data-h3-owner-setup>
    <header className={css.header}>
      <div><h2>{t('h3SetupTitle')}</h2><p className={css.hint}>{t('h3SetupIntro')}</p></div>
      <button type="button" className={css.button} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {t(open ? 'h3SetupClose' : 'h3SetupOpen')}
      </button>
    </header>
    {open ? transport === undefined ? <p role="status" className={css.hint}>{t('h3SetupUnavailable')}</p>
      : <SetupSteps key={transportKey} transport={transport} t={t} chooseFile={chooseFile} chooseDirectory={chooseDirectory} /> : null}
  </section>
}

function SetupSteps({ transport, t, chooseFile, chooseDirectory }: {
  transport: H3OwnerSetupTransport
  t: NodeTranslate
  chooseFile: H3FileChooser
  chooseDirectory: () => Promise<string | null>
}) {
  const [selection, setSelection] = useState<H3OwnerSetupSelection>({ runtime: 'v2', pythonPath: '', ffmpegPath: '', ffprobePath: '',
    firstFramePath: '', workflowPath: '', modelPath: '', adapterOutputRoot: '', adapterBase: 'http://127.0.0.1:8790' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [revision, setRevision] = useState(0)
  const [contextId, setContextId] = useState<H3OwnerSetupContextId | null>(null)
  const [inspection, setInspection] = useState<H3OwnerSetupInspection | null>(null)
  const [operation, setOperation] = useState<H3OwnerSelfTestStatus | null>(null)
  const [error, setError] = useState<NodeCopyKey | null>(null)
  const [created, setCreated] = useState(false)
  const [prompt, setPrompt] = useState(() => t('h3SetupDefaultPrompt'))
  const [displayName, setDisplayName] = useState(() => t('h3SetupSkillDefault'))
  const [description, setDescription] = useState(() => t('h3SetupDescriptionDefault'))
  const [skillName] = useState(() => `h3-video-${randomUUID().slice(0, 8)}`)
  const active = useRef(true)
  const commandPending = useRef(false)
  const blocked = busy || loading || operation?.state === 'pending' || operation?.state === 'unknown'

  useEffect(() => {
    active.current = true
    let current = true
    void transport.inspect().then((value) => {
      if (!current) return
      if (value.kind !== 'current') throw new Error('H3_SETUP_INVALID_RESPONSE')
      setConfigured(value.configured); setRevision(value.revision); setContextId(value.contextId); setOperation(value.operation ?? null)
    }).catch((reason: unknown) => { if (current) setError(h3OwnerErrorCopy(reason)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false; active.current = false }
  }, [transport])

  useEffect(() => {
    if (operation?.state !== 'pending') return
    let current = true
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      reading = true
      void transport.status(operation.operationId).then((value) => {
        if (!current) return
        if (value.revision !== operation.revision) throw new Error('H3_SETUP_REVISION_CHANGED')
        setOperation(value); setError(null)
      }).catch((reason: unknown) => { if (current) setError(h3OwnerErrorCopy(reason)) })
        .finally(() => { reading = false })
    }, 1500)
    return () => { current = false; clearInterval(timer) }
  }, [operation, transport])

  async function run(action: () => Promise<void>): Promise<void> {
    if (commandPending.current) return
    commandPending.current = true
    setBusy(true); setError(null)
    try { await action() } catch (reason) { if (active.current) setError(h3OwnerErrorCopy(reason)) }
    finally { commandPending.current = false; if (active.current) setBusy(false) }
  }

  async function pick(field: FileField, purpose: FilePurpose): Promise<void> {
    await run(async () => {
      const path = await chooseFile(purpose)
      if (!active.current || path === null) return
      setSelection(value => ({ ...value, [field]: path })); setDirty(true); setInspection(null); setCreated(false)
    })
  }

  const complete = FILES.every(item => selection[item.field].length > 0)
    && selection.adapterBase.trim().length > 0 && selection.adapterOutputRoot.length > 0
  function fileRow(item: typeof FILES[number]) {
    return <div className={css.field} key={item.field}>
      <span>{t(item.label)}</span>
      <div className={css.file}>
        <span className={css.filename}>{selection[item.field] ? filename(selection[item.field]) : t('h3SetupNoFile')}</span>
        <button type="button" className={css.button} disabled={blocked} aria-label={`${t('h3SetupChoose')} · ${t(item.label)}`}
          onClick={() => { void pick(item.field, item.purpose) }}>{t('h3SetupChoose')}</button>
      </div>
    </div>
  }

  return <>
    {loading ? <p role="status" className={css.status}>{t('h3SetupLoading')}</p> : null}
    {error === null ? null : <p role="alert" className={`${css.status} ${css.error}`}>{t(error)}</p>}
    <section className={css.section}>
      <h3>{t('h3SetupFiles')}</h3><p className={css.hint}>{t('h3SetupFilesHint')}</p>
      <div className={css.fields}>{FILES.slice(0, 3).map(fileRow)}</div>
      <div className={css.field}>
        <span>{t('h3SetupOutputFolder')}</span><span className={css.hint}>{t('h3SetupOutputFolderHint')}</span>
        <div className={css.file}>
          <span className={css.filename}>{selection.adapterOutputRoot ? filename(selection.adapterOutputRoot) : t('h3SetupNoFile')}</span>
          <button type="button" className={css.button} disabled={blocked} onClick={() => { void run(async () => {
            const path = await chooseDirectory()
            if (!active.current || path === null) return
            setSelection(value => ({ ...value, adapterOutputRoot: path })); setDirty(true); setInspection(null); setCreated(false)
          }) }}>{t('h3SetupChooseFolder')}</button>
        </div>
      </div>
      <details className={css.advanced}>
        <summary>{t('h3SetupEnvironment')}</summary><p className={css.hint}>{t('h3SetupEnvironmentHint')}</p>
        <div className={css.fields}>{FILES.slice(3).map(fileRow)}</div>
        <label className={css.field}>{t('h3SetupAdapter')}
          <input className={css.input} value={selection.adapterBase} disabled={blocked} onChange={(event) => {
            setSelection(value => ({ ...value, adapterBase: event.target.value })); setDirty(true); setInspection(null); setCreated(false)
          }} />
        </label>
      </details>
      <div className={css.actions}>
        <button type="button" className={css.button} disabled={blocked || !complete} onClick={() => { void run(async () => {
          const value = await transport.inspect(selection)
          if (value.kind !== 'inspection') throw new Error('H3_SETUP_INVALID_RESPONSE')
          if (active.current) { setInspection(value); setRevision(value.revision); setContextId(value.contextId) }
        }) }}>{t(busy ? 'h3SetupChecking' : 'h3SetupInspect')}</button>
        {inspection === null ? null : <button type="button" className={`${css.button} ${css.primary}`} disabled={blocked}
          onClick={() => { void run(async () => {
            const value = await transport.save({ inspectionId: inspection.inspectionId, expectedRevision: inspection.revision })
            if (active.current) {
              setConfigured(true); setRevision(value.revision); setContextId(value.contextId)
              setDirty(false); setInspection(null); setOperation(null)
            }
          }) }}>{t('h3SetupSave')}</button>}
      </div>
      {inspection === null ? null : <p role="status" className={css.status}>
        {t(inspection.adapterAvailable ? 'h3SetupInspected' : 'h3SetupAdapterOffline')}
      </p>}
    </section>
    {configured && !dirty ? <section className={css.section}>
      <h3>{t('h3SetupTrial')}</h3><p className={css.hint}>{t('h3SetupTrialHint')}</p>
      {operation === null ? <p className={css.hint}>{t('h3SetupSaved')}</p>
        : <p role="status" className={css.status}>{t(OPERATION_COPY[operation.state])}</p>}
      <label className={css.field}>{t('h3SetupPrompt')}<textarea className={css.input} rows={2} value={prompt} disabled={blocked}
        onChange={(event) => { setPrompt(event.target.value) }} /></label>
      <div className={css.actions}>
        <button type="button" className={`${css.button} ${css.primary}`}
          disabled={blocked || contextId === null || prompt.trim().length === 0 || operation !== null}
          onClick={() => { void run(async () => {
            if (contextId === null) throw new Error('H3_SETUP_CONTEXT_CHANGED')
            try { const value = await transport.start({ contextId, revision, prompt }); if (active.current) setOperation(value) }
            catch (reason) {
              const current = await transport.inspect()
              if (active.current && current.kind === 'current') {
                setOperation(current.operation ?? null); setRevision(current.revision); setContextId(current.contextId)
              }
              throw reason
            }
          }) }}>{t(busy ? 'h3SetupWorking' : 'h3SetupRun')}</button>
        {operation === null ? null : <button type="button" className={css.button} disabled={busy} onClick={() => { void run(async () => {
          const value = await transport.status(operation.operationId)
          if (value.revision !== revision) throw new Error('H3_SETUP_REVISION_CHANGED')
          const current = await transport.inspect()
          if (current.kind !== 'current' || current.revision !== revision
            || current.operation?.operationId !== operation.operationId) throw new Error('H3_SETUP_CONTEXT_CHANGED')
          if (active.current) { setOperation(current.operation); setContextId(current.contextId) }
        }) }}>{t('h3SetupRefresh')}</button>}
      </div>
    </section> : null}
    {configured && !dirty && operation?.state === 'ready' ? <section className={css.section}>
      <label className={css.field}>{t('h3SetupSkillName')}<input className={css.input} value={displayName} disabled={busy || created}
        onChange={(event) => { setDisplayName(event.target.value) }} /></label>
      <label className={css.field}>{t('h3SetupDescription')}
        <textarea className={css.input} rows={2} value={description} disabled={busy || created}
          onChange={(event) => { setDescription(event.target.value) }} /></label>
      <div className={css.actions}><button type="button" className={`${css.button} ${css.primary}`}
        disabled={busy || created || contextId === null || !displayName.trim() || !description.trim()}
        onClick={() => { void run(async () => {
          if (contextId === null) throw new Error('H3_SETUP_CONTEXT_CHANGED')
          await transport.draft({ contextId, revision, name: skillName, displayName, description })
          if (active.current) setCreated(true)
        }) }}>{t(busy ? 'h3SetupWorking' : 'h3SetupCreate')}</button></div>
      {created ? <p role="status" className={css.status}>{t('h3SetupCreated')}</p> : null}
    </section> : null}
  </>
}
