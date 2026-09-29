/** Qianshou market. Device inspection is a separate, read-only step before installation. */
import { useEffect, useRef, useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { CommunityDiscoveryPanel, type CommunityDiscoveryPanelProps } from './CommunityDiscoveryPanel.tsx'
import { SessionSkillsPanel } from './SessionSkillsPanel.tsx'
import { SkillImportPanel } from './SkillImportPanel.tsx'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from './LocalSkillsPanel.tsx'
import { OrderProductsPanel, type OrderProductsPanelProps } from './OrderProductsPanel.tsx'
import { MarketCapabilitiesPanel } from './MarketCapabilitiesPanel.tsx'
import { MarketplaceWorkspace } from './MarketplaceWorkspace.tsx'
import type { MarketCapabilitiesView } from './market-capabilities-controller.ts'
import type { SessionSkillsView } from './session-skills-controller.ts'
import type { SkillImportView } from './skill-import-controller.ts'
import type { MarketplacePublicationRequest } from './marketplace-navigation-contract.ts'
import type { EnterMarketConversation } from './market-conversation-entry.ts'
import type { VideoWorkflowDraftTransport } from './video-workflow-authoring.ts'
import type { OrdinarySkillPublicationProps } from './OrdinarySkillPublication.tsx'
import type { MarketInstalledRecordView, MarketListingView, MarketplaceView, PreflightReportView } from './marketplace-controller.ts'
import { preflightActionKeys, preflightReasonKeys, preflightStepKeys, type MarketplaceKey } from './marketplace-locales.ts'
import css from './MarketplacePanel.module.css'

/** Plain data and owner actions. This component has no Host context. */
export interface MarketplacePanelProps {
  view: MarketplaceView
  t: (key: MarketplaceKey) => string
  ensure: () => void
  reload: () => void
  inspect: (id: string) => void
  install: (id: string) => void
  recheck: (id: string) => void
  repair: (id: string) => void
  rollback: (id: string) => void
  dismiss: () => void
  /** Open the skill creator and seed its editable first message. */
  startSkillCreator?: () => Promise<boolean>
  /** Saves a real graph only as a private owner-local design; never publishes it. */
  videoWorkflowDrafts?: VideoWorkflowDraftTransport | undefined
  /** Actual ordinary SKILL.md submissions and Guangzhou's staff-reviewed priced catalog. */
  ordinarySkills?: OrdinarySkillPublicationProps | undefined
  /** Open the Host-owned package install dialog, which checks Git links before installing. */
  openPackageInstall?: () => void
  /** Public registry results stay separate from the curated device catalog. */
  community?: Omit<CommunityDiscoveryPanelProps, 'query'>
  /** Only skills callable by the selected Session, never market installation records. */
  sessionSkills?: { view: SessionSkillsView; reload: () => Promise<void>; useSkill: (name: string) => boolean }
  /** Skills physically saved in the two user roots, separate from market declarations. */
  localSkills?: LocalSkillsPanelProps
  /** Independently reviewed executable goods; no legacy market declaration implies purchase rights. */
  orderProducts?: OrderProductsPanelProps
  marketCapabilities?: { view: MarketCapabilitiesView; reload: () => void; enterConversation?: EnterMarketConversation | undefined }
  openPluginManagement?: (() => void) | undefined
  openCapabilityManagement?: (() => void) | undefined
  /** Plain owner request and acknowledgement; navigation never publishes or installs a skill. */
  publicationsNavigation?: { readonly request: MarketplacePublicationRequest | null; readonly consume: (id: number) => boolean }
  /** A local SKILL.md is reviewed by the Host before a separate explicit write. */
  skillImport?: { view: SkillImportView
    inspectFile: (file: File) => void
    install: () => void
    checkWrite: () => void
    dismiss: () => void }
}

type MarketCategory = 'all' | 'text' | 'image' | 'audio' | 'video' | 'code' | 'data' | 'other'

const MARKET_CATEGORIES: readonly Exclude<MarketCategory, 'all'>[] = ['text', 'image', 'audio', 'video', 'code', 'data', 'other']
function marketCategoryKey(category: MarketCategory): MarketplaceKey {
  return `category${category.charAt(0).toUpperCase()}${category.slice(1)}` as MarketplaceKey
}

function categoryOf(listing: MarketListingView): Exclude<MarketCategory, 'all'> {
  const prefix = listing.capabilityId.split('.', 1)[0]?.toLowerCase()
  if (prefix === 'text' || prefix === 'image' || prefix === 'audio' || prefix === 'video'
    || prefix === 'code' || prefix === 'data') return prefix
  if (prefix === 'media') return 'video'
  return 'other'
}

function listingText(id: string, kind: 'title' | 'summary', fallback: string, t: MarketplacePanelProps['t']): string {
  if (id === 'qianshou.article') return t(kind === 'title' ? 'articleTitle' : 'articleSummary')
  if (id === 'qianshou.image') return t(kind === 'title' ? 'imageTitle' : 'imageSummary')
  return fallback
}

function sizeLabel(bytes: number, t: MarketplacePanelProps['t']): string {
  if (bytes <= 0) return t('notRequired')
  const gib = 1024 ** 3
  if (bytes >= gib) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / gib)} GB`
  return `${Math.ceil(bytes / (1024 ** 2))} MB`
}

function kindLabel(listing: MarketListingView, t: MarketplacePanelProps['t']): string {
  return listing.packageSpec === '' ? t('declarationOnly') : t('pluginPackage')
}

function isCurrentInstall(listing: MarketListingView, record: MarketInstalledRecordView | undefined): boolean {
  return record !== undefined && record.version === listing.version && record.capabilityId === listing.capabilityId
}

function platformLabel(value: string, t: MarketplacePanelProps['t']): string {
  return value === 'darwin' ? t('platformMac') : value === 'win32' ? t('platformWindows')
    : value === 'linux' ? t('platformLinux') : value
}

/** Owner actions the report offers, by the action id the host reported. */
const ACTION_HANDLERS: Record<string, ((id: string, props: PreflightProps) => void) | undefined> = {
  fix: (id, props) => { props.repair(id) },
  recheck: (id, props) => { props.recheck(id) },
  cancel: (_id, props) => { props.dismiss() },
  rollback: (id, props) => { props.rollback(id) },
}

interface PreflightProps {
  t: MarketplacePanelProps['t']
  recheck: (id: string) => void
  repair: (id: string) => void
  rollback: (id: string) => void
  dismiss: () => void
}

/** Ship the report as plain rows so the panel renders data, not host objects. */
function Preflight({ report, working, t, recheck, repair, rollback, dismiss }: PreflightProps & {
  report: PreflightReportView
  working: boolean
}) {
  const props: PreflightProps = { t, recheck, repair, rollback, dismiss }
  return <div className={css.preflight}>
    <div className={css.preflightHead}>
      <h4>{t('preflightTitle')}</h4>
      <span className={report.verdict === 'passed' ? css.passMark : css.failMark}>
        {t(report.verdict === 'passed' ? 'checkPassed' : 'stepFailed')}
      </span>
    </div>
    <ol className={css.steps} aria-label={t('preflightTitle')}>{report.steps.map((step) => {
      const stepKey = preflightStepKeys[step.id]
      const reasonKey = preflightReasonKeys[step.reason]
      return <li key={step.id} className={css[step.state]}>
        <span className={css.stepName}>{stepKey === undefined ? step.id : t(stepKey)}</span>
        <span className={css.stepState}>{t(step.state === 'passed'
          ? 'stepPassed'
          : step.state === 'failed' ? 'stepFailed' : 'stepNotChecked')}</span>
        {step.state !== 'passed'
          && <span className={css.reason}>{reasonKey === undefined ? step.reason : t(reasonKey)}</span>}
        {step.detail !== '' && <code className={css.detail}>{step.detail}</code>}
      </li>
    })}</ol>
    {report.compatibility !== undefined && <dl className={css.compatibility}>
      <dt>{t('platformRequirement')}</dt>
      <dd>{platformLabel(report.compatibility.platform.observed, t)} · {t(`compat${report.compatibility.platform.state}`)}</dd>
      <dt>{t('architectureRequirement')}</dt>
      <dd>{report.compatibility.architecture.observed} · {t(`compat${report.compatibility.architecture.state}`)}</dd>
      <dt>{t('gpuRequirement')}</dt><dd>{t('gpuNotProbed')}</dd>
    </dl>}
    <div className={css.actions}>{report.actions.map((action) => {
      const handler = ACTION_HANDLERS[action]
      const label = preflightActionKeys[action]
      // An action this client has no handler for is not offered at all, rather than shown inert.
      if (handler === undefined) return null
      return <Button key={action} size="sm" disabled={working}
        onClick={() => { handler(report.listingId, props) }}>{label === undefined ? action : t(label)}</Button>
    })}</div>
  </div>
}

/**
 * Show actual catalog facts and require a read-only device check before Get.
 * @param props - Market state and owner actions.
 * @returns The market list.
 */
function LegacyMarketplacePanel({ view, t, reload, inspect, install, recheck, repair, rollback, dismiss,
  startSkillCreator, openPackageInstall, community, sessionSkills, localSkills, orderProducts, marketCapabilities, skillImport,
  maintenanceOnly = false, onOpenMaintenance }: MarketplacePanelProps & {
    maintenanceOnly?: boolean
    onOpenMaintenance?: () => void
  }) {
  const [query, setQuery] = useState('')
  const skillFileInput = useRef<HTMLInputElement>(null)
  const [verifiedImportId, setVerifiedImportId] = useState<string | null>(null)
  const [tab, setTab] = useState<'market' | 'localSkills' | 'skills' | 'installed' | 'orderProducts' | 'capabilities'>(marketCapabilities ? 'capabilities' : 'market')
  const [focusProductId, setFocusProductId] = useState<string | null>(null)
  const [focusTaskType, setFocusTaskType] = useState<string | null>(null)
  const [focusGoal, setFocusGoal] = useState('')
  useEffect(() => {
    const open = (detail: unknown): void => {
      if (detail === null || typeof detail !== 'object') return
      if ((detail as { browse?: unknown }).browse === true) {
        if (maintenanceOnly) return
        setSelectedId(null)
        setFocusTaskType(null)
        setFocusGoal('')
        setTab('capabilities')
        marketCapabilities?.reload()
        return
      }
      const taskType = (detail as { taskType?: unknown }).taskType
      if (typeof taskType === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u.test(taskType)) {
        if (maintenanceOnly) return
        const goal = (detail as { goal?: unknown }).goal
        setSelectedId(null)
        setFocusTaskType(taskType)
        setFocusGoal(typeof goal === 'string' && goal.length <= 8000 ? goal : '')
        setTab('capabilities')
        marketCapabilities?.reload()
        return
      }
      const skillId = (detail as { skillId?: unknown }).skillId
      if (typeof skillId === 'string' && /^[\w:./-]{1,160}$/u.test(skillId) && !skillId.includes('://')) {
        onOpenMaintenance?.()
        setSelectedId(null)
        setQuery(skillId)
        setTab('market')
        reload()
        return
      }
      const id = (detail as { productId?: unknown }).productId
      if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) return
      onOpenMaintenance?.()
      setSelectedId(null)
      setFocusProductId(id)
      setTab('orderProducts')
      orderProducts?.reload()
    }
    try {
      const saved = sessionStorage.getItem('qianshou:market-focus')
      if (saved !== null) {
        const parsed: unknown = JSON.parse(saved)
        if (parsed !== null && typeof parsed === 'object') {
          const focus = parsed as { kind?: unknown; id?: unknown; taskType?: unknown; goal?: unknown }
          if (focus.kind === 'product') open({ productId: focus.id })
          if (focus.kind === 'skill') open({ skillId: focus.id })
          if (focus.kind === 'capability') open({ taskType: focus.taskType, goal: focus.goal })
          if (focus.kind === 'browse') open({ browse: true })
          if (!maintenanceOnly || focus.kind === 'product' || focus.kind === 'skill') {
            sessionStorage.removeItem('qianshou:market-focus')
          }
        }
      }
    } catch { /* Storage can be unavailable in an embedded client. Live events still work. */ }
    const listener = (event: Event): void => {
      if (event instanceof CustomEvent) {
        open(event.detail)
        try { sessionStorage.removeItem('qianshou:market-focus') } catch { /* Storage may be unavailable. */ }
      }
    }
    window.addEventListener('qianshou:open-market-item', listener)
    return () => { window.removeEventListener('qianshou:open-market-item', listener) }
  }, [orderProducts?.reload, marketCapabilities?.reload, reload, maintenanceOnly, onOpenMaintenance])
  const [category, setCategory] = useState<MarketCategory>('all')
  const [availableOnly, setAvailableOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creatorBusy, setCreatorBusy] = useState(false)
  const [creatorUnavailable, setCreatorUnavailable] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const working = view.workingId !== null
  const selected = view.listings.find(item => item.id === selectedId)
  const normalized = query.trim().toLocaleLowerCase()
  const savedById = new Map(view.installedRecords.map(record => [record.id, record]))
  const listedIds = new Set(view.listings.map(item => item.id))
  const availableCategories = new Set(view.listings.map(categoryOf))
  const categories = MARKET_CATEGORIES.filter(value => availableCategories.has(value))
  const results = view.listings.filter((item) => {
    const saved = savedById.get(item.id)
    if (tab === 'installed' && saved === undefined) return false
    if (tab === 'market' && availableOnly && (!item.installable || isCurrentInstall(item, saved))) return false
    if (tab === 'market' && category !== 'all' && categoryOf(item) !== category) return false
    if (normalized === '') return true
    return [item.title, item.summary, item.capabilityId, item.id, saved?.capabilityId ?? '',
      listingText(item.id, 'title', item.title, t), listingText(item.id, 'summary', item.summary, t),
      t(marketCategoryKey(categoryOf(item)))]
      .some(value => value.toLocaleLowerCase().includes(normalized))
  })
  const delistedRecords = tab === 'installed'
    ? view.installedRecords.filter(record => !listedIds.has(record.id)
      && (normalized === '' || [record.id, record.capabilityId]
        .some(value => value.toLocaleLowerCase().includes(normalized))))
    : []
  const resultCount = results.length + delistedRecords.length
  const report = selected === undefined || view.report?.listingId !== selected.id ? null : view.report
  const selectedRecord = selected === undefined ? undefined : savedById.get(selected.id)
  const installed = selected !== undefined && isCurrentInstall(selected, selectedRecord)
  const needsUpdate = selectedRecord !== undefined && !installed
  const checking = selected !== undefined && view.workingId === selected.id
  const busy = selected !== undefined && view.busyId === selected.id
  const canInstall = selected !== undefined && selected.installable && !installed && report?.verdict === 'passed'
  const guideStep = installed || report?.verdict === 'passed' ? 3 : 2
  const createFromConversation = (start: (() => Promise<boolean>) | undefined): void => {
    if (start === undefined) return
    setNewMenuOpen(false)
    setCreatorBusy(true)
    setCreatorUnavailable(false)
    void start().then((started) => { setCreatorUnavailable(!started) })
      .catch(() => { setCreatorUnavailable(true) })
      .finally(() => { setCreatorBusy(false) })
  }
  return <section className={css.panel} data-qianshou-plugin-market>
    {selected === undefined ? (
      <div className={css.marketHeader}>
        <div className={css.marketTabs} role="tablist" aria-label={t('title')}>
          <button type="button" role="tab" aria-selected={tab === 'market'}
            className={tab === 'market' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('market') }}>{t(maintenanceOnly ? 'maintenanceCatalogTab' : 'marketTab')}</button>
          {localSkills !== undefined && <button type="button" role="tab" aria-selected={tab === 'localSkills'}
            className={tab === 'localSkills' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('localSkills'); void localSkills.reload() }}>{localSkills.t('title')}</button>}
          {sessionSkills !== undefined && <button type="button" role="tab" aria-selected={tab === 'skills'}
            className={tab === 'skills' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('skills'); void sessionSkills.reload() }}>{t('skillsTab')}</button>}
          <button type="button" role="tab" aria-selected={tab === 'installed'}
            className={tab === 'installed' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('installed') }}>{t('installedTab')}</button>
          {marketCapabilities !== undefined && <button type="button" role="tab" aria-selected={tab === 'capabilities'}
            className={tab === 'capabilities' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('capabilities'); marketCapabilities.reload() }}>{t('capabilitiesTab')}</button>}
          {orderProducts !== undefined && <button type="button" role="tab" aria-selected={tab === 'orderProducts'}
            className={tab === 'orderProducts' ? css.marketTabActive : css.marketTabMuted}
            onClick={() => { setTab('orderProducts'); orderProducts.reload() }}>{t('orderProductsTab')}</button>}
        </div>
        <div className={css.marketActions}>
          {(tab === 'market' || tab === 'installed') && <label className={css.compactSearch}>
            <span>{t('searchLabel')}</span>
            <input type="search" value={query} placeholder={t('searchPlaceholder')}
              onChange={(event) => { setQuery(event.currentTarget.value) }} />
          </label>}
          {(tab === 'market' || tab === 'installed') && query !== '' && <button type="button" className={css.clearSearch}
            onClick={() => { setQuery('') }}>{t('clearSearch')}</button>}
          {maintenanceOnly && <Button variant="outline" size="sm" onClick={reload}>{t('maintenanceRefresh')}</Button>}
          {!maintenanceOnly && <Menu
            open={newMenuOpen}
            onClose={() => { setNewMenuOpen(false) }}
            portal
            align="end"
            side="bottom"
            items={[
              { id: 'skill-creator', label: t('skillCreatorStart'), disabled: startSkillCreator === undefined || creatorBusy },
              ...skillImport === undefined ? [] : [{ id: 'upload-skill', label: t('uploadSkill'),
                disabled: ['installing', 'verifying', 'unconfirmed'].includes(skillImport.view.status) }],
              ...openPackageInstall === undefined ? [] : [{ id: 'link', label: t('installFromLink') }],
            ]}
            onSelect={(id) => {
              if (id === 'skill-creator') createFromConversation(startSkillCreator)
              if (id === 'upload-skill') { setNewMenuOpen(false); skillFileInput.current?.click() }
              if (id === 'link') { setNewMenuOpen(false); openPackageInstall?.() }
            }}
            anchor={<button type="button" className={css.newSkill} aria-haspopup="menu" aria-expanded={newMenuOpen}
              onClick={() => { setNewMenuOpen(value => !value) }}>{t('newPlugin')}</button>}
          />}
          {skillImport !== undefined && <input ref={skillFileInput} className={css.fileInput} type="file"
            accept=".md,text/markdown" aria-label={t('uploadSkill')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) skillImport.inspectFile(file)
            }} />}
        </div>
      </div>
    ) : (
      <div className={css.intro}>
        <div>
          <p className={css.eyebrow}>{t('discovery')}</p>
          <h2>{listingText(selected.id, 'title', selected.title, t)}</h2>
          <p>{listingText(selected.id, 'summary', selected.summary, t)}</p>
        </div>
        <div className={css.introActions}>
          {view.mode !== null && <span className={css.source}>{t(view.mode === 'api' ? 'sourceApi' : 'sourceShipped')}</span>}
        </div>
      </div>
    )}
    {creatorUnavailable && <p className={css.creatorNotice} role="status">{t('creatorUnavailable')}</p>}
    {skillImport !== undefined && <SkillImportPanel view={skillImport.view} t={t}
      install={skillImport.install} checkWrite={skillImport.checkWrite} dismiss={skillImport.dismiss}
      sessionSkillsView={verifiedImportId === skillImport.view.inspection?.inspectionId ? sessionSkills?.view : undefined}
      refreshSkills={sessionSkills === undefined ? undefined : () => {
        const inspectionId = skillImport.view.inspection?.inspectionId
        if (inspectionId === undefined) return
        setVerifiedImportId(null)
        setTab('skills')
        void sessionSkills.reload().then(() => { setVerifiedImportId(inspectionId) })
      }} />}
    {(tab === 'market' || tab === 'installed') && view.loading && <p role="status">{t('loading')}</p>}
    {(tab === 'market' || tab === 'installed') && view.notice !== null && <p role="status">{t(view.notice)}</p>}
    {(tab === 'market' || tab === 'installed') && view.error !== null && (view.error !== 'preflightFailed' || view.report === null)
      && <div className={css.failure} role="alert"><p>{t(view.error)}</p>
        {view.error !== 'activationPending' && <Button onClick={() => { reload() }}>{t('retry')}</Button>}
      </div>}
    {!view.loading && view.error === null && tab === 'market' && view.listings.length === 0 && view.mode !== null && <p>{t('empty')}</p>}
    {!view.loading && view.error === null && tab === 'installed' && view.installedRecords.length === 0 && view.mode !== null && <p>{t('installedEmpty')}</p>}
    {selected === undefined && tab === 'skills' && sessionSkills !== undefined && <SessionSkillsPanel
      view={sessionSkills.view} reload={() => { void sessionSkills.reload() }}
      useSkill={sessionSkills.useSkill} localT={localSkills?.t} labels={{
        title: t('skillsTitle'), scope: t('skillsScope'), searchLabel: t('skillsSearchLabel'),
        searchPlaceholder: t('skillsSearchPlaceholder'), refresh: t('skillsRefresh'),
        loading: t('skillsLoading'), unavailable: t('skillsUnavailable'),
        noSession: t('skillsNoSession'), empty: t('skillsEmpty'), noMatches: t('skillsNoMatches'),
        count: t('skillsCount'), userOnly: t('skillsUserOnly'),
        useSkill: t('skillsUse'), useUnavailable: t('skillsUseUnavailable'), details: t('skillsDetails'),
      }} />}
    {selected === undefined && tab === 'localSkills' && localSkills !== undefined && <LocalSkillsPanel {...localSkills} />}
    {selected === undefined && tab === 'orderProducts' && orderProducts !== undefined && <OrderProductsPanel {...orderProducts} t={t} focusProductId={focusProductId} />}
    {selected === undefined && tab === 'capabilities' && marketCapabilities !== undefined && <MarketCapabilitiesPanel
      {...marketCapabilities} t={t} focusTaskType={focusTaskType} focusGoal={focusGoal} />}
    {selected === undefined && (tab === 'market' || tab === 'installed') ? <>
      {tab === 'market' && <div className={css.browseBar}>
        <label className={css.categories}>
          <span>{t('categoryLabel')}</span>
          <select value={category} onChange={(event) => { setCategory(event.currentTarget.value as MarketCategory) }}>
            {(['all', ...categories] as MarketCategory[]).map(value => <option key={value} value={value}>
              {t(marketCategoryKey(value))}
            </option>)}
          </select>
        </label>
        <div className={css.filters} role="group" aria-label={t('filterLabel')}>
          {([false, true] as const).map(value => <button type="button" key={String(value)}
            className={availableOnly === value ? css.filterActive : css.filter}
            aria-pressed={availableOnly === value} onClick={() => { setAvailableOnly(value) }}>
            {t(value ? 'filterAvailable' : 'filterAll')}
          </button>)}
        </div>
      </div>}
      <p className={css.resultCount}>{t('resultCount').replace('{count}', String(resultCount))}</p>
      {resultCount === 0 && (tab === 'market' ? view.listings.length > 0 : view.installedRecords.length > 0)
        && <p className={css.noResults}>{t('noResults')}</p>}
      <div className={css.grid}>{results.map((item) => {
        const saved = savedById.get(item.id)
        const itemInstalled = isCurrentInstall(item, saved)
        const itemNeedsUpdate = saved !== undefined && !itemInstalled
        return <article className={css.card} key={item.id}>
          <div className={css.cardTop}>
            <span className={css.tile} aria-hidden="true">{listingText(item.id, 'title', item.title, t).slice(0, 1)}</span>
            <div className={css.cardHeading}>
              <h3>{listingText(item.id, 'title', item.title, t)}</h3>
              <span>{t(marketCategoryKey(categoryOf(item)))} · {kindLabel(item, t)} · {item.version}</span>
            </div>
          </div>
          <p>{listingText(item.id, 'summary', item.summary, t)}</p>
          {itemNeedsUpdate && <p className={css.recordNote}>{t('savedRecordMismatch')
            .replace('{version}', saved.version).replace('{capability}', saved.capabilityId)}</p>}
          <div className={css.cardFoot}>
            <span className={itemInstalled ? css.goodBadge : itemNeedsUpdate ? css.warningBadge
              : item.installable ? css.neutralBadge : css.mutedBadge}>
              {t(itemInstalled ? 'installed' : itemNeedsUpdate ? 'needsUpdate' : item.installable ? 'availableHere' : 'unavailableAction')}
            </span>
            <Button variant="outline" size="sm" onClick={() => { setSelectedId(item.id) }}>{t('viewDetails')}</Button>
          </div>
        </article>
      })}{delistedRecords.map(record => <article className={css.card} key={record.id}>
        <div className={css.cardTop}>
          <span className={css.tile} aria-hidden="true">{record.id.slice(0, 1).toUpperCase()}</span>
          <div className={css.cardHeading}>
            <h3>{record.id}</h3>
            <span>{record.capabilityId} · {record.version}</span>
          </div>
        </div>
        <p>{t('delistedExplanation')}</p>
        <div className={css.cardFoot}><span className={css.mutedBadge}>{t('delisted')}</span></div>
      </article>)}</div>
      {tab === 'market' && community !== undefined && <CommunityDiscoveryPanel {...community} query={query} />}
    </> : selected !== undefined ? <>
      <div><Button variant="outline" size="sm" onClick={() => { setSelectedId(null) }}>{t('backToMarket')}</Button></div>
      <ol className={css.guide} aria-label={t('guideTitle')}>
        {(['guideUnderstand', 'guideCheck', 'guideAdd'] as const).map((step, index) => <li key={step}
          className={index + 1 < guideStep ? css.guideDone : index + 1 === guideStep ? css.guideCurrent : css.guidePending}
          aria-current={index + 1 === guideStep ? 'step' : undefined}>
          <span className={css.guideNumber}>{index + 1}</span>
          <span>{t(step)}</span>
        </li>)}
      </ol>
      <div className={css.detailLayout}>
        <div className={css.detailMain}>
          <div className={css.detailSection}>
            <h3>{t('whatItDoes')}</h3>
            <p>{listingText(selected.id, 'summary', selected.summary, t)}</p>
            <p className={css.quiet}>{selected.packageSpec === '' ? t('declarationExplanation') : t('packageExplanation')}</p>
          </div>
          <div className={css.detailSection}>
            <h3>{t('beforeAdding')}</h3>
            <div className={css.quickFacts}>
              <span>{t('platformRequirement')}<strong>{selected.requirements?.platforms?.length
                ? selected.requirements.platforms.map(value => platformLabel(value, t)).join('、') : t('notDeclared')}</strong></span>
              <span>{t('memoryRequirement')}<strong>{selected.requirements === undefined ? t('unknownFact') : sizeLabel(selected.requirements.minTotalMemoryBytes, t)}</strong></span>
              <span>{t('diskRequirement')}<strong>{selected.requirements === undefined ? t('unknownFact') : sizeLabel(selected.requirements.minFreeDiskBytes, t)}</strong></span>
            </div>
            <p className={css.quiet}>{t('requirementsHint')}</p>
            <details className={css.technicalDetails}>
              <summary>{t('technicalDetails')}</summary>
              <dl className={css.requirements}>
                <dt>{t('publisher')}</dt><dd>{selected.requirements?.signature?.publisher ?? t('unknownFact')}</dd>
                <dt>{t('capability')}</dt><dd>{selected.capabilityId}</dd>
                <dt>{t('version')}</dt><dd>{selected.version}</dd>
                <dt>{t('modelRequirement')}</dt><dd>{selected.requirements?.model || t('notRequired')}</dd>
                <dt>{t('platformRequirement')}</dt><dd>{selected.requirements?.platforms?.length
                  ? selected.requirements.platforms.map(value => platformLabel(value, t)).join('、') : t('notDeclared')}</dd>
                <dt>{t('architectureRequirement')}</dt><dd>{selected.requirements?.architectures?.length
                  ? selected.requirements.architectures.join('、') : t('notDeclared')}</dd>
                <dt>{t('gpuRequirement')}</dt><dd>{t('gpuNotProbed')}</dd>
                <dt>{t('dependencyRequirement')}</dt><dd>{selected.requirements?.packages.length
                  ? selected.requirements.packages.map(item => `${item.name}${item.minimumVersion ? ` ≥ ${item.minimumVersion}` : ''}`).join('、')
                  : t('notRequired')}</dd>
                <dt>{t('memoryRequirement')}</dt><dd>{selected.requirements === undefined ? t('unknownFact') : sizeLabel(selected.requirements.minTotalMemoryBytes, t)}</dd>
                <dt>{t('diskRequirement')}</dt><dd>{selected.requirements === undefined ? t('unknownFact') : sizeLabel(selected.requirements.minFreeDiskBytes, t)}</dd>
              </dl>
              <p className={css.quiet}>{t('requirementsScope')}</p>
            </details>
          </div>
        </div>
        <aside className={css.installBox}>
          <span className={installed ? css.goodBadge : needsUpdate ? css.warningBadge
            : selected.installable ? css.neutralBadge : css.mutedBadge}>
            {t(installed ? 'installed' : needsUpdate ? 'needsUpdate' : selected.installable ? 'availableHere' : 'unavailableAction')}
          </span>
          {needsUpdate && <p className={css.recordNote}>{t('savedRecordMismatch')
            .replace('{version}', selectedRecord.version).replace('{capability}', selectedRecord.capabilityId)}</p>}
          <h3>{t('checkThisDevice')}</h3>
          <p>{t('checkIntro')}</p>
          <Button variant="outline" size="sm" disabled={!selected.installable || working || view.busyId !== null}
            onClick={() => { inspect(selected.id) }}>{t(checking ? 'checking' : 'checkDevice')}</Button>
          {report !== null && <Preflight report={report} working={working} t={t}
            recheck={recheck} repair={repair} rollback={rollback} dismiss={dismiss} />}
          <Button variant="primary" size="sm" disabled={!canInstall || working || view.busyId !== null}
            onClick={() => { install(selected.id) }}>{t(installed ? 'installed' : busy ? 'working' : 'get')}</Button>
          <p className={css.quiet}>{t(installed ? 'installedPrivate'
            : !selected.installable ? 'notSupportedHere'
              : canInstall ? 'installAfterCheck' : needsUpdate ? 'updateCheckFirst' : 'checkFirst')}</p>
          <p className={css.quiet}>{t('rightsUnknown')}</p>
        </aside>
      </div>
    </> : null}
    {(tab === 'market' || tab === 'installed') && <p className={css.authority}>{t('authority')}</p>}
  </section>
}

/** Three business views share the live market actions; legacy installation remains in maintenance. */
export function MarketplacePanel(props: MarketplacePanelProps) {
  const { localSkills, marketCapabilities, skillImport: _skillImport,
    startSkillCreator: _startSkillCreator, openPackageInstall: _openPackageInstall, ...maintenance } = props
  if (localSkills === undefined || marketCapabilities === undefined) return <LegacyMarketplacePanel {...props} />
  return <MarketplaceWorkspace {...props} localSkills={localSkills} marketCapabilities={marketCapabilities}
    renderMaintenance={open => <LegacyMarketplacePanel {...maintenance} maintenanceOnly onOpenMaintenance={open} />} />
}
