/** A small Host-owned selection record. It chooses an installed executor, not an owner grant. */
import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLocalTextStatisticsOrderBinding, type LocalTextStatisticsOrderBinding } from './local-plugin-order.ts'

export type OrderExecutorSelection = { readonly kind: 'builtin' } | {
  readonly kind: 'plugin'; readonly binding: LocalTextStatisticsOrderBinding
}

const FILE_NAME = 'qianshou-order-executor.json'
const MAX_BYTES = 2048

function parse(value: unknown): OrderExecutorSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  const record = value as Record<string, unknown>
  if (record.version !== 1 && record.version !== 2) throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  if (record.kind === 'builtin' && Object.keys(record).length === 2) return { kind: 'builtin' }
  if (record.kind !== 'plugin' || Object.keys(record).length !== 3
    || typeof record.binding !== 'object' || record.binding === null || Array.isArray(record.binding)) {
    throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  }
  const binding = record.binding as Record<string, unknown>
  if (Object.keys(binding).length !== (record.version === 1 ? 3 : 4)
    || typeof binding.packageName !== 'string' || typeof binding.toolName !== 'string'
    || typeof binding.packageDigest !== 'string'
    || (record.version === 2 && typeof binding.taskType !== 'string')) {
    throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  }
  const resolved = resolveLocalTextStatisticsOrderBinding(binding as unknown as LocalTextStatisticsOrderBinding)
  if (resolved === null) throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  return { kind: 'plugin', binding: resolved }
}

/** Load one profile's saved choice. A changed or malformed record blocks selection instead of falling back. */
export function loadOrderExecutorSelection(profileDir: string | undefined, fallback: OrderExecutorSelection): {
  selection: OrderExecutorSelection; valid: boolean; fromSelectionFile: boolean
} {
  if (profileDir === undefined) return { selection: fallback, valid: true, fromSelectionFile: false }
  try {
    const path = join(profileDir, FILE_NAME)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
      throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
    }
    const info = readFileSync(path)
    if (info.byteLength !== stat.size) throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
    return { selection: parse(JSON.parse(info.toString('utf8')) as unknown), valid: true,
      fromSelectionFile: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { selection: fallback, valid: true,
      fromSelectionFile: false }
    return { selection: fallback, valid: false, fromSelectionFile: false }
  }
}

/** Persist only a validated choice in the trusted profile directory, with no automatic grant. */
export async function saveOrderExecutorSelection(profileDir: string, selection: OrderExecutorSelection): Promise<void> {
  const normalized = parse({ version: 2, ...selection })
  const path = join(profileDir, FILE_NAME)
  try {
    const existing = await lstat(path)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('ORDER_EXECUTOR_SELECTION_INVALID')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(profileDir, `${FILE_NAME}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ version: 2, ...normalized })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    // A read after rename makes an uncertain filesystem result explicit to the caller.
    if (JSON.stringify(parse(JSON.parse(await readFile(path, 'utf8') as string) as unknown)) !== JSON.stringify(normalized)) {
      throw new Error('ORDER_EXECUTOR_SELECTION_WRITE_MISMATCH')
    }
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}
