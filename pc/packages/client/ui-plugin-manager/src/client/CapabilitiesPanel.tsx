/**
 * 我的能力: the declarations installed on this computer and the four-step publish wizard.
 *
 * Nothing here calls a host context. Every fact and every action arrives through props, so the
 * wizard's steps, the numbers and the visibility rules can be rendered and asserted without a
 * running host.
 */
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CapabilitiesView, CapabilityMetric, CapabilityMetricReason, CapabilityNotice, CapabilityVisibility, CapabilityWizardStep,
  MyCapability,
} from './capabilities-controller.ts'
import type { CapabilityKey } from './capability-locales.ts'
import { preflightReasonKeys, preflightStepKeys, type MarketplaceKey } from './marketplace-locales.ts'
import type { PreflightReportView } from './marketplace-controller.ts'
import css from './CapabilitiesPanel.module.css'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from './LocalSkillsPanel.tsx'
import { LocalPluginCandidatesPanel, type LocalPluginCandidatesPanelProps } from './LocalPluginCandidatesPanel.tsx'

/** Namespace-bound translate for this page's own copy. */
type Translate = (key: CapabilityKey, params?: Record<string, string>) => string

/** Market dictionary, for the four install checks publishing reuses. */
type MarketTranslate = (key: MarketplaceKey) => string

/** Plain data and owner actions. This component has no Host context. */
export interface CapabilitiesPanelProps {
  view: CapabilitiesView
  t: Translate
  /** Copy of the four install checks, owned by the market dictionary and reused here. */
  marketT: MarketTranslate
  ensure: () => void
  reload: () => void
  openIntakeSettings?: () => void
  open: (id: string) => void
  close: () => void
  selectStep: (step: CapabilityWizardStep) => void
  selectVisibility: (visibility: CapabilityVisibility) => void
  confirmPublic: (next: boolean) => void
  editInvite: (text: string) => void
  runPreflight: (id: string) => void
  saveDraft: (id: string) => void
  publish: (id: string) => void
  localSkills?: LocalSkillsPanelProps | undefined
  localPluginCandidates?: LocalPluginCandidatesPanelProps | undefined
}

/** The four steps' names, in the order the host names them. */
const STEP_KEYS = {
  identity: 'stepIdentity',
  'run-preflight': 'stepRunPreflight',
  'order-policy': 'stepOrderPolicy',
  publish: 'stepPublish',
} satisfies Record<CapabilityWizardStep, CapabilityKey>

/** The four visibilities, in the order the publish step offers them. */
const VISIBILITIES: readonly CapabilityVisibility[] = ['draft', 'private', 'invite', 'public']

/** One visibility's name. */
const VISIBILITY_KEYS = {
  draft: 'visibilityDraft',
  private: 'visibilityPrivate',
  invite: 'visibilityInvite',
  public: 'visibilityPublic',
} satisfies Record<CapabilityVisibility, CapabilityKey>

/** What each visibility does with the declaration, said where the owner chooses it. */
const VISIBILITY_NOTES = {
  draft: 'visibilityLocalNote',
  private: 'visibilityPrivateNote',
  invite: 'visibilityInviteNote',
  public: 'visibilityPublicNote',
} satisfies Record<CapabilityVisibility, CapabilityKey>

/** The order policy's three modes. */
const ORDER_MODE_KEYS = {
  off: 'orderOff',
  idle: 'orderIdle',
  allowed: 'orderAllowed',
} satisfies Record<'off' | 'idle' | 'allowed', CapabilityKey>

/** Why this computer has no number for one measurement. */
const UNKNOWN_REASON_KEYS = {
  'no-local-sample': 'metricUnknownNoLocalSample',
  'not-probed': 'metricUnknownNotProbed',
} satisfies Record<CapabilityMetricReason, CapabilityKey>

/** The unit one measured number is shown in. */
type MetricUnit = 'percent' | 'ms' | 'gib'

/** The dictionary key of each unit's template. */
const UNIT_KEYS = { percent: 'metricPercent', ms: 'metricMs', gib: 'metricGib' } satisfies Record<MetricUnit, CapabilityKey>

/** Bytes in one gibibyte, the unit every byte count on this page is shown in. */
const GIB = 1024 ** 3

/**
 * The number a measured value shows, in its unit.
 * A success rate is the share of this capability's local runs that finished, so it reads as a
 * percentage; a latency is already milliseconds; a byte count reads in gibibytes.
 * @param value - Value the host measured.
 * @param unit - Unit the page shows it in.
 * @returns The formatted number, without its unit.
 */
function measuredNumber(value: number, unit: MetricUnit): string {
  if (unit === 'percent') return String(Math.round(value * 1_000) / 10)
  if (unit === 'ms') return String(Math.round(value))
  return (value / GIB).toFixed(1)
}

/** One number this computer measured, or the word for a number it never measured. */
function MetricValue({ metric, unit, t }: {
  readonly metric: CapabilityMetric
  readonly unit: MetricUnit
  readonly t: Translate
}) {
  if (metric.state === 'measured') return t(UNIT_KEYS[unit], { value: measuredNumber(metric.value, unit) })
  return (
    <>
      <span>{t('metricUnknown')}</span>{' '}
      <span className={css.metricReason}>{t(UNKNOWN_REASON_KEYS[metric.reason])}</span>
    </>
  )
}

/**
 * The title or one-liner of one declaration.
 * The host translates the ids its own catalog carries; an id this client knows reads from the
 * market dictionary instead, the same way the market page words its own rows.
 * @param id - Market listing id of the declaration.
 * @param kind - Which half of the row to read.
 * @param fallback - Text the host supplied.
 * @param marketT - Market dictionary.
 * @returns The text to show.
 */
function capabilityLine(id: string, kind: 'title' | 'summary', fallback: string, marketT: MarketTranslate): string {
  if (id === 'qianshou.article') return marketT(kind === 'title' ? 'articleTitle' : 'articleSummary')
  if (id === 'qianshou.image') return marketT(kind === 'title' ? 'imageTitle' : 'imageSummary')
  return fallback
}

/** The sentence one finished write shows. */
function noticeLine(notice: CapabilityNotice, t: Translate): string {
  if (notice.kind === 'draftSaved') return t('saveDraftDone')
  if (notice.kind === 'supplySaved') return t(notice.enabled ? 'supplySavedOn' : 'supplySavedOff')
  return t('publishDone', { visibility: t(VISIBILITY_KEYS[notice.visibility]) })
}

/**
 * The four checks as the host reported them: the step, whether it passed, and — for a step that
 * did not — the reason and the facts behind it. The market page renders the same report.
 */
function CheckReport({ report, marketT }: {
  readonly report: PreflightReportView
  readonly marketT: MarketTranslate
}) {
  return (
    <div className={css.report}>
      <h5>{marketT('preflightTitle')}</h5>
      <ol className={css.checkSteps}>
        {report.steps.map((step) => {
          const stepKey = preflightStepKeys[step.id]
          const reasonKey = preflightReasonKeys[step.reason]
          return (
            <li key={step.id} className={css[step.state]} data-check-state={step.state}>
              <span className={css.checkName}>{stepKey === undefined ? step.id : marketT(stepKey)}</span>
              <span className={css.checkState}>
                {marketT(step.state === 'passed' ? 'stepPassed' : step.state === 'failed' ? 'stepFailed' : 'stepNotChecked')}
              </span>
              {step.state !== 'passed'
                && <span className={css.checkReason}>{reasonKey === undefined ? step.reason : marketT(reasonKey)}</span>}
              {step.detail !== '' && <code className={css.checkDetail}>{step.detail}</code>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** One wizard step's own body: what it shows, and the one write it offers. */
function WizardStep({
  item, view, t, marketT, selectVisibility, confirmPublic, editInvite, runPreflight, saveDraft, publish,
}: {
  readonly item: MyCapability
  readonly view: CapabilitiesView
  readonly t: Translate
  readonly marketT: MarketTranslate
  readonly selectVisibility: (visibility: CapabilityVisibility) => void
  readonly confirmPublic: (next: boolean) => void
  readonly editInvite: (text: string) => void
  readonly runPreflight: (id: string) => void
  readonly saveDraft: (id: string) => void
  readonly publish: (id: string) => void
}) {
  const id = item.record.id
  const busy = view.busy !== null
  const draft = (
    <div className={css.actions}>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => { saveDraft(id) }}>{t('saveDraft')}</Button>
    </div>
  )
  if (view.step === 'run-preflight') {
    return (
      <>
        <p className={css.note}>{t('preflightNote')}</p>
        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { runPreflight(id) }}>
            {t(view.busy === 'preflight' ? 'preflightRunning' : 'preflightRun')}
          </Button>
        </div>
        {view.report === null ? <p className={css.note}>{t('preflightNone')}</p> : <CheckReport report={view.report} marketT={marketT} />}
        {draft}
        <p className={css.note}>{t('draftOnlyNote')}</p>
      </>
    )
  }
  if (view.step === 'order-policy') {
    const invited = view.visibility === 'invite'
    return (
      <>
        <h5 className={css.stepTitle}>{t('orderTitle')}</h5>
        <dl className={css.facts}>
          <dt>{t('orderMode')}</dt>
          <dd>{view.order === null ? t('orderUnknown') : t(ORDER_MODE_KEYS[view.order.mode])}</dd>
          {view.order === null ? null : <><dt>{t('orderConcurrency')}</dt><dd>{String(view.order.maxConcurrency)}</dd></>}
        </dl>
        <label className={css.invite}>
          <span className={css.inviteName}>{t('inviteLabel')}</span>
          <textarea
            className={css.inviteField}
            data-capability-invite
            aria-label={t('inviteLabel')}
            placeholder={t('invitePlaceholder')}
            value={view.inviteText}
            disabled={!invited || busy}
            onChange={(event) => { editInvite(event.currentTarget.value) }}
          />
        </label>
        <p className={css.note}>{t(invited ? 'inviteNote' : 'inviteLocked')}</p>
        {draft}
        <p className={css.note}>{t('draftOnlyNote')}</p>
      </>
    )
  }
  if (view.step === 'publish') {
    const unconfirmedPublic = view.visibility === 'public' && !view.confirmed
    return (
      <>
        <fieldset className={css.visibility} aria-label={t('visibilityTitle')} data-capability-visibility-group>
          <legend className={css.stepTitle}>{t('visibilityTitle')}</legend>
          {VISIBILITIES.map(visibility => (
            <label key={visibility} className={css.visibilityRow}>
              <input
                type="radio"
                name="qianshou-capability-visibility"
                value={visibility}
                checked={view.visibility === visibility}
                disabled={busy}
                data-capability-visibility={visibility}
                onChange={() => { selectVisibility(visibility) }}
              />
              <span>{t(VISIBILITY_KEYS[visibility])}</span>
            </label>
          ))}
        </fieldset>
        <p className={css.note}>{t(VISIBILITY_NOTES[view.visibility])}</p>
        {view.visibility === 'invite' ? <p className={css.note}>{t('inviteNote')}</p> : null}
        {view.visibility === 'public' ? <>
          <Checkbox checked={view.confirmed} disabled={busy} label={t('confirmPublicLabel')} onChange={confirmPublic} />
          <p className={css.note}>{t('confirmPublicNote')}</p>
        </> : null}
        <div className={css.actions}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !item.advertisable || unconfirmedPublic}
            onClick={() => { publish(id) }}
          >
            {t(view.busy === 'publish' ? 'publishing' : 'publish')}
          </Button>
        </div>
        {item.advertisable ? null : <p className={css.refusal} role="note">{t('publishRefused')}</p>}
        {unconfirmedPublic && item.advertisable ? <p className={css.note}>{t('publishNeedsConfirm')}</p> : null}
      </>
    )
  }
  return (
    <>
      <h5 className={css.stepTitle}>{t('stepIdentity')}</h5>
      <p className={css.note}>{t('identityNote')}</p>
      {draft}
      <p className={css.note}>{t('draftOnlyNote')}</p>
    </>
  )
}

/** The publish wizard: the four steps in the host's order, the current one open. */
function PublishWizard({
  item, view, t, marketT, selectStep, selectVisibility, confirmPublic, editInvite, runPreflight, saveDraft, publish,
}: {
  readonly item: MyCapability
  readonly view: CapabilitiesView
  readonly t: Translate
  readonly marketT: MarketTranslate
  readonly selectStep: (step: CapabilityWizardStep) => void
  readonly selectVisibility: (visibility: CapabilityVisibility) => void
  readonly confirmPublic: (next: boolean) => void
  readonly editInvite: (text: string) => void
  readonly runPreflight: (id: string) => void
  readonly saveDraft: (id: string) => void
  readonly publish: (id: string) => void
}) {
  const steps = view.wizardSteps
  const at = steps.indexOf(view.step ?? 'identity')
  return (
    <section className={css.wizard} data-capability-wizard>
      <div className={css.wizardHeading}>
        <h4 className={css.wizardTitle}>{t('wizardTitle')}</h4>
        <p className={css.note}>{t('wizardIntro')}</p>
      </div>
      <ol className={css.stepList} aria-label={t('stepListLabel')}>
        {steps.map((step, index) => (
          <li key={step} data-capability-step={step} data-step-state={step === view.step ? 'current' : 'other'}>
            <Button
              variant={step === view.step ? 'primary' : 'ghost'}
              size="sm"
              aria-current={step === view.step ? 'step' : undefined}
              onClick={() => { selectStep(step) }}
            >
              {`${String(index + 1)}. ${t(STEP_KEYS[step])}`}
            </Button>
          </li>
        ))}
      </ol>
      <div className={css.stepBody} data-capability-step-body={view.step ?? ''}>
        <WizardStep
          item={item}
          view={view}
          t={t}
          marketT={marketT}
          selectVisibility={selectVisibility}
          confirmPublic={confirmPublic}
          editInvite={editInvite}
          runPreflight={runPreflight}
          saveDraft={saveDraft}
          publish={publish}
        />
      </div>
      <div className={css.stepNavigation}>
        <Button
          variant="outline"
          size="sm"
          disabled={at <= 0}
          onClick={() => { const previous = steps[at - 1]; if (previous !== undefined) selectStep(previous) }}
        >
          {t('stepBack')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={at < 0 || at >= steps.length - 1}
          onClick={() => { const next = steps[at + 1]; if (next !== undefined) selectStep(next) }}
        >
          {t('stepNext')}
        </Button>
      </div>
    </section>
  )
}

/** One declaration: its facts, the numbers this computer measured, and its wizard when it is open. */
function CapabilityCard({
  item, view, t, marketT, open, close, selectStep, selectVisibility, confirmPublic, editInvite, runPreflight, saveDraft, publish,
}: {
  readonly item: MyCapability
  readonly view: CapabilitiesView
  readonly t: Translate
  readonly marketT: MarketTranslate
  readonly open: (id: string) => void
  readonly close: () => void
  readonly selectStep: (step: CapabilityWizardStep) => void
  readonly selectVisibility: (visibility: CapabilityVisibility) => void
  readonly confirmPublic: (next: boolean) => void
  readonly editInvite: (text: string) => void
  readonly runPreflight: (id: string) => void
  readonly saveDraft: (id: string) => void
  readonly publish: (id: string) => void
}) {
  const { record } = item
  const selected = view.selectedId === record.id
  const title = capabilityLine(record.id, 'title', item.title, marketT)
  return (
    <article
      className={css.card}
      data-capability-card={record.id}
      data-capability-advertisable={String(item.advertisable)}
      data-capability-selected={String(selected)}
    >
      <div className={css.cardTop}>
        <span className={css.tile} aria-hidden="true">{title.slice(0, 1)}</span>
        <div className={css.cardHeading}>
          <h3 className={css.cardTitle}>{title}</h3>
          <span>{record.version}</span>
        </div>
      </div>
      <p className={css.cardSummary}>{capabilityLine(record.id, 'summary', item.summary, marketT)}</p>
      <p className={css.availability} data-capability-availability>
        {t(item.advertisable ? 'advertisable' : 'notAdvertisable')}
      </p>
      <p className={css.supplyDetail} role="note">{t('supplyServiceUnknown')}</p>
      <div className={css.cardDetails}>
        <dl className={css.facts}>
          <dt>{t('recordId')}</dt><dd>{record.id}</dd>
          <dt>{t('capabilityId')}</dt><dd>{record.capabilityId}</dd>
          <dt>{t('version')}</dt><dd>{record.version}</dd>
          <dt>{t('installedAt')}</dt><dd>{record.installedAt}</dd>
          <dt>{t('visibilityLabel')}</dt>
          <dd data-capability-record-visibility={record.visibility}>{t(VISIBILITY_KEYS[record.visibility])}</dd>
          <dt>{t('inviteCount')}</dt><dd>{String(record.inviteAccountIds.length)}</dd>
        </dl>
        <div className={css.measurements}>
          <h5 className={css.stepTitle}>{t('metricsTitle')}</h5>
          <dl className={css.metrics} data-capability-metrics>
            <dt>{t('metricSuccessRate')}</dt>
            <dd data-metric="success-rate"><MetricValue metric={item.metrics.successRate} unit="percent" t={t} /></dd>
            <dt>{t('metricP95')}</dt>
            <dd data-metric="p95-latency"><MetricValue metric={item.metrics.p95LatencyMs} unit="ms" t={t} /></dd>
            <dt>{t('metricVram')}</dt>
            <dd data-metric="vram"><MetricValue metric={item.metrics.vramBytes} unit="gib" t={t} /></dd>
            <dt>{t('metricFreeDisk')}</dt>
            <dd>{t('metricGib', { value: measuredNumber(item.freeDiskBytes, 'gib') })}</dd>
            <dt>{t('metricTotalMemory')}</dt>
            <dd>{t('metricGib', { value: measuredNumber(item.totalMemoryBytes, 'gib') })}</dd>
          </dl>
        </div>
      </div>
      <div className={css.cardFoot}>
        <Button
          variant={selected ? 'primary' : 'outline'}
          size="sm"
          aria-expanded={selected}
          onClick={() => { if (selected) close(); else open(record.id) }}
        >
          {t(selected ? 'wizardClose' : 'wizardOpen')}
        </Button>
      </div>
      {selected
        ? (
          <PublishWizard
            item={item}
            view={view}
            t={t}
            marketT={marketT}
            selectStep={selectStep}
            selectVisibility={selectVisibility}
            confirmPublic={confirmPublic}
            editInvite={editInvite}
            runPreflight={runPreflight}
            saveDraft={saveDraft}
            publish={publish}
          />
        )
        : null}
    </article>
  )
}

/**
 * Show the declarations installed here, their visibility, their measured numbers and the publish wizard.
 * @param props - Page state and owner actions.
 * @returns The 我的能力 page.
 */
export function CapabilitiesPanel({
  view, t, marketT, reload, openIntakeSettings, open, close, selectStep, selectVisibility, confirmPublic, editInvite,
  runPreflight, saveDraft, publish, localSkills, localPluginCandidates,
}: CapabilitiesPanelProps) {
  return (
    <section className={css.panel} data-qianshou-capabilities>
      <div className={css.intro}>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.lead}>{t('description')}</p>
        </div>
        {view.loaded && <span className={css.count}>{t('count', { count: String(view.capabilities.length) })}</span>}
      </div>
      {localSkills !== undefined && <LocalSkillsPanel {...localSkills} />}
      {localPluginCandidates !== undefined && <LocalPluginCandidatesPanel {...localPluginCandidates} />}
      {view.loading ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {view.notice === null ? null : <p className={css.status} role="status">{noticeLine(view.notice, t)}</p>}
      {view.error === null
        ? null
        : (
          <div className={css.failure} role="alert">
            <p className={css.note}>{t(view.error)}</p>
            <Button variant="outline" size="sm" onClick={() => { reload() }}>{t('retry')}</Button>
          </div>
        )}
      {view.loaded && !view.loading && view.error === null && view.capabilities.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : null}
      <section className={css.supplyOverview} aria-label={t('supplyTitle')} data-owner-supply={view.order?.mode ?? 'unknown'}>
        <div className={css.supplySummary}>
          <div className={css.supplyHeading}>
            <h3>{t('supplyTitle')}</h3>
            <span className={css.supplyState}>{view.order === null ? t('orderUnknown') : t(ORDER_MODE_KEYS[view.order.mode])}</span>
          </div>
          <p className={css.note}>{t('supplyPolicyNote')}</p>
          {view.order !== null && view.order.mode !== 'off' && view.order.enabledServiceCount === 0
            ? <p className={css.supplyEmpty} role="status">{t('supplyNoServices')}</p> : null}
        </div>
        {openIntakeSettings === undefined ? null : <button type="button" className={css.supplyLink} onClick={openIntakeSettings}>{t('openIntakeSettings')} <span aria-hidden="true">→</span></button>}
      </section>
      <div className={css.grid}>
        {view.capabilities.map(item => (
          <CapabilityCard
            key={item.record.id}
            item={item}
            view={view}
            t={t}
            marketT={marketT}
            open={open}
            close={close}
            selectStep={selectStep}
            selectVisibility={selectVisibility}
            confirmPublic={confirmPublic}
            editInvite={editInvite}
            runPreflight={runPreflight}
            saveDraft={saveDraft}
            publish={publish}
          />
        ))}
      </div>
      <p className={css.authority}>{t('authority')}</p>
    </section>
  )
}
