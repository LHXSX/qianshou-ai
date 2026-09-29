/**
 * Declarations saved by the plugin market.
 *
 * The file format matches `qianshou-plugin-catalog` `market-installed.json`:
 * `{ version: 1, installed: [{ id, capabilityId, version, installedAt, packageSpec?, visibility, inviteAccountIds }] }`.
 * The only market row this reader may add to a hello is the owner's public, exact built-in
 * `qianshou.article@1` declaration. Package-backed and unknown old records stay local even if
 * their capability id happens to be `text.transform`.
 *
 * The runner's own advertisement is never filtered here. A row that is a draft, private or invite
 * contributes nothing, while the capabilities this process really runs go on the hello unchanged.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { providedCapabilityAdsForIds, type ProvidedCapabilityAd } from '@deepseek-ai/dsh-compute-core/node-capability'

/** Capabilities this PC may put on hello as healthy. Matches the catalog allowlist. */
const ADVERTISABLE_CAPABILITY_IDS = ['text.transform'] as const

/**
 * The only visibility whose row reaches the hello.
 *
 * A row that omits the field is a draft, so a declaration file written before visibility existed
 * stops being advertised until its owner publishes it. Keeping this rule here as well as in the
 * catalog is deliberate: the catalog decides what may be published, and this reader decides what
 * this process repeats to Shanghai.
 */
const HELLO_VISIBILITY = 'public'

/**
 * Keep ids this node can accept, in first-seen order.
 * @param ids - Capability ids from the market file or a test reader.
 * @returns Ids Shanghai may treat as healthy for this computer.
 */
export function keepAdvertisableCapabilityIds(ids: readonly string[]): readonly string[] {
  const kept: string[] = []
  for (const id of ids) {
    if ((ADVERTISABLE_CAPABILITY_IDS as readonly string[]).includes(id) && !kept.includes(id)) kept.push(id)
  }
  return kept
}

/**
 * Read a market id list. A throwing reader contributes nothing and does not hide runner ads.
 * @param read - Optional reader invoked once per hello.
 * @returns The reader's ids, or an empty list when it is absent or throws.
 */
export function readMarketIds(read: (() => readonly string[]) | undefined): readonly string[] {
  if (read === undefined) return []
  try {
    return read()
  } catch {
    // A broken declaration file must not remove the runner's own advertisement.
    return []
  }
}

/**
 * Ads for market ids this node can accept. Other registry names are dropped.
 * @param ids - Raw ids from the declaration file.
 * @returns Healthy ads. `image.generate` is not included.
 */
export function marketCapabilityAds(ids: readonly string[]): readonly ProvidedCapabilityAd[] {
  return providedCapabilityAdsForIds(keepAdvertisableCapabilityIds(ids))
}

/**
 * Declaration path under a harness home.
 * @param home - `DSH_HOME`, or `~/.deepseek-harness` when that is unset.
 * @returns Absolute path of the market install file.
 */
export function marketInstallPath(home: string): string {
  return join(home, 'qianshou', 'market-installed.json')
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, length: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > length) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

/**
 * Capability ids saved in the declaration file, before the advertisable filter.
 * A row without `visibility: public` is not published here: draft, private and invite rows stay
 * on this computer, and an unreadable `visibility` reads the same way a missing one does.
 * @param path - Absolute declaration path.
 * @returns Well-formed capability ids the owner published. A missing or unreadable file is empty.
 */
export function readDeclaredCapabilityIds(path: string): readonly string[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  const body = record(parsed)
  if (body === null || body.version !== 1 || !Array.isArray(body.installed)) return []
  const ids: string[] = []
  for (const item of body.installed) {
    const row = record(item)
    if (row === null || row.visibility !== HELLO_VISIBILITY) continue
    if (row.id !== 'qianshou.article' || row.version !== '1' || row.capabilityId !== 'text.transform'
      || !(row.packageSpec === undefined || row.packageSpec === '')) continue
    const id = text(row.capabilityId, 80)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Advertisable capability ids this computer published under a harness home.
 * @param home - Harness home.
 * @returns Ids that may be merged into hello `provided_capabilities`.
 */
export function readInstalledCapabilityIds(home: string): readonly string[] {
  return keepAdvertisableCapabilityIds(readDeclaredCapabilityIds(marketInstallPath(home)))
}
