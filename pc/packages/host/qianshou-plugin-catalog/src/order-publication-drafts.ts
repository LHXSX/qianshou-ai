/** Private author review notes. This file never feeds node hello or Shanghai APIs. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CatalogFailure } from './registry.ts'
import type { LocalOrderPublicationDraft, LocalOrderPublicationDraftInput } from './types.ts'

const ID = /^plugin_draft_[0-9a-f-]{36}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const PRICE = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/u
const MAX_BYTES = 64 * 1024
const CATEGORIES = new Set(['text', 'data', 'automation'])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** Validate owner-editable metadata without accepting a path, executable or platform state. */
export function parseOrderPublicationDraftInput(value: unknown): LocalOrderPublicationDraftInput {
  const row = record(value)
  if (row === null || Object.keys(row).length !== 7 || typeof row.draftId !== 'string' || !ID.test(row.draftId)
    || typeof row.packageDigest !== 'string' || !DIGEST.test(row.packageDigest)
    || typeof row.name !== 'string' || row.name.trim().length < 1 || row.name.length > 80 || CONTROL.test(row.name)
    || typeof row.purpose !== 'string' || row.purpose.trim().length < 1 || row.purpose.length > 500 || CONTROL.test(row.purpose)
    || typeof row.category !== 'string' || !CATEGORIES.has(row.category)
    || typeof row.configuration !== 'string' || row.configuration.length > 1000 || CONTROL.test(row.configuration)
    || !(row.salePriceYuan === null || typeof row.salePriceYuan === 'string' && PRICE.test(row.salePriceYuan)
      && Number(row.salePriceYuan) > 0 && Number(row.salePriceYuan) <= 100000)) {
    throw new CatalogFailure('order-draft-invalid')
  }
  return { draftId: row.draftId, packageDigest: row.packageDigest, name: row.name.trim(),
    purpose: row.purpose.trim(), category: row.category as LocalOrderPublicationDraft['category'],
    configuration: row.configuration.trim(), salePriceYuan: row.salePriceYuan as string | null }
}

export function orderPublicationDraftPath(home: string): string {
  return join(home, 'qianshou', 'order-publication-drafts.json')
}

function validSaved(value: unknown): value is LocalOrderPublicationDraft {
  const row = record(value)
  if (row === null || row.state !== 'local-draft' || typeof row.savedAt !== 'number'
    || !Number.isSafeInteger(row.savedAt) || row.savedAt < 0) return false
  const contract = record(row.taskContract)
  if (contract === null || contract.version !== 1 || contract.capabilityId !== 'text.transform'
    || contract.taskType !== 'word_count' || contract.inputKind !== 'inline'
    || contract.outputKind !== 'inline_json' || contract.contractVersion !== 'v1') return false
  try {
    parseOrderPublicationDraftInput({ draftId: row.draftId, packageDigest: row.packageDigest,
      name: row.name, purpose: row.purpose, category: row.category,
      configuration: row.configuration, salePriceYuan: row.salePriceYuan })
    return true
  } catch { return false }
}

/** Reject symlinks and oversized or malformed files; corruption never becomes an empty draft list. */
export async function readOrderPublicationDrafts(path: string): Promise<LocalOrderPublicationDraft[]> {
  let raw: string
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new CatalogFailure('order-draft-unavailable')
      raw = await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new CatalogFailure('order-draft-unavailable')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { throw new CatalogFailure('order-draft-unavailable') }
  const body = record(parsed)
  if (body?.version !== 1 || !Array.isArray(body.drafts) || body.drafts.length > 20) {
    throw new CatalogFailure('order-draft-unavailable')
  }
  // Early local drafts used the former balance label. The stored numeric amount
  // is unchanged; only the field name now reflects the platform's CNY ledger.
  const drafts: unknown[] = body.drafts.map(item => {
    const row = record(item)
    if (row === null || !Object.hasOwn(row, 'salePriceEdg') || Object.hasOwn(row, 'salePriceYuan')) return item
    const { salePriceEdg, ...rest } = row
    return { ...rest, salePriceYuan: salePriceEdg }
  })
  if (!drafts.every(validSaved)) throw new CatalogFailure('order-draft-unavailable')
  if (new Set(drafts.map(item => item.draftId)).size !== drafts.length) {
    throw new CatalogFailure('order-draft-unavailable')
  }
  return drafts as LocalOrderPublicationDraft[]
}

/** Atomic, owner-only local save; this changes no installed package and sends no request. */
export async function writeOrderPublicationDrafts(path: string, drafts: readonly LocalOrderPublicationDraft[]): Promise<void> {
  if (drafts.length > 20 || !drafts.every(validSaved)) throw new CatalogFailure('order-draft-invalid')
  const directory = dirname(path)
  let temporary: string | null = null
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory')
    temporary = join(directory, `.order-publication-${randomUUID()}.tmp`)
    const bytes = JSON.stringify({ version: 1, drafts }) + '\n'
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('drafts too large')
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch {
    throw new CatalogFailure('order-draft-unavailable')
  } finally { if (temporary !== null) await rm(temporary, { force: true }).catch(() => {}) }
}
