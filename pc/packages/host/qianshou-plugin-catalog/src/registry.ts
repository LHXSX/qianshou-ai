/** Bounded metadata-only access to one deployment-selected public registry. */
import type { CatalogEntry, CatalogFailureCode, CatalogPage, CatalogQuery } from './types.ts'

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const RESPONSE_BYTES = 1024 * 1024
const PAGE_SIZE = 12

/** Error messages deliberately contain only stable codes. */
export class CatalogFailure extends Error {
  constructor(readonly code: CatalogFailureCode) { super(`QIANSHOU_CATALOG_${code}`) }
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, length: number): string | null {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length) : null
}
function webLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}
/**
 * Validate operator configuration; clients cannot provide network destinations.
 * @param input - HTTPS registry, or loopback HTTP for an owned test registry.
 * @returns Normalized source URL without credentials, query or fragment.
 */
export function registryUrl(input: string): URL {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('Catalog registry must be HTTPS without credentials, query or fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}
/**
 * Validate the external request before using it in a registry query.
 * @param input - Untrusted Remote input.
 * @returns Bounded query with no search operators.
 */
export function parseQuery(input: unknown): CatalogQuery {
  const value = record(input)
  if (!value || typeof value.query !== 'string' || value.query.length > 120 ||
    typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 1200 || value.offset % PAGE_SIZE !== 0 ||
    /[\u0000-\u001f\u007f:]/.test(value.query)) throw new CatalogFailure('invalid-query')
  return { query: value.query.trim(), offset: value.offset }
}
async function json(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new CatalogFailure('unavailable') }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > RESPONSE_BYTES) throw new CatalogFailure('invalid-response')
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new CatalogFailure('invalid-response') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
function entry(value: unknown, name: string, version: string, source: URL): CatalogEntry | null {
  const manifest = record(value)
  if (!manifest || manifest.name !== name || manifest.version !== version) throw new CatalogFailure('invalid-response')
  const bundle = record(record(manifest.dsh)?.bundle)?.patch
  if (typeof bundle !== 'string' || !bundle.trim() || bundle.length > 2048) return null
  return { name, version, description: text(manifest.description, 600) ?? '',
    publisher: text(record(manifest._npmUser)?.name, 120), license: text(manifest.license, 100),
    homepage: webLink(manifest.homepage), packageUrl: source.origin === 'https://registry.npmjs.org'
      ? `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}`
      : new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, source).href,
    installSpec: `${name}@${version}` }
}
/**
 * Search metadata and check exact manifests, at most four simultaneous reads.
 * @param source - Validated deployment registry.
 * @param query - Validated search and offset.
 * @param signal - Deadline and plugin-lifetime cancellation.
 * @returns Verified bundle declarations with partial failures counted separately.
 */
export async function searchRegistry(source: URL, query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
  const url = new URL('-/v1/search', source)
  url.searchParams.set('text', `keywords:dsh-plugin ${query.query}`.trim())
  url.searchParams.set('size', String(PAGE_SIZE)); url.searchParams.set('from', String(query.offset))
  const response = record(await json(url, signal))
  if (!response || !Array.isArray(response.objects) || response.objects.length > PAGE_SIZE ||
    typeof response.total !== 'number' || !Number.isSafeInteger(response.total) || response.total < 0) throw new CatalogFailure('invalid-response')
  const objects = response.objects as unknown[]
  const results: (CatalogEntry | null)[] = Array.from({ length: objects.length }, () => null)
  let cursor = 0; let excluded = 0; let unavailable = 0
  await Promise.all(Array.from({ length: Math.min(4, objects.length) }, async () => {
    while (cursor < objects.length) {
      const index = cursor++; const candidate = record(record(objects[index])?.package)
      const name = candidate?.name; const version = candidate?.version
      if (typeof name !== 'string' || name.length > 214 || !NAME.test(name) || typeof version !== 'string' || version.length > 100 || !VERSION.test(version)) { excluded++; continue }
      try {
        const item = entry(await json(new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, source), signal), name, version, source)
        if (item) results[index] = item; else excluded++
      } catch { unavailable++ }
    }
  }))
  if (signal.aborted) throw new CatalogFailure('unavailable')
  return { source: source.href, query: query.query, offset: query.offset,
    nextOffset: query.offset + PAGE_SIZE < response.total && query.offset < 1200 && objects.length > 0 ? query.offset + PAGE_SIZE : null,
    checkedAt: Date.now(), candidates: objects.length, excluded, unavailable,
    entries: results.filter((value): value is CatalogEntry => value !== null) }
}
