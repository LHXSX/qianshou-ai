/** Deterministic, data-only local archive of untrusted declarations; it carries no executable or install authority. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { HostPluginAdapterRegistry, type PrivatePluginCandidate } from './plugin-adapter-admission.ts'
import { parsePluginDraftSpec, type LocalPluginDraft, type PluginDraftSchema, type PluginDraftSpec } from './plugin-draft.ts'
import { pluginDraftPlanManifest } from './plugin-draft-preview.ts'

const MAX_PACKAGE_BYTES = 4 * 1024 * 1024
const MAX_ENTRY_BYTES = 256 * 1024
const MAX_SAMPLE_BYTES = 64 * 1024
const MAX_OPERATIONS = 16
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 16_384
const SHA256 = /^[a-f0-9]{64}$/u
const FORMAT = 'qianshou.offline-plugin-artifact.v1'
const decoder = new TextDecoder('utf-8', { fatal: true })

interface Entry { readonly path: string; readonly bytes: Buffer }
interface EntryDigest { readonly path: string; readonly bytes: number; readonly sha256: string }
interface ArtifactManifest {
  readonly format: typeof FORMAT
  readonly candidate: PrivatePluginCandidate
  readonly spec: PluginDraftSpec
  readonly entries: readonly EntryDigest[]
  readonly executionVerified: false
  readonly installable: false
  readonly dispatchable: false
}

export interface OfflinePluginSample {
  readonly operationId: string
  /** Caller-supplied JSON may contain paths or secrets. Review separately before any upload. */
  readonly input: unknown
  /** Caller-supplied output; this module cannot prove approval or actual adapter execution. */
  readonly output: unknown
}

export interface OfflinePluginArtifact {
  readonly bytes: Buffer
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly state: 'built-offline-uninstalled'
  readonly packageProduced: true
  readonly executionVerified: false
  readonly installable: false
  readonly dispatchable: false
}

export interface VerifiedOfflinePluginArtifact {
  readonly format: typeof FORMAT
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly pluginId: string
  readonly version: string
  readonly operationIds: readonly string[]
  readonly verificationScope: 'data-only-archive-and-claimed-digests'
  readonly state: 'verified-offline-uninstalled'
  readonly executionVerified: false
  readonly installable: false
  readonly dispatchable: false
}

/** Host-only declarations from an already verified private archive. No executable bytes are present. */
export interface VerifiedOfflinePluginActivationMaterial {
  readonly verified: VerifiedOfflinePluginArtifact
  readonly candidate: PrivatePluginCandidate
  readonly spec: PluginDraftSpec
}

function invalid(): never { throw new ComputeError('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID', 400) }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function order(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function canonical(value: unknown): string {
  const fragments: string[] = []
  const active = new WeakSet<object>()
  let bytes = 0
  let nodes = 0
  const append = (fragment: string): void => {
    bytes += Buffer.byteLength(fragment, 'utf8')
    if (bytes > MAX_ENTRY_BYTES) invalid()
    fragments.push(fragment)
  }
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) invalid()
    if (Array.isArray(item)) {
      if (active.has(item)) invalid()
      active.add(item)
      const length = Object.getOwnPropertyDescriptor(item, 'length')?.value as unknown
      if (!Number.isSafeInteger(length) || (length as number) > MAX_JSON_NODES) invalid()
      const keys = Reflect.ownKeys(item)
      if (keys.length !== (length as number) + 1) invalid()
      append('[')
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        if (index > 0) append(',')
        visit(descriptor.value, depth + 1)
      }
      append(']')
      active.delete(item)
      return
    }
    if (item !== null && typeof item === 'object') {
      if (Object.getPrototypeOf(item) !== Object.prototype || active.has(item)) invalid()
      active.add(item)
      const keys = Reflect.ownKeys(item)
      if (keys.length > MAX_JSON_NODES || keys.some(key => typeof key !== 'string')) invalid()
      keys.sort((left, right) => order(left as string, right as string))
      append('{')
      for (const [index, key] of keys.entries()) {
        const name = key as string
        const descriptor = Object.getOwnPropertyDescriptor(item, name)
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || Buffer.byteLength(name, 'utf8') > MAX_ENTRY_BYTES) invalid()
        if (index > 0) append(',')
        append(JSON.stringify(name))
        append(':')
        visit(descriptor.value, depth + 1)
      }
      append('}')
      active.delete(item)
      return
    }
    if (typeof item === 'number' && !Number.isFinite(item)) invalid()
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > MAX_ENTRY_BYTES) invalid()
    const encoded = JSON.stringify(item)
    if (encoded === undefined) invalid()
    append(encoded)
  }
  try { visit(value, 0) }
  catch { invalid() }
  return fragments.join('')
}
function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(canonical(value), 'utf8')
  if (bytes.length < 2 || bytes.length > MAX_ENTRY_BYTES) invalid()
  return bytes
}
/** Digest of caller-supplied canonical JSON; no execution is attested. */
export function offlinePluginSampleSha256(value: unknown): string { return sha(jsonBytes(value)) }
function parsedJson(bytes: Buffer): unknown {
  if (bytes.length < 2 || bytes.length > MAX_ENTRY_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) as unknown }
  catch { return invalid() }
  if (!jsonBytes(value).equals(bytes)) invalid()
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function path(index: number, name: string): string { return `operations/${String(index).padStart(2, '0')}/${name}.json` }
function entryPaths(index: number): readonly string[] {
  return [path(index, 'input-schema'), path(index, 'output-schema'),
    path(index, 'sample-input'), path(index, 'sample-output')]
}
/** Exact bounded draft-schema check shared by pre-execution and archive validation. */
export function matchesPluginDraftSchema(value: unknown, schema: PluginDraftSchema): boolean {
  if (schema.type === 'null') return value === null
  if (schema.type === 'array') return Array.isArray(value)
    && value.every(item => matchesPluginDraftSchema(item, schema.items!))
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    const properties = schema.properties ?? {}
    return (schema.required ?? []).every(name => Object.hasOwn(item, name))
      && Object.entries(item).every(([name, child]) => {
        const field = properties[name]
        return field !== undefined && matchesPluginDraftSchema(child, field)
      })
  }
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === schema.type
}

/** Archive declarations and caller JSON offline; sample text is not scanned for sensitive content. */
export function buildOfflinePluginArtifact(input: {
  readonly registry: HostPluginAdapterRegistry
  readonly draft: LocalPluginDraft
  readonly candidate: PrivatePluginCandidate
  readonly samples: readonly OfflinePluginSample[]
}): OfflinePluginArtifact {
  const candidate = input.registry.recheckPrivateCandidate(input.draft, input.candidate)
  const spec = parsePluginDraftSpec(input.draft.spec)
  try {
    if (!Array.isArray(input.samples) || input.samples.length !== spec.operations.length
      || new Set(input.samples.map(sample => sample.operationId)).size !== input.samples.length) invalid()
  } catch { invalid() }
  const data: Entry[] = []
  let dataBytes = 0
  for (const [index, operation] of spec.operations.entries()) {
    try {
      const sample = input.samples.find(item => item.operationId === operation.id)
      const admitted = candidate.operations[index]
      if (sample === undefined || admitted?.operationId !== operation.id) invalid()
      const names = entryPaths(index)
      const bytes = [jsonBytes(operation.inputSchema), jsonBytes(operation.outputSchema),
        jsonBytes(sample.input), jsonBytes(sample.output)]
      if (bytes[2]!.length > MAX_SAMPLE_BYTES || bytes[3]!.length > MAX_SAMPLE_BYTES
        || !matchesPluginDraftSchema(sample.input, operation.inputSchema)
        || !matchesPluginDraftSchema(sample.output, operation.outputSchema)) invalid()
      if (sha(bytes[2]!) !== admitted.sampleDigestClaim.inputSha256
        || sha(bytes[3]!) !== admitted.sampleDigestClaim.outputSha256) invalid()
      dataBytes += bytes.reduce((sum, item) => sum + item.length, 0)
      if (dataBytes > MAX_PACKAGE_BYTES - MAX_ENTRY_BYTES - 16 * 1024) invalid()
      data.push(...names.map((name, at) => ({ path: name, bytes: bytes[at]! })))
    } catch { invalid() }
  }
  const manifest: ArtifactManifest = { format: FORMAT, candidate, spec,
    entries: data.map(({ path: name, bytes }) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) })),
    executionVerified: false, installable: false, dispatchable: false }
  const bytes = writeStoredZip([{ path: 'manifest.json', bytes: jsonBytes(manifest) }, ...data])
  return { bytes, packageSha256: sha(bytes), candidateSha256: candidate.candidateSha256,
    state: 'built-offline-uninstalled', packageProduced: true, executionVerified: false,
    installable: false, dispatchable: false }
}

/** Verify pinned archive bytes and claimed digests. This never verifies or executes an adapter. */
export function verifyOfflinePluginArtifact(archive: Buffer, expected: {
  readonly packageSha256: string; readonly candidateSha256: string
}): VerifiedOfflinePluginArtifact {
  if (expected === null || typeof expected !== 'object') invalid()
  let expectedPackageSha256: unknown
  let expectedCandidateSha256: unknown
  try {
    expectedPackageSha256 = expected.packageSha256
    expectedCandidateSha256 = expected.candidateSha256
  } catch { invalid() }
  if (!Buffer.isBuffer(archive) || typeof expectedPackageSha256 !== 'string'
    || typeof expectedCandidateSha256 !== 'string' || !SHA256.test(expectedPackageSha256)
    || !SHA256.test(expectedCandidateSha256) || sha(archive) !== expectedPackageSha256) invalid()
  const files = readStoredZip(archive)
  const manifest = record(parsedJson(files.get('manifest.json') ?? invalid()))
  exact(manifest, ['format', 'candidate', 'spec', 'entries', 'executionVerified', 'installable', 'dispatchable'])
  if (manifest.format !== FORMAT || manifest.executionVerified !== false
    || manifest.installable !== false || manifest.dispatchable !== false) invalid()
  const candidate = record(manifest.candidate)
  exact(candidate, ['format', 'draftId', 'draftUpdatedAt', 'draftSha256', 'pluginId', 'version',
    'operations', 'candidateSha256', 'state', 'packageProduced', 'executionVerified', 'installable', 'dispatchable'])
  if (candidate.format !== 'qianshou.private-plugin-candidate.v1'
    || candidate.state !== 'private-candidate' || candidate.packageProduced !== false
    || candidate.executionVerified !== false || candidate.installable !== false || candidate.dispatchable !== false
    || candidate.candidateSha256 !== expectedCandidateSha256
    || typeof candidate.pluginId !== 'string' || typeof candidate.version !== 'string'
    || typeof candidate.draftId !== 'string'
    || !/^plugin_draft_[0-9a-f-]{36}$/u.test(candidate.draftId)
    || typeof candidate.draftUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.draftUpdatedAt))
    || !Array.isArray(candidate.operations)) invalid()
  const spec = parsePluginDraftSpec(manifest.spec)
  if (candidate.pluginId !== spec.pluginId || candidate.version !== spec.version
    || candidate.operations.length !== spec.operations.length) invalid()
  const draft = { id: candidate.draftId, updatedAt: candidate.draftUpdatedAt,
    createdAt: candidate.draftUpdatedAt, spec, state: 'private-draft', installable: false,
    dispatchable: false, readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' } } as LocalPluginDraft
  const plan = pluginDraftPlanManifest(draft)
  if (!SHA256.test(String(candidate.draftSha256))
    || sha(Buffer.from(canonical({ id: candidate.draftId, updatedAt: candidate.draftUpdatedAt, spec }))) !== candidate.draftSha256) invalid()
  const candidateBase = { format: candidate.format, draftId: candidate.draftId,
    draftUpdatedAt: candidate.draftUpdatedAt, draftSha256: candidate.draftSha256,
    pluginId: candidate.pluginId, version: candidate.version, operations: candidate.operations }
  if (sha(Buffer.from(canonical(candidateBase))) !== candidate.candidateSha256) invalid()
  const entries = manifest.entries
  if (!Array.isArray(entries) || entries.length !== spec.operations.length * 4
    || files.size !== entries.length + 1 || spec.operations.length > MAX_OPERATIONS) invalid()
  for (const [index, operation] of spec.operations.entries()) {
    const evidence = record(candidate.operations[index])
    const sample = record(evidence.sampleDigestClaim)
    exact(evidence, ['operationId', 'adapterId', 'adapterVersion', 'bindingKind', 'bindingRef',
      'inputSchemaSha256', 'outputSchemaSha256', 'permissions', 'dataScope', 'platforms',
      'architectures', 'assets', 'sampleDigestClaim'])
    exact(sample, ['id', 'operationId', 'adapterId', 'adapterVersion', 'claimedAtMs',
      'expiresAtMs', 'inputSha256', 'outputSha256', 'assets'])
    const planned = plan.operations.find(item => item.id === operation.id)
    if (planned === undefined) invalid()
    if (evidence.operationId !== operation.id || evidence.bindingKind !== operation.binding.kind
      || evidence.bindingRef !== operation.binding.ref || evidence.dataScope !== operation.dataScope
      || canonical(evidence.permissions) !== canonical(operation.permissions)
      || canonical(evidence.platforms) !== canonical(operation.resources.platforms ?? [])
      || canonical(evidence.architectures) !== canonical(operation.resources.architectures ?? [])
      || evidence.inputSchemaSha256 !== planned.inputSchemaSha256
      || evidence.outputSchemaSha256 !== planned.outputSchemaSha256
      || typeof evidence.adapterId !== 'string' || typeof evidence.adapterVersion !== 'string'
      || sample.operationId !== operation.id || sample.adapterId !== evidence.adapterId
      || sample.adapterVersion !== evidence.adapterVersion
      || typeof sample.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(sample.id)
      || !Number.isSafeInteger(sample.claimedAtMs) || !Number.isSafeInteger(sample.expiresAtMs)
      || (sample.expiresAtMs as number) <= (sample.claimedAtMs as number)
      || typeof sample.inputSha256 !== 'string' || !SHA256.test(sample.inputSha256)
      || typeof sample.outputSha256 !== 'string' || !SHA256.test(sample.outputSha256)
      || canonical(sample.assets) !== canonical(evidence.assets)) invalid()
    if (!Array.isArray(evidence.assets) || evidence.assets.length > 64
      || new Set(evidence.assets.map(item => record(item).id)).size !== evidence.assets.length
      || evidence.assets.some((item) => {
        const asset = record(item)
        return typeof asset.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(asset.id)
          || !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 0
          || typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)
      })) invalid()
    for (const [part, name] of entryPaths(index).entries()) {
      const item = record(entries[index * 4 + part])
      const bytes = files.get(name)
      if (item.path !== name || bytes === undefined || item.bytes !== bytes.length
        || item.sha256 !== sha(bytes)) invalid()
      const parsed = parsedJson(bytes)
      if (part === 0 && canonical(parsed) !== canonical(operation.inputSchema)) invalid()
      if (part === 1 && canonical(parsed) !== canonical(operation.outputSchema)) invalid()
      if (part === 2 && sha(bytes) !== sample.inputSha256) invalid()
      if (part === 3 && sha(bytes) !== sample.outputSha256) invalid()
      if (part >= 2 && bytes.length > MAX_SAMPLE_BYTES) invalid()
      if (part === 2 && !matchesPluginDraftSchema(parsed, operation.inputSchema)) invalid()
      if (part === 3 && !matchesPluginDraftSchema(parsed, operation.outputSchema)) invalid()
    }
  }
  return Object.freeze({ format: FORMAT, packageSha256: expectedPackageSha256,
    candidateSha256: expectedCandidateSha256, pluginId: spec.pluginId, version: spec.version,
    operationIds: Object.freeze(spec.operations.map(operation => operation.id)),
    verificationScope: 'data-only-archive-and-claimed-digests', state: 'verified-offline-uninstalled',
    executionVerified: false, installable: false, dispatchable: false })
}

/** Return archive declarations only after checking the complete pinned ZIP and every entry digest. */
export function readVerifiedOfflinePluginActivationMaterial(archive: Buffer, expected: {
  readonly packageSha256: string; readonly candidateSha256: string
}): VerifiedOfflinePluginActivationMaterial {
  const verified = verifyOfflinePluginArtifact(archive, expected)
  const manifest = record(parsedJson(readStoredZip(archive).get('manifest.json') ?? invalid()))
  return { verified, candidate: manifest.candidate as PrivatePluginCandidate,
    spec: parsePluginDraftSpec(manifest.spec) }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0
  return (value ^ 0xffffffff) >>> 0
}
function pathBytes(value: string): Buffer {
  if (!/^[a-z0-9][a-z0-9./-]{0,79}$/u.test(value) || value.includes('..') || value.startsWith('/')) invalid()
  return Buffer.from(value, 'ascii')
}
function writeStoredZip(entries: readonly Entry[]): Buffer {
  if (entries.length < 2 || entries.length > 1 + MAX_OPERATIONS * 4) invalid()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = pathBytes(entry.path)
    if (entry.bytes.length < 2 || entry.bytes.length > MAX_ENTRY_BYTES) invalid()
    const crc = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, entry.bytes)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + entry.bytes.length
    if (offset > MAX_PACKAGE_BYTES) invalid()
  }
  const centralBytes = centrals.reduce((sum, bytes) => sum + bytes.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes, 12)
  end.writeUInt32LE(offset, 16)
  const bytes = Buffer.concat([...locals, ...centrals, end])
  if (bytes.length > MAX_PACKAGE_BYTES) invalid()
  return bytes
}
function readStoredZip(archive: Buffer): ReadonlyMap<string, Buffer> {
  if (archive.length < 22 || archive.length > MAX_PACKAGE_BYTES) invalid()
  const end = archive.length - 22
  if (archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 4) !== 0
    || archive.readUInt16LE(end + 6) !== 0 || archive.readUInt16LE(end + 20) !== 0) invalid()
  const count = archive.readUInt16LE(end + 10)
  const centralOffset = archive.readUInt32LE(end + 16)
  const centralBytes = archive.readUInt32LE(end + 12)
  if (count < 2 || count > 1 + MAX_OPERATIONS * 4 || archive.readUInt16LE(end + 8) !== count
    || centralOffset + centralBytes !== end) invalid()
  const files = new Map<string, Buffer>()
  let cursor = centralOffset
  let localCursor = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50
      || archive.readUInt16LE(cursor + 4) !== ((3 << 8) | 20)
      || archive.readUInt16LE(cursor + 8) !== 0 || archive.readUInt16LE(cursor + 10) !== 0
      || archive.readUInt16LE(cursor + 30) !== 0 || archive.readUInt16LE(cursor + 32) !== 0
      || archive.readUInt16LE(cursor + 34) !== 0
      || archive.readUInt32LE(cursor + 38) !== ((0o100600 << 16) >>> 0)) invalid()
    const crc = archive.readUInt32LE(cursor + 16)
    const compressed = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const localOffset = archive.readUInt32LE(cursor + 42)
    if (compressed !== size || size < 2 || size > MAX_ENTRY_BYTES || nameLength < 1 || nameLength > 80
      || cursor + 46 + nameLength > end || localOffset !== localCursor) invalid()
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBytes.toString('ascii')
    if (!pathBytes(name).equals(nameBytes) || files.has(name) || localOffset + 30 + nameLength + size > centralOffset
      || archive.readUInt32LE(localOffset) !== 0x04034b50
      || archive.readUInt16LE(localOffset + 6) !== 0 || archive.readUInt16LE(localOffset + 8) !== 0
      || archive.readUInt32LE(localOffset + 14) !== crc
      || archive.readUInt32LE(localOffset + 18) !== size
      || archive.readUInt32LE(localOffset + 22) !== size
      || archive.readUInt16LE(localOffset + 26) !== nameLength
      || archive.readUInt16LE(localOffset + 28) !== 0
      || !archive.subarray(localOffset + 30, localOffset + 30 + nameLength).equals(nameBytes)) invalid()
    const data = archive.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + size)
    if (crc32(data) !== crc) invalid()
    files.set(name, data)
    cursor += 46 + nameLength
    localCursor = localOffset + 30 + nameLength + size
  }
  if (cursor !== end || localCursor !== centralOffset || !files.has('manifest.json')) invalid()
  // Only the writer's unique encoding is accepted, including otherwise ignored ZIP header fields.
  if (!writeStoredZip([...files].map(([name, bytes]) => ({ path: name, bytes }))).equals(archive)) invalid()
  return files
}
