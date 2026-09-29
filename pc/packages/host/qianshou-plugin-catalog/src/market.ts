/** Shipped market catalog, API listing parse, and the declaration file both PC clients share. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { CatalogFailure } from './registry.ts'
import { CAPABILITY_VISIBILITIES, parseInviteAccountIds, readVisibility } from './capabilities.ts'
import type {
  MarketCatalog,
  MarketConnectionMode,
  MarketDependency,
  MarketInstallRecord,
  MarketListing,
  MarketListingRequirements,
  MarketListingSignature,
} from './types.ts'

/** Capabilities this PC may declare healthy. This is deliberately narrower than local installation. */
export const MARKET_ADVERTISABLE_CAPABILITY_IDS = ['text.transform'] as const

const LISTING_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._~-]{0,213}$/
const MARKET_BUNDLE_SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
const VERSION_PART = /^v?\d+(?:\.\d+){0,3}$/
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const MAX_BYTES_REQUIREMENT = 1024 * 1024 * 1024 * 1024 * 1024
const RESPONSE_BYTES = 1024 * 1024
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const REQUIREMENT_FIELDS = new Set([
  'signature', 'packages', 'model', 'minFreeDiskBytes', 'minTotalMemoryBytes', 'platforms', 'architectures',
])
const LEGACY_ENTRY_FIELDS = new Set(['id', 'version', 'caps', 'declaredAt', 'visibility', 'invitees'])
const LEGACY_CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/
const LEGACY_ACCOUNT_ID = /^[1-9]\d{0,19}$/
const DECLARATION_LIMIT = 256

/**
 * Built-in signature values: SHA-256 over each shipped row's declaration fields.
 * `tests/preflight.spec.ts` recomputes both, so editing a shipped row without recording its new
 * digest fails that test instead of shipping a row this computer refuses to install.
 */
const SHIPPED_ARTICLE_DIGEST = '426771c81ebe6efb65ff59089bddd36b3c015fa01fa7cbf19c702530823a861f'
const SHIPPED_IMAGE_DIGEST = '161a95e312c2e9645d10ac68e8eb61b6ac0ea4350fe503dd9ce92eb562cc4f5c'

/**
 * Built-in rows. Article can be installed. Image stays visible and cannot be declared.
 * Titles here are fallbacks; the PC client translates the known ids.
 *
 * Installability, not the preflight, is what refuses image: this node cannot accept
 * `image.generate`, so Get stays off and its declaration is never written.
 *
 * `signature` on a shipped row is this catalog's own SHA-256 over the row's declaration
 * fields (see `preflight.ts` `catalogDigest`). It catches a row edited inside the shipped
 * bundle; it is not an external publisher's identity. Rows fetched from an API origin must
 * carry a `publisher` signature instead, verified against the operator's `publisherKeys`.
 * `packages`, `model`, resource floors, and optional OS/runtime architecture lists are the
 * declared requirements the install preflight checks on this computer.
 */
const SHIPPED: readonly MarketListing[] = [
  {
    id: 'qianshou.article',
    title: '文章',
    summary: '在本机保存文章能力草稿；是否向上海公开声明及开启接单，由机主之后单独决定。',
    capabilityId: 'text.transform',
    version: '1',
    packageSpec: '',
    installable: true,
    requirements: {
      signature: { kind: 'catalog-digest', publisher: 'qianshou', value: SHIPPED_ARTICLE_DIGEST },
      packages: [],
      model: '',
      minFreeDiskBytes: 64 * 1024 * 1024,
      minTotalMemoryBytes: 1024 * 1024 * 1024,
    },
  },
  {
    id: 'qianshou.image',
    title: '图片',
    summary: '图片对应 image.generate。本机还不能接，所以不能获取，也不会向上海声明。',
    capabilityId: 'image.generate',
    version: '1',
    packageSpec: '',
    installable: false,
    requirements: {
      signature: { kind: 'catalog-digest', publisher: 'qianshou', value: SHIPPED_IMAGE_DIGEST },
      packages: [],
      model: '',
      minFreeDiskBytes: 0,
      minTotalMemoryBytes: 0,
    },
  },
]

/**
 * Home directory that holds the declaration file.
 * @param env - Process environment. A nonempty `DSH_HOME` wins.
 * @param home - User home used when `DSH_HOME` is absent.
 * @returns The harness home.
 */
export function resolveMarketHome(env: { DSH_HOME?: string } = process.env, home = homedir()): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.deepseek-harness')
}

/**
 * Declaration file written by install and read by the node hello.
 * @param home - Harness home, or the configured `installHome`.
 * @returns Absolute path of `qianshou/market-installed.json`.
 */
export function marketInstallPath(home: string): string {
  return join(home, 'qianshou', 'market-installed.json')
}

/**
 * Whether this computer may advertise the capability as healthy.
 * @param id - Registry capability id from a listing or a saved row.
 * @returns True only for ids this node can accept.
 */
export function isAdvertisableCapability(id: string): boolean {
  return (MARKET_ADVERTISABLE_CAPABILITY_IDS as readonly string[]).includes(id)
}

/**
 * Package identity a market listing expects the profile installer to activate.
 * Market installs accept a named registry release, not a local path, URL, tag or range.
 * @param spec - Signed listing package spec.
 * @returns Exact bundle name and version to compare with Host loading facts, or null.
 */
export function marketBundleIdentity(spec: string): { name: string; version: string } | null {
  const match = MARKET_BUNDLE_SPEC.exec(spec)
  return match?.[1] === undefined || match[2] === undefined ? null : { name: match[1], version: match[2] }
}

/**
 * Whether Get may install this row for private local use.
 * A package-backed listing needs an exact release; preflight requires and verifies a publisher
 * signature before installation. Only the original shipped article may be a declaration
 * without executable code. Neither path authorizes the package for orders.
 * @param listing - One market row.
 * @returns True when this row is eligible to enter install preflight.
 */
export function listingMayInstall(listing: MarketListing): boolean {
  if (!listing.installable) return false
  if (listing.packageSpec !== '') return marketBundleIdentity(listing.packageSpec) !== null
  return listing.id === 'qianshou.article' && listing.capabilityId === 'text.transform'
    && listing.version === '1' && listing.requirements.signature?.kind === 'catalog-digest'
    && listing.requirements.signature.publisher === 'qianshou'
    && listing.requirements.signature.value === SHIPPED_ARTICLE_DIGEST
}

/**
 * Copy a listing with `installable` forced off when this Host cannot install it locally.
 * @param listing - Shipped or API row.
 * @returns The row the PC client is allowed to show as installable.
 */
export function presentListing(listing: MarketListing): MarketListing {
  return { ...listing, installable: listingMayInstall(listing) }
}

/**
 * Built-in catalog. Each call returns new objects.
 * @returns Shipped rows with installability already applied.
 */
export function shippedListings(): MarketListing[] {
  return SHIPPED.map(item => presentListing({ ...item }))
}

/**
 * Validate an API origin the same way the community registry origin is validated.
 * @param input - HTTPS origin, or loopback HTTP for an owned test server.
 * @returns The origin with a trailing slash and no credentials, query, or fragment.
 */
export function marketApiUrl(input: string): URL {
  if (input === '') throw new Error('Market API must be HTTPS without credentials, query or fragment')
  const url = new URL(input)
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || loopback)) {
    throw new Error('Market API must be HTTPS without credentials, query or fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/**
 * Require an absolute install directory when one is configured.
 * @param home - Configured directory, or empty when the harness home should be used.
 * @returns The same directory when it is empty or absolute.
 */
export function assertInstallHome(home: string): string {
  if (home !== '' && !isAbsolute(home)) throw new Error('Market installHome must be an absolute path')
  return home
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedText(value: unknown, length: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > length) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

function byteRequirement(value: unknown): number | null {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_BYTES_REQUIREMENT) return null
  return value
}

/** Missing is distinct from an explicit empty or malformed compatibility claim. */
function supportedList<T extends string>(value: unknown, allowed: readonly T[]): T[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) return null
  if (value.some(item => typeof item !== 'string' || !allowed.includes(item as T)) || new Set(value).size !== value.length) return null
  return value as T[]
}

/** `undefined` rejects the row, `null` means the listing declares no signature. */
function parseSignature(value: unknown): MarketListingSignature | null | undefined {
  if (value === undefined || value === null) return null
  const row = record(value)
  if (row === null) return undefined
  const kind = row.kind
  const publisher = boundedText(row.publisher, 80)
  const signature = boundedText(row.value, 8192)
  if ((kind !== 'catalog-digest' && kind !== 'publisher') || publisher === null || signature === null) return undefined
  return { kind, publisher, value: signature }
}

function parseDependency(value: unknown): MarketDependency | null {
  const row = record(value)
  if (row === null) return null
  const name = boundedText(row.name, 214)
  if (name === null || !PACKAGE_NAME.test(name)) return null
  const declared = row.minimumVersion
  if (declared === undefined || declared === '') return { name, minimumVersion: '' }
  if (typeof declared !== 'string' || !VERSION_PART.test(declared)) return null
  return { name, minimumVersion: declared }
}

/** `null` rejects the row; an absent block means the listing declares no requirements. */
function parseRequirements(value: unknown): MarketListingRequirements | null {
  if (value === undefined) {
    return { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 }
  }
  const row = record(value)
  if (row === null) return null
  if (Object.keys(row).some(key => !REQUIREMENT_FIELDS.has(key))) return null
  const signature = parseSignature(row.signature)
  if (signature === undefined) return null
  if (!Array.isArray(row.packages) || row.packages.length > 16) return null
  const packages: MarketDependency[] = []
  for (const item of row.packages) {
    const dependency = parseDependency(item)
    if (dependency === null) return null
    packages.push(dependency)
  }
  const declaredModel = row.model
  const model = declaredModel === undefined || declaredModel === ''
    ? ''
    : typeof declaredModel === 'string' && ROUTE_ID.test(declaredModel) ? declaredModel : null
  const minFreeDiskBytes = byteRequirement(row.minFreeDiskBytes)
  const minTotalMemoryBytes = byteRequirement(row.minTotalMemoryBytes)
  const platforms = supportedList(row.platforms, PLATFORMS)
  const architectures = supportedList(row.architectures, ARCHITECTURES)
  if (model === null || minFreeDiskBytes === null || minTotalMemoryBytes === null
    || platforms === null || architectures === null) return null
  return { signature, packages, model, minFreeDiskBytes, minTotalMemoryBytes,
    ...(platforms === undefined ? {} : { platforms }),
    ...(architectures === undefined ? {} : { architectures }),
  }
}

/**
 * Parse one API listing. Invalid rows fail the whole document.
 * A row without a `requirements` block declares no requirements, including no signature, so the
 * preflight refuses it at the signature step instead of installing it unverified.
 * @param value - One untrusted object.
 * @returns The listing, or null when a field is missing or out of bounds.
 */
export function parseMarketListing(value: unknown): MarketListing | null {
  const row = record(value)
  if (row === null) return null
  const id = boundedText(row.id, 80)
  const title = boundedText(row.title, 80)
  const summary = boundedText(row.summary, 400)
  const capabilityId = boundedText(row.capabilityId, 80)
  const version = boundedText(row.version, 40)
  const packageSpec = typeof row.packageSpec === 'string' && row.packageSpec.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(row.packageSpec) ? row.packageSpec : null
  const requirements = parseRequirements(row.requirements)
  if (id === null || !LISTING_ID.test(id) || title === null || summary === null || capabilityId === null
    || version === null || packageSpec === null || typeof row.installable !== 'boolean'
    || requirements === null) return null
  return { id, title, summary, capabilityId, version, packageSpec, installable: row.installable, requirements }
}

/**
 * Parse `GET {apiBaseUrl}/plugins`.
 * @param value - Untrusted JSON.
 * @returns Listings, or null when the document is not a bounded listing array.
 */
export function parseMarketCatalogBody(value: unknown): MarketListing[] | null {
  const row = record(value)
  if (row === null || !Array.isArray(row.listings) || row.listings.length > 100) return null
  const listings: MarketListing[] = []
  for (const item of row.listings) {
    const parsed = parseMarketListing(item)
    if (parsed === null || listings.some(existing => existing.id === parsed.id)) return null
    listings.push(presentListing(parsed))
  }
  return listings
}

interface DeclarationState {
  raw: Buffer | null
  installed: MarketInstallRecord[]
  legacy: boolean
  publicDemoted: number
}

function unreadable(): never {
  throw new CatalogFailure('declaration-unreadable')
}

/** Windows 4060-1 wrote `entries/caps`, while Mac wrote `installed/capabilityId` under this name. */
function parseDeclaration(raw: Buffer): DeclarationState {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown
  } catch {
    return unreadable()
  }
  const body = record(parsed)
  if (body === null || body.version !== 1) return unreadable()
  const entries = body.entries
  const legacy = Array.isArray(entries) && body.installed === undefined
  if (legacy) {
    if (!Array.isArray(entries) || Object.keys(body).some(key => key !== 'version' && key !== 'entries') || entries.length > DECLARATION_LIMIT) return unreadable()
    const installed: MarketInstallRecord[] = []
    let publicDemoted = 0
    for (const item of entries) {
      const row = record(item)
      if (row === null || Object.keys(row).some(key => !LEGACY_ENTRY_FIELDS.has(key))) return unreadable()
      const id = boundedText(row.id, 80)
      const version = boundedText(row.version, 40)
      const caps = row.caps
      const declaredAt = row.declaredAt
      const visibility = row.visibility === undefined ? 'draft' : row.visibility
      const invitees = row.invitees === undefined ? [] : row.invitees
      if (id === null || !LISTING_ID.test(id) || version === null ||
        !Array.isArray(caps) || caps.length !== 1 || typeof caps[0] !== 'string' ||
        caps[0].length > 64 || !LEGACY_CAPABILITY.test(caps[0]) ||
        typeof declaredAt !== 'number' || !Number.isSafeInteger(declaredAt) || declaredAt < 0 ||
        !Number.isFinite(new Date(declaredAt).getTime()) ||
        !(CAPABILITY_VISIBILITIES as readonly unknown[]).includes(visibility) ||
        !Array.isArray(invitees) || invitees.length > 64 ||
        invitees.some(value => typeof value !== 'string' || !LEGACY_ACCOUNT_ID.test(value)) ||
        new Set(invitees).size !== invitees.length ||
        (visibility !== 'invite' && invitees.length > 0) ||
        installed.some(existing => existing.id === id)) return unreadable()
      if (visibility === 'public') publicDemoted += 1
      installed.push({
        id, capabilityId: caps[0], version, installedAt: new Date(declaredAt).toISOString(),
        visibility: visibility === 'public' ? 'draft' : visibility as MarketInstallRecord['visibility'],
        inviteAccountIds: invitees as string[],
      })
    }
    return { raw, installed, legacy: true, publicDemoted }
  }
  if (!Array.isArray(body.installed) || Object.keys(body).some(key => key !== 'version' && key !== 'installed') ||
    body.installed.length > DECLARATION_LIMIT) return unreadable()
  const installed: MarketInstallRecord[] = []
  for (const item of body.installed) {
    const row = record(item)
    if (row === null || Object.keys(row).some(key => !['id', 'capabilityId', 'version', 'installedAt', 'packageSpec', 'visibility', 'inviteAccountIds'].includes(key))) return unreadable()
    const id = boundedText(row.id, 80)
    const capabilityId = boundedText(row.capabilityId, 80)
    const version = boundedText(row.version, 40)
    const installedAt = boundedText(row.installedAt, 40)
    const packageSpec = row.packageSpec === undefined ? undefined : row.packageSpec
    const invitees = row.inviteAccountIds === undefined ? [] : parseInviteAccountIds(row.inviteAccountIds)
    if (id === null || !LISTING_ID.test(id) || capabilityId === null || version === null || installedAt === null ||
      invitees === null || (packageSpec !== undefined && (typeof packageSpec !== 'string'
        || packageSpec.length > 200 || /[\u0000-\u001f\u007f]/u.test(packageSpec)
        || (packageSpec !== '' && marketBundleIdentity(packageSpec) === null)))
      || installed.some(existing => existing.id === id)) return unreadable()
    installed.push({ id, capabilityId, version, installedAt,
      ...(packageSpec === undefined ? {} : { packageSpec }),
      visibility: readVisibility(row.visibility), inviteAccountIds: invitees })
  }
  return { raw, installed, legacy: false, publicDemoted: 0 }
}

function loadDeclaration(path: string): DeclarationState {
  try {
    return parseDeclaration(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, installed: [], legacy: false, publicDemoted: 0 }
    }
    if (error instanceof CatalogFailure) throw error
    return unreadable()
  }
}

/** Read either known schema without mutating the file; legacy public rows appear as drafts. */
export function readMarketInstallFile(path: string): MarketInstallRecord[] {
  return loadDeclaration(path).installed
}

/**
 * Raw declaration text, so an install attempt can be rolled back to exactly these bytes.
 * @param path - Absolute declaration path.
 * @returns File text, or null when the file is absent. An unreadable file is an error.
 */
export function readDeclarationBytes(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return unreadable()
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Never replace an earlier backup or receipt, and verify bytes if a prior attempt created one. */
function writeImmutable(path: string, bytes: Buffer): void {
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CatalogFailure('migration-protection-failed')
  }
  try {
    if (!readFileSync(path).equals(bytes)) throw new CatalogFailure('migration-protection-failed')
  } catch {
    throw new CatalogFailure('migration-protection-failed')
  }
}

/** Save the original Windows bytes and a deterministic prepared receipt before replacing them. */
function protectLegacy(path: string, state: DeclarationState, target: Buffer): void {
  if (state.raw === null) throw new CatalogFailure('migration-protection-failed')
  const sourceHash = sha256(state.raw)
  const targetHash = sha256(target)
  const backup = `${path}.windows-v1-${sourceHash}.bak`
  const receipt = `${path}.windows-v1-${sourceHash}-${targetHash}.receipt.json`
  writeImmutable(backup, state.raw)
  const details = {
    schemaFrom: 'windows-entries-v1', schemaTo: 'installed-v1', status: 'prepared',
    backupFile: basename(backup), sourceSha256: sourceHash, targetSha256: targetHash,
    sourceBytes: state.raw.byteLength, records: state.installed.length,
    publicDemotedToDraft: state.publicDemoted,
  }
  writeImmutable(receipt, Buffer.from(`${JSON.stringify(details, null, 2)}\n`))
}

/**
 * Replace the declaration file with exact bytes, through a temporary file and one rename.
 * A legacy Windows file is backed up with its migration receipt before the replacement begins.
 * @param path - Absolute declaration path.
 * @param body - Complete file contents.
 * @param expectedRaw - Optional source bytes read before preparing this write.
 */
export function writeDeclarationBytes(path: string, body: string, expectedRaw?: Buffer | null): void {
  const before = loadDeclaration(path)
  if (expectedRaw !== undefined && !(expectedRaw === null
    ? before.raw === null : before.raw !== null && before.raw.equals(expectedRaw))) {
    throw new CatalogFailure('declaration-changed')
  }
  const target = Buffer.from(body, 'utf8')
  parseDeclaration(target)
  mkdirSync(dirname(path), { recursive: true })
  if (before.legacy) protectLegacy(path, before, target)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, target, { flag: 'wx', mode: 0o600 })
    const now = loadDeclaration(path).raw
    if (!(before.raw === null ? now === null : now !== null && now.equals(before.raw))) {
      throw new CatalogFailure('declaration-changed')
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Replace one id and write the whole file.
 * @param path - Absolute declaration path.
 * @param record - The complete row to save, replacing any row with the same id.
 * @returns The file contents after the write.
 */
export function writeMarketInstall(path: string, record: MarketInstallRecord): MarketInstallRecord[] {
  const before = loadDeclaration(path)
  const installed = before.installed.filter(item => item.id !== record.id)
  installed.push(record)
  installed.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  writeDeclarationBytes(path, `${JSON.stringify({ version: 1, installed }, null, 2)}\n`, before.raw)
  return installed
}

/**
 * Remove exactly one saved declaration, preserving every other row and the legacy backup rules.
 * @param path - Absolute declaration file path.
 * @param id - Listing id to remove.
 * @returns Whether a row was present and removed.
 */
export function removeMarketInstall(path: string, id: string): boolean {
  const before = loadDeclaration(path)
  if (!before.installed.some(item => item.id === id)) return false
  const installed = before.installed.filter(item => item.id !== id)
  writeDeclarationBytes(path, `${JSON.stringify({ version: 1, installed }, null, 2)}\n`, before.raw)
  return true
}

/**
 * Download the API catalog. Redirects and oversized bodies are refused.
 * @param base - Validated API origin.
 * @param signal - Deadline and plugin-lifetime cancellation.
 * @returns Presented listings.
 */
export async function fetchMarketListings(base: URL, signal: AbortSignal): Promise<MarketListing[]> {
  const response = await fetch(new URL('plugins', base), {
    signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' },
  })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new CatalogFailure('unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > RESPONSE_BYTES) throw new CatalogFailure('invalid-response')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      // The body is already consumed or abandoned. Cancellation is cleanup, not a second result.
      void error
    })
    reader.releaseLock()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new CatalogFailure('invalid-response')
  }
  const listings = parseMarketCatalogBody(parsed)
  if (listings === null) throw new CatalogFailure('invalid-response')
  return listings
}

/**
 * Catalog payload for one connection mode.
 * @param mode - Shipped or API.
 * @param source - `shipped`, or the API origin.
 * @param listings - Presented rows.
 * @returns The remote payload.
 */
export function marketCatalog(mode: MarketConnectionMode, source: string, listings: readonly MarketListing[]): MarketCatalog {
  return {
    mode, source, listings: listings.map(item => ({ ...item })),
    releaseSource: '', releaseStatus: 'not-configured', releases: [],
  }
}
