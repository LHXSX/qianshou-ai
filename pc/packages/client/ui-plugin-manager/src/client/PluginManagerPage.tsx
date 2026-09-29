/**
 * Global plugin management: source-separated local cards, optional discovery,
 * explicit Host loading checks and inspected registry replacements,
 * their row switches, the install dialog with its guide and folded pnpm
 * output, the uninstall confirmation, and the toasts an action's outcome
 * becomes. A bundle's page lists the rows it contributes as the Host runs
 * them; a plugin's configuration renders on its own page through the slots
 * the page declares.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { PluginInstallFailureKind } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCordisPluginOutline14, IconPluginPinwheelOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16,
  IconWarningOutline16, Input, Modal, Pill, StateDot, Switch, Tag, TerminalBlock, Toast,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { rowConfigKey, type OfficialItem } from './config-ledger.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import {
  isInstallPending, rowKey,
  type ConfirmState, type InstallInputError, type InstallState, type InstallSubject, type PackageRow, type PackageView,
  type PluginManagerFace,
} from './manager-store.ts'
import { managementText, noticeText, packageRowText, packageText, type Translate } from './presentation.ts'
import type {} from './slot-contract.ts'
import css from './PluginManagerPage.module.css'
import overview from './PluginCatalogOverview.module.css'
import { PluginCatalogOverview, EnableSwitch, PackageFacts } from './PluginCatalogOverview.tsx'
import { componentSummary, listedPackages, type CatalogFilter } from './catalog-presentation.ts'
import { PluginMaintenance, UpdateReviewDialog } from './PluginMaintenance.tsx'
import type { LoadingCheck } from './loading-checks.ts'
import { MarketplacePanel, type MarketplacePanelProps } from './MarketplacePanel.tsx'
import { CapabilitiesPanel, type CapabilitiesPanelProps } from './CapabilitiesPanel.tsx'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & PropsRenderSlots<'plugins.item' | 'plugins.bundle.config' | 'plugins.row.config'>
  & InjectFace<PluginManagerFace>
  & { readonly market?: MarketplacePanelProps; readonly capabilities?: CapabilitiesPanelProps;
    readonly singleMarketplace?: boolean }

/** The catalog views the page offers: the local list, the market, and the capabilities installed here. */
type CatalogTab = 'local' | 'market' | 'capabilities'

/** The page's slot renderer, narrowed to the configuration slots. */
type RenderConfig = PluginManagerPageProps['renderSlot']

/** What the page shows: the cards, a bundle's page, an official plugin's page, or a row's configuration page. */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'row'; readonly name: string; readonly rowId: string }

type RowPhase = NonNullable<PackageRow['phase']>

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/** How long a toast holds: long enough to read a failure that names what broke. */
function toastHoldMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, text.length * 80))
}

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** Status dot naming a live root-fiber phase: pending and unloading fibers do nothing; only loading is in progress. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'idle',
} satisfies Record<RowPhase, StateDotState>

/** Switching for a pack's rows: which rows have a write in flight, and the write. */
interface RowToggles {
  readonly busy: (row: PackageRow) => boolean
  readonly onSetEnabled: (row: PackageRow, enabled: boolean) => void
}

/** Configuration for a pack's rows: which rows registered a page of their own, and opening it. */
interface RowConfigure {
  readonly has: (row: PackageRow) => boolean
  readonly open: (row: PackageRow) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** A row's switch: locked, saying why, when the Host refuses to address the row through the profile patch. */
function RowSwitch({ row, title, t, busy, onChange }: {
  readonly row: PackageRow
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  const locked = row.readOnlyReason !== undefined || row.entryId === undefined
  return (
    <Switch
      checked={row.enabled}
      label={t('partToggle', { name: title })}
      disabled={busy || locked}
      {...row.readOnlyReason === undefined ? {} : { title: managementText({ code: row.readOnlyReason }, t) }}
      onChange={onChange}
    />
  )
}

/** What a row's state line says: off, or the phase its fiber is in. */
function rowStateText(row: PackageRow, t: Translate): string {
  if (!row.enabled) return t('partOff')
  return row.phase === null ? t('rowStateIdle') : t(PHASE_KEYS[row.phase])
}

/** The dot beside a row: its fiber phase, or idle. */
function rowDotState(row: PackageRow): StateDotState {
  if (!row.enabled || row.phase === null) return 'idle'
  return PHASE_STATES[row.phase]
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, a configure control for a row that
 * registered a page, and, when the pack is on, a switch. A pack like base
 * carries close to a hundred rows, so a long list gets a filter.
 */
function RowsSection({ packageName, rows, t, toggle, configure }: {
  readonly packageName: string
  readonly rows: readonly PackageRow[]
  readonly t: Translate
  readonly toggle?: RowToggles | undefined
  readonly configure?: RowConfigure | undefined
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = query === '' ? rows : rows.filter(row =>
    `${row.rowId} ${packageRowText(packageName, row.rowId, t)} ${row.moduleName}`.toLocaleLowerCase().includes(query))
  return (
    <section className={css.detailSection} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('partsLabel')}</h4>
        {rows.length === 0 ? null : <span className={css.sectionCount}>{componentSummary(rows, t)}</span>}
      </div>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {rows.length > ROW_FILTER_THRESHOLD
        ? (
          <Input
            type="search"
            className={css.partsFilter as string}
            placeholder={t('partsFilter')}
            aria-label={t('partsFilter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
        )
        : null}
      {rows.length > 0 && shown.length === 0 ? <p className={css.status}>{t('partsFilterEmpty')}</p> : null}
      {shown.length === 0
        ? null
        : (
          <ul className={css.rows}>
            {shown.map(row => {
              const title = packageRowText(packageName, row.rowId, t)
              return (
              <li
                key={row.rowId}
                className={css.row}
                data-plugin-row={row.entryId ?? row.rowId}
                {...row.phase === 'failed' ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
              >
                <div className={css.rowLine}>
                  <span className={css.rowIcon} aria-hidden="true"><IconCordisPluginOutline14 /></span>
                  <div className={css.rowMain}>
                    {configure?.has(row) === true
                      ? (
                        <button type="button" className={css.rowOpen} aria-label={t('configureRow', { name: title })} onClick={() => { configure.open(row) }}>
                          <span className={css.rowId}>{title}</span>
                          <IconChevronRightOutline14 className={css.rowOpenIcon} aria-hidden="true" />
                        </button>
                      )
                      : <span className={css.rowId}>{title}</span>}
                    <span className={css.rowModule}>{title === row.rowId ? row.moduleName : `${row.rowId} · ${row.moduleName}`}</span>
                  </div>
                  <span className={css.rowState}>
                    <StateDot state={rowDotState(row)} size={8} />
                    {rowStateText(row, t)}
                  </span>
                  {toggle === undefined
                    ? null
                    : <RowSwitch row={row} title={title} t={t} busy={toggle.busy(row)} onChange={(enabled) => { toggle.onSetEnabled(row, enabled) }} />}
                </div>
              </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}

/** The top every page shares: the crumb that leads back, then the icon with the page's actions at its right. */
function DetailTop({ crumbLabel, crumbText, onBack, icon, actions }: {
  readonly crumbLabel: string
  readonly crumbText: string
  readonly onBack: () => void
  readonly icon?: ReactNode
  readonly actions?: ReactNode
}): ReactNode {
  return (
    <>
      <button type="button" className={css.crumb} aria-label={crumbLabel} onClick={onBack}>
        <IconChevronDownOutline14 className={css.crumbIcon} aria-hidden="true" />
        <span>{crumbText}</span>
      </button>
      <div className={css.detailHead}>
        <span className={css.cardIcon} aria-hidden="true">{icon ?? <IconPluginPinwheelOutline16 size={20} />}</span>
        {actions}
      </div>
    </>
  )
}

/** An official plugin's page: the crumb back to the cards, its icon, its title over its one-liner, and the form the entry renders. */
function ItemDetail({ item, t, onBack, renderSlot }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  return (
    <div className={css.detail} data-plugin-item-detail={item.id}>
      <DetailTop crumbLabel={t('backToList')} crumbText={t('crumbRoot')} onBack={onBack} />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{item.label}</h3>
        </div>
        <p className={css.detailDesc}>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</p>
      </div>
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.item', { view: 'page' }, { only: item.id })}
      </div>
    </div>
  )
}

/**
 * A row's configuration page: the crumb back to its bundle's page, the row id
 * over the module it names and the entry's one-liner, and the form the entry renders.
 */
function RowDetail({ pkg, row, t, onBack, renderSlot }: {
  readonly pkg: PackageView
  readonly row: PackageRow
  readonly t: Translate
  readonly onBack: () => void
  readonly renderSlot: RenderConfig
}): ReactNode {
  const { title } = packageText(pkg, t)
  const key = rowConfigKey(pkg.name, row.rowId)
  return (
    <div className={css.detail} data-plugin-row-detail={key}>
      <DetailTop crumbLabel={t('backToPackage', { name: title })} crumbText={title} onBack={onBack} icon={<IconCordisPluginOutline14 size={20} />} />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{packageRowText(pkg.name, row.rowId, t)}</h3>
        </div>
        <p className={css.detailName}><code>{row.rowId}</code> · <code>{row.moduleName}</code></p>
        <p className={css.detailDesc}>{renderSlot('plugins.row.config', { view: 'summary' }, { entryKey: key })}</p>
      </div>
      <div className={css.detailSections} data-plugin-config>
        {renderSlot('plugins.row.config', { view: 'page' }, { entryKey: key })}
      </div>
    </div>
  )
}

/**
 * One package's page: the crumb back to the list; its icon with its switch
 * and, for a package the profile installed, uninstall; its title beside its
 * version tag, its beta tag, and its problem tag; the package name the title
 * stands for, which is what installs it elsewhere; its one-liner; the Host's
 * problem when it reports one; the configuration the bundle registered for
 * itself; and its rows with their switches and configure controls.
 */
function PackageDetail({
  pkg, t, busy, rowBusy, configured, configure, renderSlot, check,
  onBack, onSetEnabled, onUninstall, onSetRowEnabled, onCheck, onUpdate,
}: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  readonly check: LoadingCheck | undefined
  readonly onCheck: () => void
  readonly onUpdate: () => void
  /** Whether a row has a write in flight. */
  readonly rowBusy: (row: PackageRow) => boolean
  /** Whether the bundle registered a configuration of its own. */
  readonly configured: boolean
  readonly configure: RowConfigure
  readonly renderSlot: RenderConfig
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onUninstall: () => void
  readonly onSetRowEnabled: (row: PackageRow, enabled: boolean) => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, t)
  return (
    <div className={css.detail} data-plugin-detail={pkg.name}>
      <DetailTop
        crumbLabel={t('backToList')}
        crumbText={t('crumbRoot')}
        onBack={onBack}
        actions={(
          <div className={css.detailActions}>
            {pkg.installed
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  className={css.danger}
                  icon={<IconTrashOutline16 size={13} />}
                  aria-label={t('uninstallLabel', { name: title })}
                  disabled={busy || pkg.readOnlyReason !== undefined}
                  onClick={onUninstall}
                >
                  {t('uninstall')}
                </Button>
              )
              : null}
            <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />
          </div>
        )}
      />
      <div className={css.detailMain}>
        <div className={css.titleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
          {pkg.version === undefined ? null : <Tag className={css.versionTag} tone="neutral">{t('versionTag', { version: pkg.version })}</Tag>}
          {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
        </div>
        <p className={css.detailName}><code data-plugin-name>{pkg.name}</code></p>
        <p className={css.detailDesc}>{description ?? t('noDescription')}</p>
        <PackageFacts pkg={pkg} t={t} summary={false} />
      </div>
      {pkg.error === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {managementText(pkg.error, t)}</p>}
      {pkg.readOnlyReason === undefined ? null : <p className={css.reason} role="status">{managementText({ code: pkg.readOnlyReason }, t)}</p>}
      <div className={css.detailSections}>
        <PluginMaintenance pkg={pkg} t={t} busy={busy} check={check} onCheck={onCheck} onUpdate={onUpdate} />
        {configured
          ? (
            <section className={css.detailSection} data-plugin-config>
              {renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })}
            </section>
          )
          : null}
        <RowsSection
          packageName={pkg.name}
          rows={pkg.rows}
          t={t}
          toggle={pkg.enabled ? { busy: row => busy || rowBusy(row), onSetEnabled: onSetRowEnabled } : undefined}
          configure={configure}
        />
      </div>
    </div>
  )
}

/** Output lines an install run's terminal shows before its middle folds: the first and last six of a long pnpm log. */
const INSTALL_TERMINAL_LINES = 12

/** The install terminal's display copy, from the tab's dictionary. */
function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    /* v8 ignore next -- the Host reports a killed pnpm as a null exit code, never a signal name; the label interface needs one */
    signal: signal => t('terminalSignal', { signal }),
    exitCode: code => t('terminalExitCode', { code: String(code) }),
    noExitCode: t('terminalNoExitCode'),
    running: t('terminalRunning'),
    failed: t('terminalFailed'),
    done: t('terminalDone'),
    copy: t('terminalCopy'),
    copied: t('terminalCopied'),
    noOutput: t('terminalNoOutput'),
    collapseAria: t('terminalCollapseAria'),
    collapse: t('terminalCollapse'),
    expandAria: hidden => t('terminalExpandAria', { n: String(hidden) }),
    expand: hidden => t('terminalExpand', { n: String(hidden) }),
  }
}

/** The sentence under the field for a spec the check refused. */
const INPUT_PROBLEM_KEYS = {
  'invalid-spec': 'installProblemInvalid',
  'already-installed': 'installProblemInstalled',
  'update-unavailable': 'updateUnavailable',
  'not-found': 'installProblemNotFound',
  'not-a-package': 'installProblemNotPackage',
  'not-a-bundle': 'installProblemNotBundle',
  'network': 'installProblemNetwork',
  'unknown': 'installProblemUnknown',
} satisfies Record<InstallInputError['problem'], PluginManagerLocaleKey>

/** One row of the install guide: a spec form's title, its example, and where the person finds it. */
interface GuideExample {
  readonly key: string
  readonly titleKey: PluginManagerLocaleKey
  readonly exampleKey: PluginManagerLocaleKey
  readonly hintKey: PluginManagerLocaleKey
}

/** The spec forms the install guide shows, each with an example the person can drop into the field. */
const GUIDE_EXAMPLES = [
  { key: 'id', titleKey: 'installGuideIdTitle', exampleKey: 'installGuideIdExample', hintKey: 'installGuideIdHint' },
  { key: 'git', titleKey: 'installGuideGitTitle', exampleKey: 'installGuideGitExample', hintKey: 'installGuideGitHint' },
  { key: 'path', titleKey: 'installGuidePathTitle', exampleKey: 'installGuidePathExample', hintKey: 'installGuidePathHint' },
] as const satisfies readonly GuideExample[]

/** The one-line reading of a classified pnpm failure. */
const FAILURE_KIND_KEYS = {
  'pnpm-missing': 'installFailurePnpmMissing',
  'timeout': 'installFailureTimeout',
  'not-found': 'installFailureNotFound',
  'no-matching-version': 'installFailureNoMatchingVersion',
  'network': 'installFailureNetwork',
  'disk-full': 'installFailureDiskFull',
  'permission': 'installFailurePermission',
  'build-blocked': 'installFailureBuildBlocked',
  'integrity': 'installFailureIntegrity',
  'unknown': 'installFailureGeneric',
} satisfies Record<PluginInstallFailureKind, PluginManagerLocaleKey>

/** The heading of each screen past the spec. */
const SCREEN_TITLE_KEYS = {
  starting: 'installStarting',
  running: 'installingTitle',
  cancelling: 'installCancelling',
  applying: 'installApplying',
  done: 'installedTitle',
  failed: 'installFailedTitle',
} satisfies Record<Exclude<InstallState['phase'], 'idle' | 'checking' | 'review'>, PluginManagerLocaleKey>

/** What the spec's kind reads as when the package carries no description of its own. */
const SUBJECT_KIND_KEYS = {
  registry: undefined,
  path: 'installSubjectPath',
  git: 'installSubjectGit',
  tarball: 'installSubjectTarball',
} satisfies Record<InstallSubject['kind'], PluginManagerLocaleKey | undefined>

/**
 * The failed screen's one line: a pnpm failure by its kind, a refusal by its
 * code, any other failure in the Host's words; the run's output stays behind the details.
 */
function failureText(failure: InstallState['failure'], t: Translate): string {
  if (failure === null) return t('installFailureGeneric')
  // Blocked scripts the Host could not name leave the person to allow them in the profile's pnpm settings by hand.
  if (failure.kind === 'build-blocked' && !failure.pendingBuilds?.length) return t('installFailureBuildBlockedManual')
  if (failure.kind !== undefined) return t(FAILURE_KIND_KEYS[failure.kind])
  if (failure.code !== undefined) return managementText({ code: failure.code, diagnostic: failure.reason }, t)
  return failure.reason === '' ? t('installFailureGeneric') : failure.reason
}

/** The package the install is about: its name, one-liner, and version, as the Host read them before installing. */
function SubjectCard({ subject, t, displayName }: { readonly subject: InstallSubject; readonly t: Translate;
  readonly displayName?: string }): ReactNode {
  const title = displayName ?? subject.name ?? subject.spec
  const kindKey = SUBJECT_KIND_KEYS[subject.kind]
  const description = subject.description ?? (kindKey === undefined ? undefined : t(kindKey))
  return (
    <div className={css.subject} data-install-subject={subject.spec}>
      <p className={css.subjectName}>{title}</p>
      {description === undefined ? null : <p className={css.subjectDesc}>{description}</p>}
      {subject.version === undefined ? null : <p className={css.subjectMeta}>{t('installVersion', { version: subject.version })}</p>}
    </div>
  )
}

/**
 * The install dialog: the spec and its check, then the installing, installed,
 * and failed screens over the same subject card. A failed run that left
 * install scripts undecided shows them for approval in place of plain retry.
 */
function InstallDialog({
  install, t, onClose, onEditSpec, onRun, onCancel, onCancelAndClose, onToggleDetails, onEnableNow, onApproveBuilds,
}: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  /** The close control while the Host runs the install: stop the run, then close. */
  readonly onCancelAndClose: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: () => void
  readonly onApproveBuilds: () => void
}): ReactNode {
  const errorId = useId()
  const guideId = useId()
  const approvalId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const { phase } = install
  const updating = install.update !== undefined
  const candidate = install.localCandidate
  const candidateIssue = install.candidateIssue === undefined ? null : t({
    changed: 'candidateInstallChanged',
    'verification-unavailable': 'candidateInstallUnavailable',
    'installed-changed': 'candidateInstallBytesChanged',
    'activation-failed': 'candidateInstallActivationFailed',
  }[install.candidateIssue] as PluginManagerLocaleKey)
  if (phase === 'review') {
    return install.update?.inspection === undefined ? null : <UpdateReviewDialog
      inspection={install.update.inspection} t={t} onConfirm={onRun} onEdit={onCancel} onClose={onClose} />
  }
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={candidate === undefined ? t(updating ? 'updateAction' : 'installTitle') : t('candidateInstallTitle')}
        closeLabel={t('close')}
        description={candidate === undefined ? (updating ? t('updateDescription', { name: install.update.name }) : t('installDescription'))
          : t('candidateInstallDescription', { name: candidate.displayName })}
        className={css.installDialog as string}
        footer={(
          candidate !== undefined && install.candidateIssue === 'changed'
            ? <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>
            : <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
              {checking ? <span className={css.spinner} aria-hidden="true" /> : null}
              {t(checking ? 'installChecking' : candidate === undefined ? (updating ? 'updateInspect' : 'installRun') : 'candidateInstallRetry')}
            </Button>
        )}
      >
        <div className={css.installBody}>
          {candidate === undefined ? <label className={css.installField}>
            <span>{t('installSpecLabel')}</span>
            <input
              type="text"
              value={install.spec}
              placeholder={updating ? `${install.update.name}@1.2.3` : t('installSpecPlaceholder')}
              disabled={checking}
              aria-invalid={install.inputError !== null}
              aria-describedby={install.inputError === null ? undefined : errorId}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !empty && !checking) onRun() }}
            />
          </label> : null}
          {candidateIssue !== null ? <p className={css.inputError} role="alert">{candidateIssue}</p> : null}
          {install.inputError === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{t(INPUT_PROBLEM_KEYS[install.inputError.problem], { reason: install.inputError.reason })}</p>}
          {candidate === undefined ? <button
            type="button"
            className={css.guideToggle}
            aria-expanded={guideOpen}
            aria-controls={guideId}
            onClick={() => { setGuideOpen(open => !open) }}
          >
            <IconChevronDownOutline14 className={css.guideChevron} aria-hidden="true" />
            <span>{t(guideOpen ? 'installGuideHide' : 'installGuideToggle')}</span>
          </button> : null}
          {candidate === undefined && guideOpen
            ? (
              <div id={guideId} className={css.guide} data-install-guide>
                <p className={css.guideIntro}>{t('installGuideIntro')}</p>
                <p className={css.guideNote}>{t('installGuideIdNote')}</p>
                <ol className={css.guideList}>
                  {GUIDE_EXAMPLES.map(({ key, titleKey, exampleKey, hintKey }, index) => (
                    <li key={key} className={css.guideItem}>
                      <span className={css.guideIndex} aria-hidden="true">{index + 1}</span>
                      <div className={css.guideMain}>
                        <span className={css.guideTitle}>{t(titleKey)}</span>
                        <span className={css.guideExample}>
                          <span className={css.guideExampleLabel}>{t('installGuideExampleLabel')}</span>
                          <code>{t(exampleKey)}</code>
                        </span>
                        <span className={css.guideHint}>{t(hintKey)}</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('installGuideFillAria', { example: t(exampleKey) })}
                        disabled={checking}
                        onClick={() => { onEditSpec(t(exampleKey)) }}
                      >
                        {t('installGuideFill')}
                      </Button>
                    </li>
                  ))}
                </ol>
                <p className={css.guideSafety} role="note">
                  <IconWarningOutline16 size={14} aria-hidden="true" />
                  <span>{t('installGuideSafety')}</span>
                </p>
              </div>
            )
            : null}
        </div>
      </Modal>
    )
  }
  const heading = candidate !== undefined && install.candidateActive === true
    ? t('candidateInstallActiveTitle')
    : updating ? t(phase === 'done' ? 'updateDoneTitle' : phase === 'failed' ? 'updateFailedTitle' : 'updateRunningTitle') : t(SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  // Only a run the Host acknowledged can be stopped; before that, and while it stops or applies, the controls wait.
  const stoppable = phase === 'running' || phase === 'failed'
  const unconfirmed = install.failure?.cancelUnconfirmed === true ? install.failure.reason : undefined
  const pendingBuilds = phase === 'failed' ? install.failure?.pendingBuilds ?? [] : []
  const approvable = pendingBuilds.length > 0
  const firstRun = install.runs[0]
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done'
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t('installEditAria')} disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutline14 aria-hidden="true" />
                <span>{t('installEdit')}</span>
              </button>
            )}
          <button
            type="button"
            className={css.wizardClose}
            aria-label={t(phase === 'running' ? 'installCloseCancels' : 'close')}
            disabled={pending && phase !== 'running'}
            onClick={phase === 'running' ? onCancelAndClose : onClose}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div className={css.wizardScroll}>
          <div className={css.wizardHero}>
            <span className={css.wizardIcon} data-tone={pending ? 'pending' : phase} aria-hidden="true">
              {pending
                ? <span className={css.spinnerLarge} />
                : phase === 'done' ? <IconCheckOutline16 size={28} /> : <IconWarningOutline16 size={28} />}
            </span>
            <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
            {phase === 'failed' ? <p className={css.wizardSub}>{candidateIssue ?? failureText(install.failure, t)}</p> : null}
            {unconfirmed === undefined ? null : <p className={css.wizardSub} role="alert">{t('installCancelUnconfirmed', { reason: unconfirmed })}</p>}
          </div>
          {install.subject === null ? null : <SubjectCard subject={install.subject} t={t}
            {...candidate === undefined ? {} : { displayName: candidate.displayName }} />}
          {approvable
            ? (
              <section className={css.approval} role="group" aria-labelledby={approvalId} data-install-approval>
                <h3 id={approvalId} className={css.approvalTitle}>{t('installApprovalTitle')}</h3>
                <p className={css.approvalText}>{t('installApprovalDescription')}</p>
                <ul className={css.approvalList}>
                  {pendingBuilds.map(name => <li key={name}><code>{name}</code></li>)}
                </ul>
                <p className={css.approvalText}>{t('installApprovalConsequence')}</p>
                <p className={css.approvalCaution}>{t('installApprovalCaution')}</p>
                <Button variant="primary" className={css.wide} onClick={onApproveBuilds}>{t('installApproveAndRetry')}</Button>
              </section>
            )
            : null}
          {phase === 'done' && install.installed === null
            ? <p className={css.result} role="status">{t('installDoneNothing')}</p>
            : null}
          {phase === 'done' && install.restartRequired
            ? <p className={css.resultWarn} role="status">{t(candidate === undefined
              ? updating ? 'updateDoneRestart' : 'installDoneRestart' : 'candidateInstallRestart')}</p>
            : null}
          {phase === 'done' && install.candidateActive === true
            ? <p className={css.result} role="status">{t('candidateInstallActiveDescription')}</p>
            : null}
          {phase === 'done' && install.approvedBuilds.length > 0
            ? <p className={css.result} role="status">{t('installDoneApproved', { names: install.approvedBuilds.join(', ') })}</p>
            : null}
          <div className={css.wizardFoot}>
            <button type="button" className={css.detailsToggle} aria-expanded={install.detailsOpen} onClick={onToggleDetails}>
              <span>{t(install.detailsOpen ? 'installDetailsHide' : 'installDetailsShow')}</span>
              <IconChevronDownOutline14 className={css.detailsChevron} aria-hidden="true" />
            </button>
            {pending
              ? (
                <Button variant="outline" size="sm" disabled={phase !== 'running'} onClick={onCancel}>
                  {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
                </Button>
              )
              : null}
            {phase === 'failed' && !approvable && !(candidate !== undefined && install.installed !== null)
              ? <Button variant="primary" size="sm" onClick={onRun}>{t('installRetry')}</Button> : null}
          </div>
          {install.detailsOpen
            ? (
              <div className={css.detailsBody}>
                <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
                {install.runs.map(run => (
                  <TerminalBlock
                    key={run.jobId}
                    command={run.command}
                    output={run.output}
                    running={run.exitCode === undefined}
                    exitCode={run.exitCode}
                    maxLines={INSTALL_TERMINAL_LINES}
                    labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                    className={css.terminal}
                  />
                ))}
              </div>
            )
            : null}
          {phase !== 'done'
            ? null
            : install.candidateActive === true || (candidate !== undefined && install.restartRequired)
              ? <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>
              : install.installed !== null && !updating
              ? <Button variant="primary" className={css.wide} disabled={install.enabling} aria-busy={install.enabling} onClick={onEnableNow}>{t('installEnableNow')}</Button>
              : <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>}
        </div>
      </div>
    </Modal>
  )
}

/** The confirmation an uninstall waits on. */
function ConfirmDialog({ confirm, t, onConfirm, onCancel }: {
  readonly confirm: ConfirmState
  readonly t: Translate
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const { title: name } = packageText({ name: confirm.packageName }, t)
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('confirmUninstallTitle', { name })}
      closeLabel={t('close')}
      description={t('confirmUninstallDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} onClick={onConfirm}>
            {t('confirmUninstall')}
          </Button>
        </>
      )}
    />
  )
}

/** Render local plugin management, optional discovery and Host-owned transaction dialogs. */
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, ensure, renderSlot } = props
  const state = props.usePluginManager(snapshot => snapshot)
  const ledger = props.useConfigLedger(snapshot => snapshot)
  const checks = props.usePluginChecks(snapshot => snapshot)
  // What is open; a package that leaves the list (uninstalled) drops back to the cards.
  const [view, setView] = useState<View>({ kind: 'list' })
  const [tab, setTab] = useState<CatalogTab>(props.market === undefined ? 'local' : 'market')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const scrolledHighlight = useRef<string | null>(null)
  const marketEnsured = useRef(false)
  const inMarket = tab === 'market' && props.market !== undefined
  const inCapabilities = tab === 'capabilities' && props.capabilities !== undefined
  // Both extra tabs replace the local list; neither is offered without the face that fills it.
  const inCatalog = inMarket || inCapabilities
  const hasTabs = props.market !== undefined || props.capabilities !== undefined
  useEffect(() => { ensure() }, [ensure])
  useEffect(() => {
    if (tab !== 'market' || props.market === undefined || marketEnsured.current) return
    marketEnsured.current = true
    props.market.ensure()
  }, [tab, props.market])
  // A package an install just enabled: scroll it into view and mark it for a moment.
  const { highlight, clearHighlight } = { highlight: state.highlight, clearHighlight: props.clearHighlight }
  useEffect(() => {
    if (highlight === null) return
    setTab('local')
    setView({ kind: 'list' })
    setQuery('')
    setFilter('all')
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => { clearTimeout(timer) }
  }, [highlight, clearHighlight])
  useEffect(() => {
    if (highlight === null) { scrolledHighlight.current = null; return }
    if (tab !== 'local' || view.kind !== 'list' || query !== '' || filter !== 'all' || scrolledHighlight.current === highlight) return
    const card = [...document.querySelectorAll('[data-plugin-package]')].find(element => element.getAttribute('data-plugin-package') === highlight)
    if (card !== undefined && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      scrolledHighlight.current = highlight
    }
  }, [highlight, tab, view.kind, query, filter, state.packages])
  const noticeLine = state.notice === null ? null : noticeText(state.notice, t)

  const listed = listedPackages(state.packages)
  const loaded = state.status === 'ready' || state.status === 'error'
  const openPkg = view.kind === 'package' || view.kind === 'row' ? listed.find(pkg => pkg.name === view.name) : undefined
  const openItem = view.kind === 'item' ? ledger.items.find(item => item.id === view.id) : undefined
  const openRow = view.kind === 'row' && openPkg !== undefined ? openPkg.rows.find(row => row.rowId === view.rowId) : undefined
  const showsCards = openPkg === undefined && openItem === undefined
  const setRowEnabled = (row: PackageRow, enabled: boolean): void => {
    /* v8 ignore next -- a row without a live entry has its switch disabled */
    if (row.entryId !== undefined) props.setRowEnabled(row.entryId, enabled)
  }
  const configure = (pkg: PackageView): RowConfigure => ({
    has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId)),
    open: (row) => { setView({ kind: 'row', name: pkg.name, rowId: row.rowId }) },
  })
  const openMarket = (): void => {
    setTab('market'); setView({ kind: 'list' })
  }
  const openCapabilities = (): void => {
    setTab('capabilities'); setView({ kind: 'list' }); props.capabilities?.ensure()
  }

  return (
    <section className={css.page} data-plugin-panel data-market={inMarket ? 'true' : undefined} data-catalog-tab={tab} aria-busy={state.status === 'loading'}>
      {(showsCards || inCatalog) && !inMarket
        ? (
          <header className={css.pageHead}>
            <div>
              <h1 className={css.pageTitle}>{inMarket ? props.market?.t('title') : inCapabilities ? t('title') : t('catalogLocal')}</h1>
              <p className={css.pageIntro}>{inMarket ? props.market?.t('pageIntro') : t('intro')}</p>
            </div>
            {!inMarket && !inCapabilities && <div className={css.toolbar}>
              <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
                <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
              </button>
              <Button variant="primary" size="sm" icon={<IconPlusOutline16 size={13} />} disabled={!loaded} onClick={props.openInstall}>{t('addPlugin')}</Button>
            </div>}
          </header>
        )
        : null}
      {!hasTabs || props.singleMarketplace ? null : <nav className={overview.tabs} aria-label={t('catalogViews')}>
        <Pill active={!inCatalog} aria-pressed={!inCatalog} onClick={() => { setTab('local') }}>{t('catalogLocal')}</Pill>
        {props.market === undefined
          ? null
          : <Pill active={inMarket} aria-pressed={inMarket} onClick={openMarket}>{t('catalogDiscover')}</Pill>}
        {props.capabilities === undefined
          ? null
          : <Pill active={inCapabilities} aria-pressed={inCapabilities} onClick={openCapabilities}>{t('catalogCapabilities')}</Pill>}
      </nav>}
      {props.singleMarketplace && !inMarket && props.market !== undefined && <div className={css.toolbar}>
        <Button variant="outline" size="sm" onClick={openMarket}>{props.market.t('marketReturn')}</Button>
        {!inCapabilities && props.capabilities !== undefined && <Button variant="outline" size="sm"
          onClick={openCapabilities}>{props.market.t('marketManageIntake')}</Button>}
      </div>}
      {inMarket ? <MarketplacePanel {...props.market} openPackageInstall={props.openInstall}
        {...(props.singleMarketplace ? {
          openPluginManagement: () => { setTab('local'); setView({ kind: 'list' }) },
          openCapabilityManagement: openCapabilities,
        } : {})} /> : null}
      {inCapabilities ? <CapabilitiesPanel {...props.capabilities} /> : null}
      {!inCatalog && state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {!inCatalog && state.status === 'unavailable' ? <p className={css.status} role="status">{t('unavailable')}</p> : null}
      {!inCatalog && state.status === 'error'
        ? (
          <div className={css.failure}>
            <p role="alert">{t('error')}</p>
            <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
          </div>
        )
        : null}
      {state.notice === null || noticeLine === null
        ? null
        : (
          <Toast
            key={state.notice.seq}
            text={noticeLine}
            icon={<IconWarningOutline16 />}
            holdMs={toastHoldMs(noticeLine)}
            onDone={props.dismissNotice}
          />
        )}
      {!inCatalog && loaded && openPkg !== undefined && openRow !== undefined
        ? (
          <RowDetail
            pkg={openPkg}
            row={openRow}
            t={t}
            renderSlot={renderSlot}
            onBack={() => { setView({ kind: 'package', name: openPkg.name }) }}
          />
        )
        : null}
      {!inCatalog && loaded && openPkg !== undefined && openRow === undefined
        ? (
          <PackageDetail
            pkg={openPkg}
            t={t}
            busy={state.busy.includes(openPkg.name) || isInstallPending(state.install.phase)}
            check={checks[openPkg.name]}
            onCheck={() => { props.checkPackage(openPkg.name) }}
            onUpdate={() => { props.openUpdate(openPkg.name) }}
            rowBusy={row => row.entryId !== undefined && state.busy.includes(rowKey(row.entryId))}
            configured={ledger.bundles.has(openPkg.name)}
            configure={configure(openPkg)}
            renderSlot={renderSlot}
            onBack={() => { setView({ kind: 'list' }) }}
            onSetEnabled={(enabled) => { props.setEnabled(openPkg.name, enabled) }}
            onUninstall={() => { props.uninstall(openPkg.name) }}
            onSetRowEnabled={setRowEnabled}
          />
        )
        : null}
      {!inCatalog && loaded && openItem !== undefined
        ? <ItemDetail item={openItem} t={t} renderSlot={renderSlot} onBack={() => { setView({ kind: 'list' }) }} />
        : null}
      {!inCatalog && loaded && showsCards
        ? <PluginCatalogOverview packages={listed} items={ledger.items} t={t} busy={state.busy} highlight={state.highlight}
          query={query} filter={filter} onQuery={setQuery} onFilter={setFilter} renderSlot={renderSlot}
          onOpenPackage={(name) => { setView({ kind: 'package', name }) }} onOpenItem={(id) => { setView({ kind: 'item', id }) }}
          onSetEnabled={props.setEnabled} />
        : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onCancelAndClose={props.cancelInstallAndClose}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={props.enableInstalled}
        onApproveBuilds={props.approveBuildsAndRetry}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            confirm={state.confirm}
            t={t}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
