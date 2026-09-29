/** Local plugin selection and observed Host loading states, without capability certification. */
import type { PackageRow, PackageView } from './manager-store.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { packageText, type Translate } from './presentation.ts'

/** The local list's state filter. */
export type CatalogFilter = 'all' | 'enabled' | 'disabled' | 'problem' | 'waiting'
/** Observed loading state of a selected bundle's components. */
export type PackageStatus = 'disabled' | 'stopping' | 'problem' | 'loading' | 'pending' | 'idle' | 'partial' | 'active'

const BUILTIN_PROFILE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-minimal',
])

/** Keep user-manageable bundles and selected names with Host errors.
 * @param packages - Current Host projection.
 * @returns Visible local package identities, preserving Host order.
 */
export function listedPackages(packages: readonly PackageView[]): PackageView[] {
  return packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)
    && (pkg.installed || pkg.optional || pkg.error !== undefined))
}

/** Derive a loading label from real phases; a saved enable switch alone is never active.
 * @param pkg - Bundle selection and its observed component phases.
 * @returns The state represented by the latest Host snapshot.
 */
export function packageStatus(pkg: PackageView): PackageStatus {
  if (pkg.error !== undefined) return 'problem'
  if (!pkg.enabled) return pkg.rows.some(row => row.phase === 'active' || row.phase === 'loading' || row.phase === 'unloading') ? 'stopping' : 'disabled'
  if (pkg.rows.some(row => row.phase === 'failed')) return 'problem'
  if (pkg.rows.some(row => row.phase === 'loading' || row.phase === 'unloading')) return 'loading'
  const selected = pkg.rows.filter(row => row.enabled)
  if (selected.some(row => row.phase === 'pending')) return 'pending'
  if (selected.length === 0 || selected.some(row => row.phase === null)) return 'idle'
  return selected.length < pkg.rows.length ? 'partial' : 'active'
}

const STATUS_KEYS: Record<PackageStatus, PluginManagerLocaleKey> = {
  disabled: 'catalogDisabled', stopping: 'catalogStopping', problem: 'statusProblem', loading: 'catalogLoading',
  pending: 'catalogPending', idle: 'catalogIdle', partial: 'catalogPartial', active: 'catalogActive',
}

/** Localize one observed package state.
 * @param pkg - Current Host package projection.
 * @param t - Plugin dictionary translator.
 * @returns A loading-state label, never a business health result.
 */
export function packageStatusText(pkg: PackageView, t: Translate): string {
  return t(STATUS_KEYS[packageStatus(pkg)])
}

/** Describe installation ownership without asserting publisher verification.
 * @param pkg - Current Host package projection.
 * @param t - Plugin dictionary translator.
 * @returns The supported local source label.
 */
export function packageSourceText(pkg: PackageView, t: Translate): string {
  return t(pkg.installed ? 'catalogSourceInstalled' : pkg.optional ? 'catalogSourceBundled' : 'catalogSourceSelected')
}

/** Summarize every component using disjoint observed phase categories.
 * @param rows - Current component observations.
 * @param t - Plugin dictionary translator.
 * @returns Counts for observed states, or an explicit absence of component observations.
 */
export function componentSummary(rows: readonly PackageRow[], t: Translate): string {
  if (rows.length === 0) return t('catalogNoComponents')
  const counts: Partial<Record<PluginManagerLocaleKey, number>> = {}
  for (const row of rows) {
    const key: PluginManagerLocaleKey = row.phase === 'failed' ? 'partsCountFailed'
      : row.phase === 'unloading' ? 'partsCountUnloading'
        : row.phase === 'loading' ? 'partsCountLoading'
          : row.phase === 'active' ? 'partsCountRunning'
            : row.phase === 'pending' ? 'partsCountPending'
              : !row.enabled ? 'partsCountOff' : 'partsCountIdle'
    counts[key] = (counts[key] ?? 0) + 1
  }
  const order = ['partsCountRunning', 'partsCountOff', 'partsCountFailed', 'partsCountPending', 'partsCountLoading', 'partsCountUnloading', 'partsCountIdle'] as const
  return [t('partsCountTotal', { count: String(rows.length) }), ...order.flatMap(key =>
    counts[key] === undefined ? [] : [t(key, { count: String(counts[key]) })])].join(' · ')
}

/** Match local package identity, localized display copy and an observed-state filter.
 * @param pkg - Current Host package projection.
 * @param query - User-entered local search, never sent to a directory.
 * @param filter - The selected loading-state filter.
 * @param t - Plugin dictionary translator.
 * @returns Whether this package belongs in the local result.
 */
export function matchesPackage(pkg: PackageView, query: string, filter: CatalogFilter, t: Translate): boolean {
  const state = packageStatus(pkg)
  const matches = filter === 'all' || (filter === 'enabled' && pkg.enabled) || (filter === 'disabled' && !pkg.enabled)
    || (filter === 'problem' && state === 'problem')
    || (filter === 'waiting' && ['pending', 'loading', 'stopping', 'idle'].includes(state))
  const text = packageText(pkg, t)
  return matches && `${pkg.name} ${text.title} ${text.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}
