/** Independent Guangzhou parser for the bounded Mac string-map execution artifact. */
import { createHash } from 'node:crypto'

const FORMAT = 'qianshou.reviewable-execution.v1'
const EXECUTOR = 'qianshou.string-map.v1'
const MAX_BYTES = 256 * 1024
const MAX_IO_BYTES = 64 * 1024
const MAX_OPERATIONS = 16
const MAX_FIELDS = 32
const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const TRANSFORMS = ['copy', 'trim', 'ascii-lower', 'ascii-upper'] as const
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const

export interface ReviewableExecutionOperation {
  readonly operationId: string
  readonly capabilityId: string
  readonly inputSchema: { readonly type: 'object'; readonly properties: Readonly<Record<string, { readonly type: 'string' }>>;
    readonly required: readonly string[]; readonly additionalProperties: false }
  readonly outputSchema: { readonly type: 'object'; readonly properties: Readonly<Record<string, { readonly type: 'string' }>>;
    readonly required: readonly string[]; readonly additionalProperties: false }
  readonly requirements: { readonly platforms: readonly string[]; readonly architectures: readonly string[];
    readonly maxInputBytes: number; readonly maxOutputBytes: number; readonly maxRunMs: number }
  readonly executor: { readonly kind: typeof EXECUTOR; readonly program: { readonly mappings: readonly {
    readonly from: string; readonly to: string; readonly transform: typeof TRANSFORMS[number] }[] } }
  readonly implementationSha256: string
}

export interface ReviewableExecutionManifest {
  readonly format: typeof FORMAT
  readonly pluginId: string
  readonly version: string
  readonly operations: readonly ReviewableExecutionOperation[]
}

export interface VerifiedReviewableExecutionPackage {
  readonly manifest: ReviewableExecutionManifest
  readonly packageSha256: string
  readonly packageBytes: number
  /** Single-file transport tree digest; no ZIP extraction is involved. */
  readonly unpackedTreeSha256: string
  readonly operations: readonly {
    readonly operationId: string
    readonly capabilityId: string
    readonly executorKind: typeof EXECUTOR
    readonly implementationSha256: string
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
    readonly permissions: readonly []
    readonly requirements: ReviewableExecutionOperation['requirements']
  }[]
}

function invalid(): never { throw new Error('PLUGIN_EXECUTION_PACKAGE_INVALID') }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid()
}
function identifier(value: unknown, pattern: RegExp, maximum = 80): value is string {
  return typeof value === 'string' && value.length <= maximum && pattern.test(value)
}
function ordered(value: unknown, vocabulary: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > vocabulary.length
    || value.some(item => typeof item !== 'string' || !vocabulary.includes(item))) invalid()
  const selected = value as string[]
  if (new Set(selected).size !== selected.length
    || JSON.stringify(selected) !== JSON.stringify(vocabulary.filter(item => selected.includes(item)))) invalid()
  return selected
}
function schema(value: unknown): ReviewableExecutionOperation['inputSchema'] {
  const row = record(value)
  exact(row, ['type', 'properties', 'required', 'additionalProperties'])
  if (row['type'] !== 'object' || row['additionalProperties'] !== false) invalid()
  const properties = record(row['properties'])
  const fields = Object.keys(properties).sort()
  if (fields.length < 1 || fields.length > MAX_FIELDS || !Array.isArray(row['required'])
    || row['required'].length !== fields.length
    || JSON.stringify(row['required']) !== JSON.stringify(fields)) invalid()
  const clean: Record<string, { type: 'string' }> = Object.create(null) as Record<string, { type: 'string' }>
  for (const field of fields) {
    if (!FIELD.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) invalid()
    const property = record(properties[field])
    exact(property, ['type'])
    if (property['type'] !== 'string') invalid()
    clean[field] = { type: 'string' }
  }
  return { type: 'object', properties: clean, required: fields, additionalProperties: false }
}
function requirements(value: unknown): ReviewableExecutionOperation['requirements'] {
  const row = record(value)
  exact(row, ['platforms', 'architectures', 'maxInputBytes', 'maxOutputBytes', 'maxRunMs'])
  const platforms = ordered(row['platforms'], PLATFORMS)
  const architectures = ordered(row['architectures'], ARCHITECTURES)
  const maxInputBytes = row['maxInputBytes']
  const maxOutputBytes = row['maxOutputBytes']
  const maxRunMs = row['maxRunMs']
  if (!Number.isSafeInteger(maxInputBytes) || (maxInputBytes as number) < 1
    || (maxInputBytes as number) > MAX_IO_BYTES
    || !Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1
    || (maxOutputBytes as number) > MAX_IO_BYTES
    || !Number.isSafeInteger(maxRunMs) || (maxRunMs as number) < 1_000
    || (maxRunMs as number) > 60_000) invalid()
  return { platforms, architectures, maxInputBytes: maxInputBytes as number,
    maxOutputBytes: maxOutputBytes as number, maxRunMs: maxRunMs as number }
}
function operation(value: unknown): ReviewableExecutionOperation {
  const row = record(value)
  exact(row, ['operationId', 'capabilityId', 'inputSchema', 'outputSchema',
    'requirements', 'executor', 'implementationSha256'])
  if (!identifier(row['operationId'], OPERATION_ID) || !identifier(row['capabilityId'], OPERATION_ID)) invalid()
  const inputSchema = schema(row['inputSchema'])
  const outputSchema = schema(row['outputSchema'])
  const limits = requirements(row['requirements'])
  const rawExecutor = record(row['executor'])
  exact(rawExecutor, ['kind', 'program'])
  if (rawExecutor['kind'] !== EXECUTOR) invalid()
  const program = record(rawExecutor['program'])
  exact(program, ['mappings'])
  if (!Array.isArray(program['mappings']) || program['mappings'].length !== outputSchema.required.length) invalid()
  const mappings: ReviewableExecutionOperation['executor']['program']['mappings'][number][] = []
  for (const rawMapping of program['mappings']) {
    const mapping = record(rawMapping)
    exact(mapping, ['from', 'to', 'transform'])
    if (!identifier(mapping['from'], FIELD, 64) || !identifier(mapping['to'], FIELD, 64)
      || !Object.hasOwn(inputSchema.properties, mapping['from'])
      || !Object.hasOwn(outputSchema.properties, mapping['to'])
      || !TRANSFORMS.includes(mapping['transform'] as typeof TRANSFORMS[number])) invalid()
    mappings.push({ from: mapping['from'], to: mapping['to'],
      transform: mapping['transform'] as typeof TRANSFORMS[number] })
  }
  mappings.sort((a, b) => a.to < b.to ? -1 : a.to > b.to ? 1 : 0)
  if (mappings.some((mapping, index) => mapping.to !== outputSchema.required[index])) invalid()
  const executor = { kind: EXECUTOR, program: { mappings } }
  const implementationSha256 = sha(Buffer.from(JSON.stringify(executor), 'utf8'))
  if (row['implementationSha256'] !== implementationSha256) invalid()
  return { operationId: row['operationId'], capabilityId: row['capabilityId'],
    inputSchema, outputSchema, requirements: limits, executor, implementationSha256 }
}

/** Reparse every untrusted program byte without importing or trusting the Mac builder.
 * @param bytes - Complete canonical JSON artifact.
 * @returns Verified package, implementation and Schema identities for independent signing.
 */
export function verifyReviewableExecutionPackage(bytes: Buffer): VerifiedReviewableExecutionPackage {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES) invalid()
  let decoded: string
  let parsed: Record<string, unknown>
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = record(JSON.parse(decoded) as unknown)
  } catch { return invalid() }
  exact(parsed, ['format', 'pluginId', 'version', 'operations'])
  if (parsed['format'] !== FORMAT || !identifier(parsed['pluginId'], PLUGIN_ID)
    || !identifier(parsed['version'], VERSION, 40)
    || !Array.isArray(parsed['operations']) || parsed['operations'].length < 1
    || parsed['operations'].length > MAX_OPERATIONS) invalid()
  const operations = parsed['operations'].map(operation)
  if (new Set(operations.map(item => item.operationId)).size !== operations.length
    || new Set(operations.map(item => `${item.capabilityId}\n${item.operationId}`)).size !== operations.length) invalid()
  const manifest: ReviewableExecutionManifest = { format: FORMAT, pluginId: parsed['pluginId'],
    version: parsed['version'], operations }
  if (JSON.stringify(manifest) !== decoded || Buffer.byteLength(decoded, 'utf8') !== bytes.length) invalid()
  const packageSha256 = sha(bytes)
  return { manifest, packageSha256, packageBytes: bytes.length,
    unpackedTreeSha256: sha(Buffer.from(JSON.stringify([['artifact.json', packageSha256]]))),
    operations: operations.map(item => ({ operationId: item.operationId, capabilityId: item.capabilityId,
      executorKind: EXECUTOR, implementationSha256: item.implementationSha256,
      inputSchemaSha256: sha(Buffer.from(JSON.stringify(item.inputSchema))),
      outputSchemaSha256: sha(Buffer.from(JSON.stringify(item.outputSchema))),
      permissions: [] as const, requirements: item.requirements })) }
}
