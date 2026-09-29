/** Source-separated local plugin cards and filters over the current Host snapshot. */
import type { ReactNode } from 'react'
import { Button, IconPluginPinwheelOutline16, Input, Pill, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficialItem } from './config-ledger.ts'
import type { PackageView } from './manager-store.ts'
import type { PluginManagerPageProps } from './PluginManagerPage.tsx'
import { managementText, packageText, type Translate } from './presentation.ts'
import { componentSummary, matchesPackage, packageSourceText, packageStatus, packageStatusText, type CatalogFilter } from './catalog-presentation.ts'
import css from './PluginManagerPage.module.css'
import overview from './PluginCatalogOverview.module.css'

/** Enablement remains a Host-owned selection, independent of loaded component counts. */
export function EnableSwitch({ pkg, title, t, busy, onSetEnabled }: {
  readonly pkg: PackageView
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  return <Switch checked={pkg.enabled} label={t('enableToggle', { name: title })}
    disabled={busy || pkg.readOnlyReason !== undefined || (!pkg.enabled && pkg.error !== undefined)}
    {...pkg.readOnlyReason === undefined ? {} : { title: managementText({ code: pkg.readOnlyReason }, t) }} onChange={onSetEnabled} />
}

/** A package's observed loading state and local installation ownership. */
export function PackageFacts({ pkg, t, summary = true }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly summary?: boolean
}): ReactNode {
  return <div className={overview.facts} data-plugin-facts>
    <Tag tone={packageStatus(pkg) === 'problem' ? 'danger' : 'neutral'}>{packageStatusText(pkg, t)}</Tag>
    <span>{packageSourceText(pkg, t)}</span>
    {summary ? <span>{componentSummary(pkg.rows, t)}</span> : null}
  </div>
}

function PackageCard({ pkg, t, busy, highlighted, onOpen, onSetEnabled }: {
  readonly pkg: PackageView
  readonly t: Translate
  readonly busy: boolean
  readonly highlighted: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  const { title, description, beta } = packageText(pkg, t)
  return <li className={`${css.card} ${css.cardLink} ${overview.packageCard}`} data-plugin-package={pkg.name} data-plugin-status={packageStatus(pkg)}
    {...highlighted ? { 'data-plugin-highlight': '' } : {}}>
    <div className={css.cardHead}>
      <span className={css.cardIcon} aria-hidden="true"><IconPluginPinwheelOutline16 size={20} /></span>
      <div className={css.cardMain}>
        <div className={css.titleRow}>
          <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: title })} onClick={onOpen}>{title}</button>
          {beta ? <Tag className={css.statusTag} tone="info">{t('statusBeta')}</Tag> : null}
        </div>
        {description === undefined ? null : <span className={css.cardDesc}>{description}</span>}
        <PackageFacts pkg={pkg} t={t} />
      </div>
      <div className={css.cardEnd}><EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} /></div>
    </div>
  </li>
}

function ItemCard({ item, t, onOpen, renderSlot }: {
  readonly item: OfficialItem
  readonly t: Translate
  readonly onOpen: () => void
  readonly renderSlot: PluginManagerPageProps['renderSlot']
}): ReactNode {
  return <li className={`${css.card} ${css.cardLink} ${overview.packageCard}`} data-plugin-item={item.id}>
    <div className={css.cardHead}>
      <span className={css.cardIcon} aria-hidden="true"><IconPluginPinwheelOutline16 size={20} /></span>
      <div className={css.cardMain}>
        <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: item.label })} onClick={onOpen}>{item.label}</button>
        <span className={css.cardDesc}>{renderSlot('plugins.item', { view: 'summary' }, { only: item.id })}</span>
      </div>
    </div>
  </li>
}

const FILTERS = {
  all: 'catalogFilterAll', enabled: 'catalogFilterEnabled', disabled: 'catalogFilterDisabled',
  problem: 'catalogFilterProblem', waiting: 'catalogFilterWaiting',
} as const

/** Read-only filtering does not install, enable or inspect any remote package. */
export function PluginCatalogOverview({
  packages, items, t, busy, highlight, query, filter, onQuery, onFilter, onOpenPackage, onOpenItem, onSetEnabled, renderSlot,
}: {
  readonly packages: readonly PackageView[]
  readonly items: readonly OfficialItem[]
  readonly t: Translate
  readonly busy: readonly string[]
  readonly highlight: string | null
  readonly query: string
  readonly filter: CatalogFilter
  readonly onQuery: (query: string) => void
  readonly onFilter: (filter: CatalogFilter) => void
  readonly onOpenPackage: (name: string) => void
  readonly onOpenItem: (id: string) => void
  readonly onSetEnabled: (name: string, enabled: boolean) => void
  readonly renderSlot: PluginManagerPageProps['renderSlot']
}): ReactNode {
  const shown = packages.filter(pkg => matchesPackage(pkg, query, filter, t))
  const bundled = shown.filter(pkg => pkg.optional && !pkg.installed)
  const installed = shown.filter(pkg => pkg.installed || !pkg.optional)
  const text = query.trim().toLocaleLowerCase()
  const settings = filter === 'all' ? items.filter(item => `${item.id} ${item.label}`.toLocaleLowerCase().includes(text)) : []
  const none = shown.length === 0 && settings.length === 0
  const empty = packages.length === 0 && items.length === 0
  const groups = [
    { id: 'bundled', titleKey: 'officialTitle', descriptionKey: 'catalogBundledDescription', packages: bundled, items: [] },
    { id: 'bundles', titleKey: 'bundlesTitle', descriptionKey: 'catalogInstalledDescription', packages: installed, items: [] },
    { id: 'settings', titleKey: 'catalogSettingsTitle', descriptionKey: 'catalogSettingsDescription', packages: [], items: settings },
  ] as const
  return <div className={overview.overview} data-plugin-overview>
    <div className={overview.filters}>
      <Input type="search" aria-label={t('catalogSearch')} placeholder={t('catalogSearch')} value={query} onChange={(event) => { onQuery(event.target.value) }} />
      <div className={overview.filterRow} role="group" aria-label={t('catalogFilter')}>
        {(Object.keys(FILTERS) as CatalogFilter[]).map(value => <Pill key={value} active={filter === value} aria-pressed={filter === value}
          onClick={() => { onFilter(value) }}>{t(FILTERS[value])}</Pill>)}
      </div>
      <p className={overview.note}>{t('catalogEvidence')}</p>
    </div>
    {none ? <div className={overview.empty}>
      <p className={css.empty}>{t(empty ? 'empty' : 'catalogNoMatches')}</p>
      {query !== '' || filter !== 'all' ? <Button variant="outline" size="sm" onClick={() => { onQuery(''); onFilter('all') }}>{t('catalogClear')}</Button> : null}
    </div> : null}
    {groups.map(group => group.packages.length + group.items.length === 0 ? null : <section key={group.id} className={overview.group} data-plugin-scope="global"
      data-plugin-group={group.id}>
      <div className={css.groupHead}>
        <h3 className={css.groupTitle}>{t(group.titleKey)}</h3>
        <span className={css.count} data-plugin-count={group.packages.length + group.items.length}>
          {group.packages.length + group.items.length}
        </span>
      </div>
      <p className={overview.note}>{t(group.descriptionKey)}</p>
      <ul className={css.cards}>
        {group.packages.map(pkg => <PackageCard key={pkg.name} pkg={pkg} t={t} busy={busy.includes(pkg.name)}
          highlighted={highlight === pkg.name}
          onOpen={() => { onOpenPackage(pkg.name) }} onSetEnabled={(enabled) => { onSetEnabled(pkg.name, enabled) }} />)}
        {group.items.map(item => <ItemCard key={item.id} item={item} t={t} renderSlot={renderSlot}
          onOpen={() => { onOpenItem(item.id) }} />)}
      </ul>
    </section>)}
  </div>
}
