/** Canonicalize author-owned v5 JSON before self-test, signing, and source upload. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readGenericOrderSource } from './generic-order-source.ts'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { CatalogFailure } from './registry.ts'

function invalid(): never { throw new CatalogFailure('order-adapter-invalid') }

/** JSON.parse discards duplicate names; a signed package must reject them first. */
function parseUniqueJson(bytes: Buffer): unknown {
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return invalid() }
  let cursor = 0
  const space = () => { while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor++ }
  const string = (): string => {
    if (source[cursor] !== '"') invalid()
    const start = cursor++
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === '\\') { cursor++; continue }
      if (source[cursor] === '"') {
        cursor++
        try { return JSON.parse(source.slice(start, cursor)) as string }
        catch { return invalid() }
      }
    }
    return invalid()
  }
  const value = (depth: number): void => {
    if (depth > 64) invalid()
    space()
    if (source[cursor] === '{') {
      cursor++; space()
      const keys = new Set<string>()
      if (source[cursor] === '}') { cursor++; return }
      for (;;) {
        const key = string()
        if (keys.has(key)) invalid()
        keys.add(key)
        space()
        if (source[cursor++] !== ':') invalid()
        value(depth + 1)
        space()
        const delimiter = source[cursor++]
        if (delimiter === '}') return
        if (delimiter !== ',') invalid()
        space()
      }
    }
    if (source[cursor] === '[') {
      cursor++; space()
      if (source[cursor] === ']') { cursor++; return }
      for (;;) {
        value(depth + 1)
        space()
        const delimiter = source[cursor++]
        if (delimiter === ']') return
        if (delimiter !== ',') invalid()
      }
    }
    if (source[cursor] === '"') { string(); return }
    const rest = source.slice(cursor)
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(rest)?.[0]
    if (!literal) invalid()
    if (literal[0] === '-' || /\d/u.test(literal[0] ?? '')) {
      const numeric = Number(literal)
      if (!Number.isFinite(numeric)
        || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric))) invalid()
    }
    cursor += literal.length
  }
  value(0)
  space()
  if (cursor !== source.length) invalid()
  try { return JSON.parse(source) as unknown }
  catch { return invalid() }
}

export function canonicalSourceJson(bytes: Buffer): Buffer {
  return Buffer.from(canonicalOrderJson(parseUniqueJson(bytes)), 'utf8')
}

/** Direct archive callers cannot bypass the same contract the off-box issuer checks. */
export function assertCanonicalSourceJson(files: readonly { path: string; bytes: Buffer }[]): void {
  for (const file of files) {
    if (file.path.endsWith('.json') && !file.bytes.equals(canonicalSourceJson(file.bytes))) invalid()
  }
}

/**
 * Normalize all JSON members of an installed v5 skill. The source is re-read and self-tested
 * after this step; an edit racing with normalization cannot be submitted under an old digest.
 * Legacy v1 skills are left untouched.
 */
export async function normalizeGenericOrderSourceJson(skillPath: string): Promise<boolean> {
  const descriptor = join(dirname(skillPath), 'scripts', 'order_adapter', 'local-adapter.json')
  let descriptorStat
  try { descriptorStat = await lstat(descriptor) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return invalid()
  }
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) invalid()
  const declaration = parseUniqueJson(await readFile(descriptor))
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) invalid()
  if (!['qianshou.local-adapter-candidate.v2', 'qianshou.local-adapter-candidate.v3']
    .includes(String((declaration as Record<string, unknown>).schema))) return false
  const source = await readGenericOrderSource(skillPath, { forNormalization: true })
  for (const file of source.files) {
    if (!file.path.endsWith('.json')) continue
    const normalized = canonicalSourceJson(file.bytes)
    if (normalized.equals(file.bytes)) continue
    const path = join(source.root, file.path)
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()
      || !(await readFile(path)).equals(file.bytes)) invalid()
    const temporary = join(dirname(path), `.qianshou-json-${randomBytes(12).toString('hex')}.tmp`)
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try { await handle.writeFile(normalized); await handle.sync() }
      finally { await handle.close() }
      const current = await lstat(path)
      if (current.ino !== before.ino || current.dev !== before.dev
        || current.mtimeMs !== before.mtimeMs || current.size !== before.size
        || !(await readFile(path)).equals(file.bytes)) invalid()
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  const final = await readGenericOrderSource(skillPath)
  assertCanonicalSourceJson(final.files)
  return true
}
