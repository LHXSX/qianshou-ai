/** Public, read-only plugin catalog. Product approval remains an operator-owned file. */
import { createPublicKey, verify } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'

/** Mac API mode requests GET `{apiBaseUrl}/plugins` without browser credentials. */
export const PLUGIN_MARKET_PATH = '/qianshou-market/plugins'
const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_REQUIREMENT_BYTES = 1024 * 1024 * 1024 * 1024 * 1024
const CONTROL = /[\u0000-\u001f\u007f]/u
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const PACKAGE = /^[a-z0-9][a-z0-9._~-]{0,213}$/u
const VERSION = /^v?\d+(?:\.\d+){0,3}$/u
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const

interface Dependency { readonly name: string; readonly minimumVersion: string }
interface Requirements {
  readonly signature: { readonly kind: 'publisher'; readonly publisher: string; readonly value: string }
  readonly packages: readonly Dependency[]
  readonly model: string
  readonly minFreeDiskBytes: number
  readonly minTotalMemoryBytes: number
  readonly platforms?: readonly (typeof PLATFORMS)[number][]
  readonly architectures?: readonly (typeof ARCHITECTURES)[number][]
}

/** The server has no executable-capability certification yet, so every listing stays informational. */
export interface ApprovedPluginListing {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly capabilityId: string
  readonly version: string
  readonly packageSpec: string
  readonly installable: false
  readonly requirements: Requirements
}

/** Only an operator-supplied signed file may populate the public catalog. */
export interface PluginMarketOptions {
  readonly catalogPath?: string
  /** Publisher id to base64 SPKI DER Ed25519 public key. No private key belongs here. */
  readonly publisherKeys?: Readonly<Record<string, string>>
}

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function text(value: unknown, max: number, empty = false): string | null {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !CONTROL.test(value) ? value : null
}

function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REQUIREMENT_BYTES ? value : null
}

function enumList<T extends string>(value: unknown, choices: readonly T[]): readonly T[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > choices.length) return null
  if (value.some(item => typeof item !== 'string' || !choices.includes(item as T)) || new Set(value).size !== value.length) return null
  return value as T[]
}

/** This byte order must match Mac `qianshou-plugin-catalog/declarationBytes`. */
function declarationBytes(listing: ApprovedPluginListing): string {
  const { packages, model, minFreeDiskBytes, minTotalMemoryBytes, platforms, architectures } = listing.requirements
  return JSON.stringify({
    id: listing.id,
    capabilityId: listing.capabilityId,
    version: listing.version,
    packageSpec: listing.packageSpec,
    packages: packages.map(item => ({ name: item.name, minimumVersion: item.minimumVersion })),
    model,
    minFreeDiskBytes,
    minTotalMemoryBytes,
    ...(platforms === undefined ? {} : { platforms }),
    ...(architectures === undefined ? {} : { architectures }),
  })
}

function approvedListing(value: unknown, publisherKeys: Readonly<Record<string, string>>): ApprovedPluginListing | null {
  const item = row(value)
  if (item === null || !hasOnly(item, ['id', 'title', 'summary', 'capabilityId', 'version', 'packageSpec', 'installable', 'requirements'])) return null
  const id = text(item.id, 80)
  const title = text(item.title, 80)
  const summary = text(item.summary, 400)
  const capabilityId = text(item.capabilityId, 80)
  const version = text(item.version, 40)
  const packageSpec = text(item.packageSpec, 200, true)
  // This read API does not certify that any PC can install or execute a product.
  if (id === null || !ID.test(id) || title === null || summary === null || capabilityId === null
    || !CAPABILITY.test(capabilityId) || version === null || packageSpec === null || item.installable !== false) return null
  const requirements = row(item.requirements)
  if (requirements === null || !hasOnly(requirements,
    ['signature', 'packages', 'model', 'minFreeDiskBytes', 'minTotalMemoryBytes', 'platforms', 'architectures'])) return null
  const signature = row(requirements.signature)
  if (signature === null || !hasOnly(signature, ['kind', 'publisher', 'value']) || signature.kind !== 'publisher') return null
  const publisher = text(signature.publisher, 80)
  const signed = text(signature.value, 8192)
  if (publisher === null || signed === null || !/^[A-Za-z0-9+/_=-]+$/u.test(signed)
    || !Array.isArray(requirements.packages) || requirements.packages.length > 16) return null
  const packages: Dependency[] = []
  for (const raw of requirements.packages) {
    const dependency = row(raw)
    if (dependency === null || !hasOnly(dependency, ['name', 'minimumVersion'])) return null
    const name = text(dependency.name, 214)
    const minimumVersion = text(dependency.minimumVersion, 40, true)
    if (name === null || !PACKAGE.test(name) || minimumVersion === null
      || (minimumVersion !== '' && !VERSION.test(minimumVersion))) return null
    packages.push({ name, minimumVersion })
  }
  const model = text(requirements.model, 80, true)
  const minFreeDiskBytes = bytes(requirements.minFreeDiskBytes)
  const minTotalMemoryBytes = bytes(requirements.minTotalMemoryBytes)
  const platforms = enumList(requirements.platforms, PLATFORMS)
  const architectures = enumList(requirements.architectures, ARCHITECTURES)
  if (model === null || (model !== '' && !MODEL.test(model)) || minFreeDiskBytes === null
    || minTotalMemoryBytes === null || platforms === null || architectures === null) return null
  const listing: ApprovedPluginListing = {
    id, title, summary, capabilityId, version, packageSpec, installable: false,
    requirements: { signature: { kind: 'publisher', publisher, value: signed }, packages, model,
      minFreeDiskBytes, minTotalMemoryBytes,
      ...(platforms === undefined ? {} : { platforms }),
      ...(architectures === undefined ? {} : { architectures }),
    },
  }
  const encodedKey = Object.hasOwn(publisherKeys, publisher) ? publisherKeys[publisher] : undefined
  if (encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) return null
  try {
    const publicKey = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    const signatureBytes = Buffer.from(signed, 'base64')
    return publicKey.asymmetricKeyType === 'ed25519' && signatureBytes.length === 64
      && verify(null, Buffer.from(declarationBytes(listing), 'utf8'), publicKey, signatureBytes) ? listing : null
  } catch {
    return null
  }
}

/** Read one complete snapshot; an invalid row never yields a partial public catalog. */
export async function readApprovedPluginCatalog(options: PluginMarketOptions): Promise<readonly ApprovedPluginListing[]> {
  if (options.catalogPath === undefined || options.catalogPath === '') return []
  if (!isAbsolute(options.catalogPath)) throw new Error('PLUGIN_CATALOG_PATH_INVALID')
  const handle = await open(options.catalogPath, 'r')
  let raw: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_CATALOG_BYTES) throw new Error('PLUGIN_CATALOG_INVALID')
    raw = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (raw.length > MAX_CATALOG_BYTES) throw new Error('PLUGIN_CATALOG_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_CATALOG_INVALID') }
  const document = row(parsed)
  if (document === null || !hasOnly(document, ['version', 'listings']) || document.version !== 1
    || !Array.isArray(document.listings) || document.listings.length > 100) throw new Error('PLUGIN_CATALOG_INVALID')
  const listings: ApprovedPluginListing[] = []
  const keys = options.publisherKeys ?? {}
  for (const rawListing of document.listings) {
    const listing = approvedListing(rawListing, keys)
    if (listing === null || listings.some(previous => previous.id === listing.id)) throw new Error('PLUGIN_CATALOG_INVALID')
    listings.push(listing)
  }
  if (Buffer.byteLength(JSON.stringify({ listings }), 'utf8') > MAX_CATALOG_BYTES) throw new Error('PLUGIN_CATALOG_INVALID')
  return listings
}

/** Register outside `/api`, whose browser-cookie gate cannot serve the Mac Host's anonymous fetch. */
export function createPluginMarketRoute(options: PluginMarketOptions): {
  readonly kind: 'exact'
  readonly path: typeof PLUGIN_MARKET_PATH
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
} {
  if (options.catalogPath !== undefined && options.catalogPath !== '' && !isAbsolute(options.catalogPath)) {
    throw new Error('PLUGIN_CATALOG_PATH_INVALID')
  }
  return {
    kind: 'exact', path: PLUGIN_MARKET_PATH,
    handler: async (request, response) => {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }
      if (request.method !== 'GET') {
        response.writeHead(405, { ...headers, allow: 'GET' })
        response.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED' } }))
        return
      }
      try {
        const listings = await readApprovedPluginCatalog(options)
        response.writeHead(200, headers)
        response.end(JSON.stringify({ listings }))
      } catch {
        response.writeHead(503, headers)
        response.end(JSON.stringify({ error: { code: 'PLUGIN_CATALOG_UNAVAILABLE' } }))
      }
    },
  }
}
