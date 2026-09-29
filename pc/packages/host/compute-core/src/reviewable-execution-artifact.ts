/** Bounded, self-contained declarative execution content for a future independent review. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from './plugin-draft.ts'

const FORMAT = 'qianshou.reviewable-execution.v1'
const EXECUTOR = 'qianshou.string-map.v1'
const BINDING = `tool:${EXECUTOR}`
const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_IO_BYTES = 64 * 1024
const MAX_OPERATIONS = 16
const MAX_FIELDS = 32
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const TRANSFORMS = ['copy', 'trim', 'ascii-lower', 'ascii-upper'] as const
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Structural, flat string fields; free-text descriptions and sample values never enter the artifact. */
export interface ReviewableStringSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, { readonly type: 'string' }>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

/** A complete program instruction with no code, constant, path, network origin or model reference. */
export interface ReviewableStringMapStep {
  readonly from: string
  readonly to: string
  readonly transform: typeof TRANSFORMS[number]
}

/** The executor discriminator is versioned so later independently reviewed types need a new parser. */
export interface ReviewableStringMapExecutor {
  readonly kind: typeof EXECUTOR
  readonly program: { readonly mappings: readonly ReviewableStringMapStep[] }
}

/** Exact limits inherited from the owner's draft, never measured device or order readiness. */
export interface ReviewableExecutionRequirements {
  readonly platforms: readonly typeof PLATFORMS[number][]
  readonly architectures: readonly typeof ARCHITECTURES[number][]
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxRunMs: number
}

/** One independently inspectable operation and its actual declarative implementation. */
export interface ReviewableExecutionOperation {
  readonly operationId: string
  readonly capabilityId: string
  readonly inputSchema: ReviewableStringSchema
  readonly outputSchema: ReviewableStringSchema
  readonly requirements: ReviewableExecutionRequirements
  readonly executor: ReviewableStringMapExecutor
  readonly implementationSha256: string
}

/** Unreviewed archive content; a package SHA is an identity, not a signature or license. */
export interface ReviewableExecutionManifest {
  readonly format: typeof FORMAT
  readonly pluginId: string
  readonly version: string
  readonly operations: readonly ReviewableExecutionOperation[]
}

/** Local build result, with every public and dispatch state denied. */
export interface ReviewableExecutionArtifact {
  readonly bytes: Buffer
  readonly packageSha256: string
  readonly manifest: ReviewableExecutionManifest
  readonly state: 'built-offline-review-candidate'
  readonly reviewed: false
  readonly installable: false
  readonly publishable: false
  readonly dispatchable: false
}

/** Verification proves only these exact bytes and the built-in interpreter's accepted grammar. */
export interface VerifiedReviewableExecutionArtifact {
  readonly packageSha256: string
  readonly manifest: ReviewableExecutionManifest
  readonly verificationScope: 'self-contained-declarative-program'
  readonly reviewed: false
  readonly installable: false
  readonly publishable: false
  readonly dispatchable: false
}

function invalid(): never { throw new ComputeError('COMPUTE_REVIEWABLE_EXECUTION_INVALID', 400) }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid()
  const item = value as Record<string, unknown>
  if (Reflect.ownKeys(item).some(key => typeof key !== 'string'
    || !Object.getOwnPropertyDescriptor(item, key)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key) ?? {}, 'value'))) invalid()
  return item
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid()
}
function isId(value: unknown, pattern: RegExp, max = 80): value is string {
  return typeof value === 'string' && value.length <= max && pattern.test(value)
}
function orderedList(value: unknown, allowed: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length
    || value.some(item => typeof item !== 'string' || !allowed.includes(item))) invalid()
  const selected = value as string[]
  if (new Set(selected).size !== selected.length
    || JSON.stringify(selected) !== JSON.stringify(allowed.filter(item => selected.includes(item)))) invalid()
  return selected
}
function schema(value: unknown): ReviewableStringSchema {
  const row = object(value)
  // The builder may receive draft descriptions. They are checked, then dropped.
  if (Object.keys(row).some(key => !['type', 'properties', 'required', 'additionalProperties', 'description'].includes(key))
    || row['type'] !== 'object' || row['additionalProperties'] !== false) invalid()
  const properties = object(row['properties'])
  const fields = Object.keys(properties).sort()
  const required = row['required']
  if (fields.length < 1 || fields.length > MAX_FIELDS || !Array.isArray(required)
    || required.length !== fields.length
    || new Set(required).size !== fields.length
    || fields.some(name => !FIELD.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)
      || !required.includes(name))) invalid()
  const clean: Record<string, { type: 'string' }> = Object.create(null) as Record<string, { type: 'string' }>
  for (const name of fields) {
    const child = object(properties[name])
    if (Object.keys(child).some(key => !['type', 'description'].includes(key)) || child['type'] !== 'string') invalid()
    clean[name] = { type: 'string' }
  }
  return { type: 'object', properties: clean, required: fields, additionalProperties: false }
}
function requirements(value: unknown): ReviewableExecutionRequirements {
  const row = object(value)
  exact(row, ['platforms', 'architectures', 'maxInputBytes', 'maxOutputBytes', 'maxRunMs'])
  const platforms = orderedList(row['platforms'], PLATFORMS)
  const architectures = orderedList(row['architectures'], ARCHITECTURES)
  const maxInputBytes = row['maxInputBytes']
  const maxOutputBytes = row['maxOutputBytes']
  const maxRunMs = row['maxRunMs']
  if (!Number.isSafeInteger(maxInputBytes) || (maxInputBytes as number) < 1
    || (maxInputBytes as number) > MAX_IO_BYTES
    || !Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1
    || (maxOutputBytes as number) > MAX_IO_BYTES
    || !Number.isSafeInteger(maxRunMs) || (maxRunMs as number) < 1_000
    || (maxRunMs as number) > 60_000) invalid()
  return { platforms: platforms as ReviewableExecutionRequirements['platforms'],
    architectures: architectures as ReviewableExecutionRequirements['architectures'],
    maxInputBytes: maxInputBytes as number, maxOutputBytes: maxOutputBytes as number,
    maxRunMs: maxRunMs as number }
}
function executor(value: unknown, inputSchema: ReviewableStringSchema,
  outputSchema: ReviewableStringSchema): ReviewableStringMapExecutor {
  const row = object(value)
  exact(row, ['kind', 'program'])
  if (row['kind'] !== EXECUTOR) invalid()
  const program = object(row['program'])
  exact(program, ['mappings'])
  if (!Array.isArray(program['mappings']) || program['mappings'].length !== outputSchema.required.length) invalid()
  const mappings: ReviewableStringMapStep[] = []
  for (const raw of program['mappings']) {
    const step = object(raw)
    exact(step, ['from', 'to', 'transform'])
    if (!isId(step['from'], FIELD, 64) || !isId(step['to'], FIELD, 64)
      || !Object.hasOwn(inputSchema.properties, step['from'])
      || !Object.hasOwn(outputSchema.properties, step['to'])
      || !TRANSFORMS.includes(step['transform'] as typeof TRANSFORMS[number])) invalid()
    mappings.push({ from: step['from'], to: step['to'],
      transform: step['transform'] as ReviewableStringMapStep['transform'] })
  }
  mappings.sort((left, right) => left.to < right.to ? -1 : left.to > right.to ? 1 : 0)
  if (mappings.some((step, index) => step.to !== outputSchema.required[index])) invalid()
  return { kind: EXECUTOR, program: { mappings } }
}
function operation(value: unknown): ReviewableExecutionOperation {
  const row = object(value)
  exact(row, ['operationId', 'capabilityId', 'inputSchema', 'outputSchema',
    'requirements', 'executor', 'implementationSha256'])
  if (!isId(row['operationId'], ID) || !isId(row['capabilityId'], ID)) invalid()
  const inputSchema = schema(row['inputSchema'])
  const outputSchema = schema(row['outputSchema'])
  const limits = requirements(row['requirements'])
  const implementation = executor(row['executor'], inputSchema, outputSchema)
  const digest = sha(Buffer.from(JSON.stringify(implementation), 'utf8'))
  if (row['implementationSha256'] !== digest) invalid()
  return { operationId: row['operationId'], capabilityId: row['capabilityId'],
    inputSchema, outputSchema, requirements: limits, executor: implementation,
    implementationSha256: digest }
}
function manifest(value: unknown): ReviewableExecutionManifest {
  const row = object(value)
  exact(row, ['format', 'pluginId', 'version', 'operations'])
  if (row['format'] !== FORMAT || !isId(row['pluginId'], PLUGIN_ID)
    || !isId(row['version'], VERSION, 40)
    || !Array.isArray(row['operations']) || row['operations'].length < 1
    || row['operations'].length > MAX_OPERATIONS) invalid()
  const operations = row['operations'].map(operation)
  if (new Set(operations.map(item => item.operationId)).size !== operations.length
    || new Set(operations.map(item => `${item.capabilityId}\n${item.operationId}`)).size !== operations.length) invalid()
  return { format: FORMAT, pluginId: row['pluginId'], version: row['version'], operations }
}

/** Build one deterministic candidate containing actual programs for every operation.
 * @param input - A saved private draft, capability claims and explicit declarative programs.
 * @returns Portable bytes for later independent review, without any release authority.
 */
export function buildReviewableExecutionArtifact(input: {
  readonly draft: LocalPluginDraft
  readonly capabilityIds: Readonly<Record<string, string>>
  readonly programs: Readonly<Record<string, unknown>>
}): ReviewableExecutionArtifact {
  try {
    const spec = parsePluginDraftSpec(input.draft.spec)
    const claims = object(input.capabilityIds)
    const programs = object(input.programs)
    if (input.draft.state !== 'private-draft' || !/^plugin_draft_[0-9a-f-]{36}$/u.test(input.draft.id)
      || Object.keys(claims).length !== spec.operations.length
      || Object.keys(programs).length !== spec.operations.length) invalid()
    const operations = spec.operations.map(draftOperation => {
      if (!Object.hasOwn(claims, draftOperation.id) || !Object.hasOwn(programs, draftOperation.id)
        || draftOperation.binding.kind !== 'tool' || draftOperation.binding.ref !== BINDING
        || draftOperation.permissions.length !== 0 || draftOperation.dataScope !== 'task-inputs'
        || draftOperation.networkOrigins.length !== 0 || draftOperation.dependencies.length !== 0
        || draftOperation.resources.minTotalMemoryBytes !== 0
        || draftOperation.resources.minFreeDiskBytes !== 0
        || (draftOperation.resources.minVramBytes ?? 0) !== 0
        || draftOperation.resources.platforms === undefined
        || draftOperation.resources.architectures === undefined) invalid()
      const inputSchema = schema(draftOperation.inputSchema)
      const outputSchema = schema(draftOperation.outputSchema)
      const limits = requirements({ platforms: PLATFORMS.filter(item => draftOperation.resources.platforms?.includes(item)),
        architectures: ARCHITECTURES.filter(item => draftOperation.resources.architectures?.includes(item)),
        maxInputBytes: draftOperation.resources.maxInputBytes,
        maxOutputBytes: draftOperation.resources.maxOutputBytes,
        maxRunMs: draftOperation.resources.maxRunMs })
      const implementation = executor({ kind: EXECUTOR, program: programs[draftOperation.id] },
        inputSchema, outputSchema)
      return operation({ operationId: draftOperation.id, capabilityId: claims[draftOperation.id],
        inputSchema, outputSchema, requirements: limits, executor: implementation,
        implementationSha256: sha(Buffer.from(JSON.stringify(implementation), 'utf8')) })
    })
    const content = manifest({ format: FORMAT, pluginId: spec.pluginId, version: spec.version, operations })
    const bytes = Buffer.from(JSON.stringify(content), 'utf8')
    if (bytes.length > MAX_ARTIFACT_BYTES) invalid()
    return { bytes, packageSha256: sha(bytes), manifest: content,
      state: 'built-offline-review-candidate', reviewed: false,
      installable: false, publishable: false, dispatchable: false }
  } catch { return invalid() }
}

/** Reparse untrusted bytes and verify a unique canonical encoding and every implementation digest.
 * @param bytes - Complete candidate bytes from disk or a future review submission.
 * @returns Validated content identity; this does not approve or install the artifact.
 */
export function verifyReviewableExecutionArtifact(bytes: Buffer): VerifiedReviewableExecutionArtifact {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_ARTIFACT_BYTES) invalid()
    const decoded = decoder.decode(bytes)
    const parsed = JSON.parse(decoded) as unknown
    if (Buffer.byteLength(decoded, 'utf8') !== bytes.length || JSON.stringify(parsed) !== decoded) invalid()
    const content = manifest(parsed)
    if (JSON.stringify(content) !== decoded) invalid()
    return { packageSha256: sha(bytes), manifest: content,
      verificationScope: 'self-contained-declarative-program', reviewed: false,
      installable: false, publishable: false, dispatchable: false }
  } catch { return invalid() }
}

/** Execute only the verified pure string-map grammar, without filesystem or network access.
 * @param bytes - Exact candidate bytes, reverified on this invocation.
 * @param operationId - One operation in the package.
 * @param input - A bounded flat string object matching the packaged input schema.
 * @returns A bounded flat string object matching the packaged output schema.
 */
export function evaluateReviewableExecution(bytes: Buffer, operationId: string,
  input: unknown): Readonly<Record<string, string>> {
  const content = verifyReviewableExecutionArtifact(bytes).manifest
  const selected = content.operations.find(item => item.operationId === operationId)
  if (selected === undefined) invalid()
  const values = object(input)
  const names = Object.keys(values).sort()
  if (JSON.stringify(names) !== JSON.stringify(selected.inputSchema.required)
    || names.some(name => typeof values[name] !== 'string')) invalid()
  const inputBytes = Buffer.byteLength(JSON.stringify(values), 'utf8')
  if (inputBytes > selected.requirements.maxInputBytes) invalid()
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const step of selected.executor.program.mappings) {
    const source = values[step.from] as string
    output[step.to] = step.transform === 'copy' ? source
      : step.transform === 'trim' ? source.trim()
        : step.transform === 'ascii-lower' ? source.replace(/[A-Z]/gu, character => character.toLowerCase())
          : source.replace(/[a-z]/gu, character => character.toUpperCase())
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > selected.requirements.maxOutputBytes) invalid()
  return output
}
