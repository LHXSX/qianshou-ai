/** One reviewed, data-only official seed plugin with a bounded Host-owned CSV executor.
 *
 * This private development installation is deliberately separate from a Guangzhou purchase,
 * a market declaration and Shanghai order admission. The archive carries no executable code.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { inspectReviewedArchive, readReviewedArchiveEntry } from './reviewed-archive.ts'

export const CSV_SEED_IDENTITY = Object.freeze({
  format: 'qianshou.seed-csv-profile.v1',
  releaseId: 'qianshou.csv-profile-1.0.0',
  pluginId: 'qianshou.csv-profile',
  version: '1.0.0',
  operationId: 'csv.profile',
  capabilityId: 'text.transform',
  executorId: 'qianshou.csv-profile.adapter.v1',
  packageSha256: '257064f2a39b3b5bf4a410bebfba138af769bf4e1a7a23054b3aa31ca993f480',
  packageBytes: 3058,
  inputSchemaSha256: 'a7889e85c462a9d0670d2fb7d79e9a5ebefceba8e978bde8bc2e22184f07ab39',
  outputSchemaSha256: '4d00a76260d9603aac9e4bbf611825f1af22b3c6259a7dc042534e34d9ed1623',
})

const ENTRIES = Object.freeze({
  'manifest.json': 'da9306db2d03ed0c9eb30e41ae02249724331cc20404d35f12a41122f3778edf',
  'schemas/input.json': CSV_SEED_IDENTITY.inputSchemaSha256,
  'schemas/output.json': CSV_SEED_IDENTITY.outputSchemaSha256,
  'samples/basic-input.json': 'd631d6e656103625f66e4a9103da8302cdc058e5066a9c4e8641575d160b539d',
  'samples/basic-output.json': 'ec9950de6d8034de2ef2d03ab5c1717c44ca1894555ea24077f7d03d3efa860f',
})
const MANIFEST_KEYS = ['format', 'releaseId', 'pluginId', 'version', 'operationId',
  'capabilityId', 'executorId', 'inputSchemaSha256', 'outputSchemaSha256'] as const
const MAX_INPUT_BYTES = 1_048_576
const MAX_ROWS = 10_000
const MAX_COLUMNS = 64
const MAX_CELLS = 200_000
const MAX_CELL_LENGTH = 32_768
const MAX_ARCHIVE_BYTES = 65_536
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
const DECODER = new TextDecoder('utf-8', { fatal: true })

export interface CsvProfileInput {
  readonly csv: string
  readonly delimiter?: ',' | ';' | '\t'
  readonly header?: boolean
  readonly sampleRows?: number
}

export interface CsvProfileOutput {
  readonly rowCount: number
  readonly columnCount: number
  readonly delimiter: ',' | ';' | '\t'
  readonly columns: readonly { readonly index: number; readonly name: string;
    readonly nonEmptyCount: number; readonly emptyCount: number;
    readonly kind: 'empty' | 'number' | 'text' | 'mixed' }[]
  readonly sampleRows: readonly (readonly string[])[]
}

export interface CsvSeedPackage {
  readonly identity: typeof CSV_SEED_IDENTITY
  readonly archivePath: string
  readonly samplePassed: true
  readonly scope: 'private-local'
  readonly dispatchable: false
}

function invalid(): never { throw new Error('QIANSHOU_CSV_SEED_INVALID') }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(DECODER.decode(bytes)) as unknown } catch { return invalid() }
}

/** Trusted v1 adapter. Callers must independently admit the exact reviewed package before use. */
export function executeOfficialCsvProfile(raw: unknown): CsvProfileOutput {
  const input = object(raw)
  if (input === null || Object.keys(input).some(key => !['csv', 'delimiter', 'header', 'sampleRows'].includes(key))
    || typeof input.csv !== 'string' || Buffer.byteLength(input.csv, 'utf8') > MAX_INPUT_BYTES
    || input.csv.length === 0 || input.csv.includes('\0')
    || (input.delimiter !== undefined && input.delimiter !== ',' && input.delimiter !== ';' && input.delimiter !== '\t')
    || (input.header !== undefined && typeof input.header !== 'boolean')
    || (input.sampleRows !== undefined && (!Number.isInteger(input.sampleRows)
      || (input.sampleRows as number) < 1 || (input.sampleRows as number) > 20))) invalid()
  const delimiter = (input.delimiter ?? ',') as CsvProfileOutput['delimiter']
  const header = input.header ?? true
  const requestedSamples = (input.sampleRows ?? 5) as number
  const csv = input.csv.startsWith('\ufeff') ? input.csv.slice(1) : input.csv
  const records: string[][] = []
  let cells = 0
  let row: string[] = []
  let cell = ''
  let state: 'start' | 'plain' | 'quoted' | 'after-quote' = 'start'
  let touched = false
  const pushCell = () => {
    if (cell.length > MAX_CELL_LENGTH || row.length >= MAX_COLUMNS) invalid()
    row.push(cell)
    cell = ''
    cells += 1
    if (cells > MAX_CELLS) invalid()
  }
  const pushRow = () => {
    if (touched || row.length > 0 || cell.length > 0) {
      pushCell()
      if (records.length >= MAX_ROWS + 1) invalid()
      if (records.length > 0 && row.length !== records[0]!.length) invalid()
      records.push(row)
    }
    row = []
    touched = false
  }
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!
    if (state === 'quoted') {
      if (char === '"') {
        if (csv[index + 1] === '"') { cell += '"'; index += 1 }
        else state = 'after-quote'
      } else if (char === '\r' && csv[index + 1] === '\n') { cell += '\n'; index += 1 }
      else cell += char
      if (cell.length > MAX_CELL_LENGTH) invalid()
      continue
    }
    if (char === delimiter) {
      pushCell(); touched = true; state = 'start'; continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[index + 1] === '\n') index += 1
      pushRow(); state = 'start'; continue
    }
    if (char === '"') {
      if (state !== 'start') invalid()
      state = 'quoted'; touched = true; continue
    }
    if (state === 'after-quote') invalid()
    cell += char
    touched = true
    state = 'plain'
    if (cell.length > MAX_CELL_LENGTH) invalid()
  }
  if (state === 'quoted') invalid()
  pushRow()
  if (records.length === 0 || records[0]!.length === 0) invalid()
  const names = header ? records[0]! : records[0]!.map((_, index) => `column_${index + 1}`)
  const data = header ? records.slice(1) : records
  if (data.length > MAX_ROWS) invalid()
  const columns = names.map((name, index) => {
    let nonEmptyCount = 0
    let numberCount = 0
    for (const record of data) {
      const value = record[index]!.trim()
      if (value === '') continue
      nonEmptyCount += 1
      if (NUMBER.test(value) && Number.isFinite(Number(value))) numberCount += 1
    }
    const kind: CsvProfileOutput['columns'][number]['kind'] = nonEmptyCount === 0 ? 'empty' : numberCount === nonEmptyCount ? 'number'
      : numberCount === 0 ? 'text' : 'mixed'
    return { index, name: name === '' ? `column_${index + 1}` : name,
      nonEmptyCount, emptyCount: data.length - nonEmptyCount, kind }
  })
  return { rowCount: data.length, columnCount: names.length, delimiter, columns,
    sampleRows: data.slice(0, requestedSamples).map(record => [...record]) }
}

/** Verify the exact five-file seed archive and run the packaged sample using the Host adapter. */
export async function inspectOfficialCsvSeedArchive(archivePath: string,
  signal: AbortSignal): Promise<CsvSeedPackage> {
  if (!isAbsolute(archivePath)) invalid()
  signal.throwIfAborted()
  const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== CSV_SEED_IDENTITY.packageBytes
      || (stat.mode & 0o077) !== 0 || stat.size > MAX_ARCHIVE_BYTES) invalid()
    const bytes = await handle.readFile()
    if (hash(bytes) !== CSV_SEED_IDENTITY.packageSha256) invalid()
  } finally { await handle.close() }
  const entries = await inspectReviewedArchive(archivePath, CSV_SEED_IDENTITY.packageBytes, signal)
  if (entries.length !== Object.keys(ENTRIES).length
    || entries.some(entry => !Object.hasOwn(ENTRIES, entry.path)
      || ENTRIES[entry.path as keyof typeof ENTRIES] !== entry.sha256)) invalid()
  const read = async (path: keyof typeof ENTRIES) => readReviewedArchiveEntry(archivePath,
    CSV_SEED_IDENTITY.packageBytes, path, ENTRIES[path], 16_384, signal)
  const manifest = object(parseJson(await read('manifest.json')))
  if (manifest === null || !exact(manifest, MANIFEST_KEYS)
    || MANIFEST_KEYS.some(key => manifest[key] !== CSV_SEED_IDENTITY[key])) invalid()
  // These hashes pin the full schemas to the reviewed adapter contract, not just their IDs.
  const inputSchema = object(parseJson(await read('schemas/input.json')))
  const outputSchema = object(parseJson(await read('schemas/output.json')))
  if (inputSchema?.type !== 'object' || outputSchema?.type !== 'object') invalid()
  const sample = parseJson(await read('samples/basic-input.json'))
  const expected = parseJson(await read('samples/basic-output.json'))
  if (JSON.stringify(executeOfficialCsvProfile(sample)) !== JSON.stringify(expected)) invalid()
  return Object.freeze({ identity: CSV_SEED_IDENTITY, archivePath,
    samplePassed: true as const, scope: 'private-local' as const, dispatchable: false as const })
}

export interface PrivateCsvSeedInstallRequest {
  readonly sourceArchivePath: string
  /** Existing owner-only 0700 directory; the original source archive is never executed. */
  readonly privateDir: string
  readonly signal: AbortSignal
  /** Owner must approve this exact package digest in the active local session. */
  readonly approveOwner: (packageSha256: string, signal: AbortSignal) => Promise<boolean>
}

/** Copy an exact artifact into an owner-only directory; install remains private and non-dispatchable. */
export async function installPrivateOfficialCsvSeed(request: PrivateCsvSeedInstallRequest): Promise<CsvSeedPackage> {
  if (!isAbsolute(request.privateDir) || !isAbsolute(request.sourceArchivePath)
    || typeof request.approveOwner !== 'function') invalid()
  const dir = await lstat(request.privateDir)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) invalid()
  const source = await open(request.sourceArchivePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = await source.stat()
    if (!stat.isFile() || stat.size !== CSV_SEED_IDENTITY.packageBytes) invalid()
    bytes = await source.readFile()
  } finally { await source.close() }
  if (hash(bytes) !== CSV_SEED_IDENTITY.packageSha256) invalid()
  const trialPath = join(request.privateDir, `.csv-seed-${randomUUID()}.qspkg`)
  try {
    await writeFile(trialPath, bytes, { flag: 'wx', mode: 0o600 })
    await inspectOfficialCsvSeedArchive(trialPath, request.signal)
    request.signal.throwIfAborted()
    if (!await request.approveOwner(CSV_SEED_IDENTITY.packageSha256, request.signal)) invalid()
    request.signal.throwIfAborted()
    const archivePath = join(request.privateDir, `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.qspkg`)
    const recordPath = join(request.privateDir, `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.json`)
    let createdArchive = false
    try {
      await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 })
      createdArchive = true
      await inspectOfficialCsvSeedArchive(archivePath, request.signal)
      await writeFile(recordPath, JSON.stringify({ format: 'qianshou.private-csv-seed-install.v1',
        packageSha256: CSV_SEED_IDENTITY.packageSha256, archiveName: `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.qspkg`,
        operationId: CSV_SEED_IDENTITY.operationId, scope: 'private-local', dispatchable: false }) + '\n',
      { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (createdArchive) await rm(archivePath, { force: true })
      throw error
    }
    return { identity: CSV_SEED_IDENTITY, archivePath, samplePassed: true,
      scope: 'private-local', dispatchable: false }
  } finally { await rm(trialPath, { force: true }) }
}

/** Read-only verification of the exact private receipt and archive; it does not run CSV work. */
export async function verifyPrivateOfficialCsvSeedInstallation(privateDir: string,
  signal: AbortSignal): Promise<void> {
  if (!isAbsolute(privateDir)) invalid()
  const dir = await lstat(privateDir)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) invalid()
  const recordPath = join(privateDir, `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.json`)
  const recordHandle = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let record: Record<string, unknown> | null
  try {
    const stat = await recordHandle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2048) invalid()
    record = object(parseJson(await recordHandle.readFile()))
  } finally { await recordHandle.close() }
  if (record === null || !exact(record, ['format', 'packageSha256', 'archiveName', 'operationId', 'scope', 'dispatchable'])
    || record.format !== 'qianshou.private-csv-seed-install.v1'
    || record.packageSha256 !== CSV_SEED_IDENTITY.packageSha256
    || record.archiveName !== `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.qspkg`
    || record.operationId !== CSV_SEED_IDENTITY.operationId
    || record.scope !== 'private-local' || record.dispatchable !== false) invalid()
  const archivePath = join(privateDir, record.archiveName as string)
  await inspectOfficialCsvSeedArchive(archivePath, signal)
  signal.throwIfAborted()
}

/** Recheck the installed archive and receipt on every local use; a receipt alone never grants orders. */
export async function runPrivateOfficialCsvSeed(privateDir: string, raw: unknown,
  signal: AbortSignal): Promise<CsvProfileOutput> {
  await verifyPrivateOfficialCsvSeedInstallation(privateDir, signal)
  return executeOfficialCsvProfile(raw)
}
