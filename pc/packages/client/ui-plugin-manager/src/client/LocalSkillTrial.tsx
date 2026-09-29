/** Explicit owner-run trial, with controls derived from the exact current source contract. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalSkillKey } from './local-skill-locales.ts'
import { MarketInputFields } from './MarketInputFields.tsx'
import { marketInputDraft, parseMarketInputRule, serializeMarketInput,
  type MarketInputDraft, type MarketInputRule } from './market-input-form.ts'
import css from './LocalSkillTrial.module.css'

/** Actual Host execution output and its source digest, separate from platform approval. */
export interface LocalTrialResult {
  readonly outputJson: string
  readonly artifactDigest: string
  readonly taskType: string
  readonly elapsedMs: number
}

/** The Host reads only a skill currently present in the controlled local inventory. */
export interface LocalTrialDefinition {
  readonly schema: 'qianshou.local-skill-trial.v1'
  readonly taskType: string
  readonly artifactDigest: string
  readonly inputSchemaJson: string | null
  readonly supportsLocalTrial: boolean
  readonly unavailableReason: 'file-trial-unavailable' | 'runtime-unavailable' | null
}

export type LoadLocalSkillTrial = (source: 'user-dsh' | 'user-agents', name: string) => Promise<LocalTrialDefinition>
/** The digest binds the displayed form to the source that actually runs. */
export type RunLocalSkillTrial = (source: 'user-dsh' | 'user-agents', name: string, inputJson: string,
  expectedArtifactDigest?: string) => Promise<LocalTrialResult>

/** Ordinary controls use the source schema; developer JSON is never the default input. */
export function LocalSkillTrial({ source, name, run, load, prepare, t }: {
  source: 'user-dsh' | 'user-agents'
  name: string
  run: RunLocalSkillTrial
  load?: LoadLocalSkillTrial | undefined
  prepare?: (() => void) | undefined
  t: (key: LocalSkillKey) => string
}) {
  const [open, setOpen] = useState(false)
  const [definition, setDefinition] = useState<LocalTrialDefinition | null>(null)
  const [rule, setRule] = useState<MarketInputRule | null>(null)
  const [draft, setDraft] = useState<MarketInputDraft>('')
  const [maxLength, setMaxLength] = useState(16384)
  const [raw, setRaw] = useState('{}')
  const [advanced, setAdvanced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LocalTrialResult | null>(null)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++; setResult(null); setError(false); setBusy(false); setOpen(false)
    setDefinition(null); setRule(null); setDraft(''); setRaw('{}'); setAdvanced(false); setMaxLength(16384)
    return () => { generation.current++ }
  }, [source, name])
  useEffect(() => {
    if (!open) return
    const revision = ++generation.current
    setDefinition(null); setRule(null); setLoading(true); setLoadFailed(false); setResult(null); setError(false)
    const read = async (): Promise<void> => {
      try {
        if (load === undefined) throw new Error('local-trial-contract-unavailable')
        const value = await load(source, name)
        if (!/^sha256:[a-f0-9]{64}$/u.test(value.artifactDigest)) {
          throw new Error('local-trial-contract-invalid')
        }
        if (revision !== generation.current) return
        let inputSchema: Record<string, unknown> | null = null
        if (value.inputSchemaJson !== null) {
          if (value.inputSchemaJson.length > 16 * 1024) throw new Error('local-trial-contract-invalid')
          const parsed: unknown = JSON.parse(value.inputSchemaJson)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('local-trial-contract-invalid')
          inputSchema = parsed as Record<string, unknown>
        }
        setDefinition(value)
        const limit = inputSchema?.maxLength
        setMaxLength(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && limit <= 16384 ? limit : 16384)
        if (value.supportsLocalTrial && inputSchema?.contentSchema !== undefined) {
          try {
            const parsed = parseMarketInputRule(inputSchema.contentSchema)
            setRule(parsed); setDraft(marketInputDraft(parsed))
          } catch { /* Unsupported declarations need a real author repair, never guessed fields. */ }
        }
      } catch { if (revision === generation.current) setLoadFailed(true) }
      finally { if (revision === generation.current) setLoading(false) }
    }
    void read()
    return () => { generation.current++ }
  }, [load, name, open, source])
  const prepared = rule === null ? null : serializeMarketInput(rule, draft, maxLength)
  const trial = async (): Promise<void> => {
    if (busy || loading || definition === null || rule === null || !definition.supportsLocalTrial) return
    const input = advanced ? raw : prepared
    if (input === null) return
    const revision = ++generation.current
    setBusy(true); setResult(null); setError(false)
    try {
      JSON.parse(input)
      const next = await run(source, name, input, definition.artifactDigest)
      if (next.artifactDigest !== definition.artifactDigest || next.taskType !== definition.taskType) {
        throw new Error('local-trial-source-changed')
      }
      if (revision === generation.current) setResult(next)
    } catch { if (revision === generation.current) setError(true) }
    finally { if (revision === generation.current) setBusy(false) }
  }
  const missing = definition?.unavailableReason === 'file-trial-unavailable' ? 'trialFilesUnavailable'
    : definition?.unavailableReason === 'runtime-unavailable' ? 'trialRuntimeUnavailable' : 'trialFormMissing'
  return <div className={css.trial} data-local-skill-trial>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => { setOpen(!open) }}>{t('trialStart')}</Button>
    {open && <div className={css.body}>
      <p>{t('trialExplain')}</p>
      {loading ? <p role="status">{t('trialFormLoading')}</p> : rule === null ? <div role="alert">
        <p>{t(loadFailed ? 'trialFormUnavailable' : missing)}</p>
        <p>{t('trialFormRepair')}</p>
        {prepare !== undefined && <Button variant="outline" size="sm" onClick={prepare}>{t('trialPrepareContract')}</Button>}
      </div> : <>
        {advanced ? <label>{t('trialInput')}<textarea value={raw} maxLength={maxLength} disabled={busy}
          onChange={(event) => { setRaw(event.currentTarget.value) }} /></label>
          : <MarketInputFields rule={rule} value={draft} disabled={busy} onChange={setDraft} labels={{
            content: t('trialContent'), optional: t('trialOptional'), choose: t('trialChoose'),
            yes: t('trialYes'), no: t('trialNo'), add: t('trialAdd'), remove: t('trialRemove'),
          }} />}
        <Button variant="ghost" size="sm" disabled={busy} aria-expanded={advanced} onClick={() => {
          if (!advanced) setRaw(prepared ?? JSON.stringify(draft))
          setAdvanced(!advanced)
        }}>{t(advanced ? 'trialSimple' : 'trialAdvanced')}</Button>
        <Button size="sm" disabled={busy || (!advanced && prepared === null)}
          onClick={() => { void trial() }}>{t(busy ? 'trialRunning' : 'trialRun')}</Button>
      </>}
      {error && <p role="alert">{t('trialFailed')}</p>}
      {result !== null && <div role="status"><strong>{t('trialPassed')}</strong><pre>{result.outputJson}</pre><code>{result.artifactDigest}</code></div>}
    </div>}
  </div>
}
