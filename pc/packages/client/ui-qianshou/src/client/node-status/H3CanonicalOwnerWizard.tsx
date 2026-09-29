/** PNG-only local setup; two explicit trials precede a separate skill draft command. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { H3CanonicalSetupInspection, H3CanonicalSetupSummary }
  from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'
import type { H3CanonicalSetupTransport } from './h3-canonical-setup-transport.ts'
import { chooseH3LocalFile, type H3FileChooser } from './H3OwnerWizard.tsx'
import { h3OwnerErrorCopy } from './h3-owner-setup-copy.ts'
import type { NodeTranslate } from './NodeStatusPanel.tsx'
import type { NodeCopyKey } from './locales.ts'
import css from './h3-owner-setup.module.css'

/** Only authenticated transport and the Desktop file picker reach the setup component. */
export interface H3CanonicalOwnerWizardProps {
  readonly transport: H3CanonicalSetupTransport
  readonly t: NodeTranslate
  readonly chooseFile?: H3FileChooser
}

function errorCopy(reason: unknown): NodeCopyKey {
  const code = reason instanceof Error ? reason.message : ''
  if (code === 'H3_CANONICAL_FIRST_FRAME_INVALID') return 'h3CanonicalFrameInvalid'
  if (code === 'H3_CANONICAL_READ_UNAVAILABLE' || code === 'H3_CANONICAL_READ_TIMEOUT') return 'h3CanonicalServiceOffline'
  if (code === 'H3_CANONICAL_PROTOCOL_INVALID' || code === 'H3_CANONICAL_RESPONSE_INVALID') return 'h3CanonicalIdentityUnverified'
  if (code === 'H3_CANONICAL_SOFTWARE_UNSUPPORTED' || code === 'H3_OWNER_RUNTIME_IDENTITY_INVALID'
    || code === 'H3_CANONICAL_IDENTITY_INVALID') return 'h3CanonicalSoftware'
  if (code === 'H3_CANONICAL_TWO_TRIALS_REQUIRED' || code === 'H3_CANONICAL_FIRST_TRIAL_REQUIRED') return 'h3CanonicalTwoTrials'
  if (code === 'H3_CANONICAL_MANAGED_INVALID') return 'h3CanonicalRecord'
  if (code === 'H3_OWNER_CONFIGURATION_CHANGED') return 'h3SetupChanged'
  return h3OwnerErrorCopy(reason)
}

/**
 * Show the canonical path; opening the card only reads the current local state.
 * @param props Current transport, locale and an optional owned file chooser.
 * @returns A local setup card without private runtime facts.
 */
export function H3CanonicalOwnerWizard({ transport, t, chooseFile = chooseH3LocalFile }: H3CanonicalOwnerWizardProps) {
  const [open, setOpen] = useState(false)
  const key = useMemo(() => randomUUID(), [transport])
  return <section className={css.card} data-h3-canonical-setup>
    <header className={css.header}>
      <div><h2>{t('h3CanonicalTitle')}</h2><p className={css.hint}>{t('h3CanonicalIntro')}</p></div>
      <button type="button" className={css.button} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {t(open ? 'h3CanonicalClose' : 'h3CanonicalOpen')}
      </button>
    </header>
    {open ? <CanonicalSteps key={key} transport={transport} t={t} chooseFile={chooseFile} /> : null}
  </section>
}

function CanonicalSteps({ transport, t, chooseFile }: H3CanonicalOwnerWizardProps & { readonly chooseFile: H3FileChooser }) {
  const [summary, setSummary] = useState<H3CanonicalSetupSummary | null>(null)
  const [inspection, setInspection] = useState<H3CanonicalSetupInspection | null>(null)
  const [firstFramePath, setFirstFramePath] = useState('')
  const [adapterBase, setAdapterBase] = useState('http://127.0.0.1:8791')
  const [negative, setNegative] = useState('')
  const [prompt, setPrompt] = useState(() => t('h3SetupDefaultPrompt'))
  const [displayName, setDisplayName] = useState(() => t('h3SetupSkillDefault'))
  const [description, setDescription] = useState(() => t('h3SetupDescriptionDefault'))
  const [name] = useState(() => `h3-video-${randomUUID().slice(0, 8)}`)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [created, setCreated] = useState(false)
  const [error, setError] = useState<NodeCopyKey | null>(null)
  const active = useRef(true)
  const commandPending = useRef(false)
  const uncertain = summary?.state === 'pending' || summary?.state === 'unknown'
  const blocked = loading || busy || uncertain
  const samples = summary?.samples ?? []
  const firstReady = samples.some(item => item.sample === 1 && item.state === 'ready')
  const nextSample: 1 | 2 = firstReady ? 2 : 1
  const pending = samples.find(item => item.state === 'pending')
  const readiness = !dirty && summary?.state === 'ready' ? 'trial'
    : inspection !== null ? 'inspected' : 'unchecked'
  const readinessCopy: NodeCopyKey = readiness === 'trial' ? 'h3CanonicalRequirementTrial'
    : readiness === 'inspected' ? 'h3CanonicalRequirementInspected' : 'h3CanonicalRequirementUnchecked'
  const requirements: readonly NodeCopyKey[] = ['h3CanonicalComfyRequirement', 'h3CanonicalModelsRequirement',
    'h3CanonicalPluginsRequirement', 'h3CanonicalWorkflowRequirement']

  async function refresh(): Promise<H3CanonicalSetupSummary> {
    const value = await transport.inspect()
    if (value.kind !== 'current') throw new Error('H3_SETUP_INVALID_RESPONSE')
    if (active.current) setSummary(value)
    return value
  }

  useEffect(() => {
    active.current = true
    let current = true
    void transport.inspect().then((value) => {
      if (!current) return
      if (value.kind !== 'current') throw new Error('H3_SETUP_INVALID_RESPONSE')
      setSummary(value)
    }).catch((reason: unknown) => { if (current) setError(errorCopy(reason)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false; active.current = false }
  }, [transport])

  useEffect(() => {
    if (pending === undefined) return
    const pendingCheck = { current: true }
    const stillCurrent = () => pendingCheck.current
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      reading = true
      void transport.status(pending.operationId).then(async (status) => {
        if (!stillCurrent()) return
        if (status.revision !== pending.revision || status.sample !== pending.sample) throw new Error('H3_SETUP_REVISION_CHANGED')
        const value = await transport.inspect()
        if (!stillCurrent()) return
        if (value.kind !== 'current' || value.revision !== pending.revision
          || !value.samples.some(item => item.operationId === pending.operationId)) throw new Error('H3_SETUP_CONTEXT_CHANGED')
        setSummary(value); setError(null)
      }).catch((reason: unknown) => { if (stillCurrent()) setError(errorCopy(reason)) }).finally(() => { reading = false })
    }, 1500)
    return () => { pendingCheck.current = false; clearInterval(timer) }
  }, [pending, transport])

  async function run(action: () => Promise<void>): Promise<void> {
    if (commandPending.current) return
    commandPending.current = true; setBusy(true); setError(null)
    try { await action() } catch (reason) { if (active.current) setError(errorCopy(reason)) }
    finally { commandPending.current = false; if (active.current) setBusy(false) }
  }
  function changed(): void { setDirty(true); setInspection(null); setCreated(false) }
  function statusCopy(): NodeCopyKey {
    if (summary?.state === 'pending') return 'h3CanonicalPending'
    if (summary?.state === 'unknown') return 'h3CanonicalUnknown'
    if (summary?.state === 'ready') return 'h3CanonicalReady'
    return firstReady ? 'h3CanonicalFirstReady' : 'h3CanonicalSaved'
  }

  return <>
    {loading ? <p role="status" className={css.status}>{t('h3SetupLoading')}</p> : null}
    {error === null ? null : <p role="alert" className={`${css.status} ${css.error}`}>{t(error)}</p>}
    <section className={css.section} data-h3-readiness={readiness}>
      <h3>{t('h3CanonicalRequirementsTitle')}</h3>
      <p className={css.hint}>{t('h3CanonicalRequirementsIntro')}</p>
      <ul className={css.requirements}>{requirements.map(key => <li key={key}>
        <span>{t(key)}</span><small>{t(readinessCopy)}</small>
      </li>)}</ul>
      <p className={css.hint}>{t('h3CanonicalInstallGuide')}</p>
      <p className={css.hint}>{t('h3CanonicalSupplyGate')}</p>
    </section>
    <section className={css.section}>
      <p className={css.hint}>{t('h3CanonicalFrameHint')}</p>
      <div className={css.field}><span>{t('h3SetupFirstFrame')}</span><div className={css.file}>
        <span className={css.filename}>{firstFramePath.split(/[\\/]/u).at(-1) || t('h3SetupNoFile')}</span>
        <button type="button" className={css.button} disabled={blocked}
          aria-label={`${t('h3SetupChoose')} · ${t('h3SetupFirstFrame')}`} onClick={() => { void run(async () => {
            const path = await chooseFile('first-frame')
            if (!active.current || path === null) return
            setFirstFramePath(path); changed()
          }) }}>{t('h3SetupChoose')}</button>
      </div></div>
      <details className={css.advanced}><summary>{t('h3CanonicalAdvanced')}</summary>
        <p className={css.hint}>{t('h3CanonicalAdvancedHint')}</p>
        <label className={css.field}>{t('h3SetupAdapter')}<input className={css.input} value={adapterBase} disabled={blocked}
          onChange={(event) => { setAdapterBase(event.target.value); changed() }} /></label>
        <label className={css.field}>{t('h3CanonicalNegative')}<textarea className={css.input} value={negative} disabled={blocked}
          onChange={(event) => { setNegative(event.target.value); changed() }} /></label>
      </details>
      <div className={css.actions}>
        <button type="button" className={css.button} disabled={blocked || !firstFramePath || !adapterBase.trim()}
          onClick={() => { void run(async () => {
            const value = await transport.inspect({ firstFramePath, adapterBase, negative })
            if (value.kind !== 'inspection') throw new Error('H3_SETUP_INVALID_RESPONSE')
            if (active.current) setInspection(value)
          }) }}>{t(busy ? 'h3SetupChecking' : 'h3SetupInspect')}</button>
        {inspection === null ? null : <button type="button" className={`${css.button} ${css.primary}`} disabled={blocked}
          onClick={() => { void run(async () => {
            await transport.save({ inspectionId: inspection.inspectionId, expectedRevision: inspection.revision })
            if (!active.current) return
            setDirty(false); setInspection(null); setCreated(false); await refresh()
          }) }}>{t('h3SetupSave')}</button>}
      </div>
      {inspection === null ? null : <p role="status" className={css.status}>{t('h3CanonicalInspected')}</p>}
    </section>
    {summary?.configured && !dirty ? <section className={css.section}>
      <h3>{t('h3CanonicalTrial')}</h3><p className={css.hint}>{t('h3CanonicalTrialHint')}</p>
      <p role="status" className={css.status}>{t(statusCopy())}</p>
      <label className={css.field}>{t('h3SetupPrompt')}<textarea className={css.input} rows={2} value={prompt} disabled={blocked}
        onChange={(event) => { setPrompt(event.target.value) }} /></label>
      <div className={css.actions}>
        {summary.state === 'ready' ? null : <button type="button" className={`${css.button} ${css.primary}`}
          disabled={blocked || !prompt.trim() || samples.some(item => item.sample === nextSample)}
          onClick={() => { void run(async () => {
            try {
              await transport.start({ contextId: summary.contextId, revision: summary.revision, sample: nextSample, prompt })
              if (active.current) await refresh()
            } catch (reason) {
              if (active.current) await refresh()
              throw reason
            }
          }) }}>{t(nextSample === 1 ? 'h3CanonicalRunFirst' : 'h3CanonicalRunSecond')}</button>}
        <button type="button" className={css.button} disabled={busy} onClick={() => { void run(async () => {
          await refresh()
        }) }}>{t('h3SetupRefresh')}</button>
      </div>
    </section> : null}
    {summary?.state === 'ready' && !dirty ? <section className={css.section}>
      <label className={css.field}>{t('h3SetupSkillName')}<input className={css.input} value={displayName} disabled={busy || created}
        onChange={(event) => { setDisplayName(event.target.value) }} /></label>
      <label className={css.field}>{t('h3SetupDescription')}<textarea className={css.input} rows={2} value={description}
        disabled={busy || created} onChange={(event) => { setDescription(event.target.value) }} /></label>
      <button type="button" className={`${css.button} ${css.primary}`} disabled={busy || created || !displayName.trim() || !description.trim()}
        onClick={() => { void run(async () => {
          await transport.draft({ contextId: summary.contextId, revision: summary.revision, name, displayName, description })
          if (active.current) setCreated(true)
        }) }}>{t('h3SetupCreate')}</button>
      {created ? <p role="status" className={css.status}>{t('h3SetupCreated')}</p> : null}
    </section> : null}
  </>
}
