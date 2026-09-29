/** Offline, declaration-only bridge to Guangzhou's qianshou.declaration.v1 intake. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parsePluginDraftSpec, type LocalPluginDraft, type PluginDraftSchema } from './plugin-draft.ts'

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024
const MAX_OPERATIONS = 16
const PLATFORM_ORDER = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURE_ORDER = ['arm64', 'x64', 'ia32', 'arm'] as const
const PERMISSION_ORDER = ['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'] as const

interface Entry { readonly name: string; readonly bytes: Buffer }
interface DeclarationOperation {
  readonly capabilityId: string
  readonly operationId: string
  readonly executorKind: 'workflow' | 'tool' | 'model'
  readonly inputSchemaSha256: string
  readonly outputSchemaSha256: string
  readonly permissions: readonly string[]
}

export interface OfflinePluginDeclarationManifest {
  readonly format: 'qianshou.declaration.v1'
  readonly pluginId: string
  readonly version: string
  /** Draft-derived identity only; it is not a review or release receipt. */
  readonly releaseId: string
  readonly platforms: readonly string[]
  readonly architectures: readonly string[]
  readonly operations: readonly DeclarationOperation[]
}

export interface OfflinePluginDeclaration {
  readonly bytes: Buffer
  readonly manifest: OfflinePluginDeclarationManifest
  readonly packageSha256: string
  readonly unpackedTreeSha256: string
  readonly sourceDraftId: string
  readonly sourceDraftUpdatedAt: string
  readonly state: 'built-offline-unsubmitted'
  readonly uploaded: false
  readonly reviewed: false
  readonly publishable: false
  readonly dispatchable: false
}

function invalid(): never { throw new ComputeError('COMPUTE_PLUGIN_DECLARATION_INVALID', 400) }
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length < 2 || bytes.length > MAX_ENTRY_BYTES) invalid()
  return bytes
}

/** Drop human descriptions: schemas are structural contracts, never a carrier for paths or secrets. */
function publicSchema(schema: PluginDraftSchema): Record<string, unknown> {
  if (schema.type === 'object') {
    const properties: Record<string, unknown> = {}
    for (const name of Object.keys(schema.properties ?? {}).sort()) {
      properties[name] = publicSchema(schema.properties![name]!)
    }
    return { type: 'object', properties, required: [...(schema.required ?? [])].sort(), additionalProperties: false }
  }
  if (schema.type === 'array') return { type: 'array', items: publicSchema(schema.items!) }
  return { type: schema.type }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function storedZip(entries: readonly Entry[]): Buffer {
  if (entries.length < 3 || entries.length > 1 + 2 * MAX_OPERATIONS) invalid()
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'ascii')
    if (!/^(?:manifest\.json|schemas\/(?:0|[1-9]|1[0-5])\/(?:input|output)\.json)$/u.test(entry.name)
      || name.length > 80 || entry.bytes.length > MAX_ENTRY_BYTES) invalid()
    const checksum = crc32(entry.bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(entry.bytes.length, 18)
    header.writeUInt32LE(entry.bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, entry.bytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE((3 << 8) | 20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(entry.bytes.length, 20)
    directory.writeUInt32LE(entry.bytes.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + entry.bytes.length
  }
  const directoryBytes = central.reduce((sum, bytes) => sum + bytes.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBytes, 12)
  end.writeUInt32LE(offset, 16)
  const bytes = Buffer.concat([...local, ...central, end])
  if (bytes.length > MAX_ARCHIVE_BYTES) invalid()
  return bytes
}

/**
 * Produce an unsubmitted archive from a private draft. The caller supplies each *claimed*
 * capability ID; this function does not register it, upload, approve, install or execute.
 * Descriptions, samples, binding references, network origins, dependencies, resources,
 * adapter identities, credentials and local asset paths never enter the ZIP.
 */
export function buildOfflinePluginDeclaration(input: {
  readonly draft: LocalPluginDraft
  readonly capabilityIds: Readonly<Record<string, string>>
}): OfflinePluginDeclaration {
  try {
    const spec = parsePluginDraftSpec(input.draft.spec)
    if (typeof input.draft.id !== 'string' || !/^plugin_draft_[0-9a-f-]{36}$/u.test(input.draft.id)
      || typeof input.draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.draft.updatedAt))
      || !ID.test(spec.pluginId) || spec.pluginId.length > 80
      || !VERSION.test(spec.version) || spec.version.length > 40
      || input.capabilityIds === null || typeof input.capabilityIds !== 'object'
      || Array.isArray(input.capabilityIds)
      || Object.keys(input.capabilityIds).length !== spec.operations.length
      || spec.operations.some(operation => !Object.hasOwn(input.capabilityIds, operation.id))) invalid()
    const schemas: Entry[] = []
    const operations: DeclarationOperation[] = []
    const platforms = PLATFORM_ORDER.filter(platform => spec.operations.every(operation => operation.resources.platforms?.includes(platform)))
    const architectures = ARCHITECTURE_ORDER.filter(architecture => spec.operations.every(operation => operation.resources.architectures?.includes(architecture)))
    if (platforms.length === 0 || architectures.length === 0) invalid()
    for (const [index, operation] of spec.operations.entries()) {
      // v1 has no destinations, dependency/version fields or workspace data
      // scope. Do not submit a declaration that would hide these claims.
      if (operation.networkOrigins.length > 0 || operation.dependencies.length > 0
        || operation.dataScope === 'workspace') invalid()
      const capabilityId = input.capabilityIds[operation.id]
      if (!OPERATION_ID.test(operation.id) || typeof capabilityId !== 'string' || !OPERATION_ID.test(capabilityId)) invalid()
      const inputSchema = json(publicSchema(operation.inputSchema))
      const outputSchema = json(publicSchema(operation.outputSchema))
      schemas.push({ name: `schemas/${index}/input.json`, bytes: inputSchema },
        { name: `schemas/${index}/output.json`, bytes: outputSchema })
      operations.push({ capabilityId, operationId: operation.id,
        executorKind: operation.binding.kind === 'local-model' ? 'model' : operation.binding.kind,
        inputSchemaSha256: sha(inputSchema), outputSchemaSha256: sha(outputSchema),
        permissions: PERMISSION_ORDER.filter(permission => operation.permissions.includes(permission)) })
    }
    // Draft identity is content-addressed. The server still treats it only as a pending claim.
    const releaseId = `draft.${sha(json({ pluginId: spec.pluginId, version: spec.version,
      platforms, architectures, operations, schemas: schemas.map(entry => [entry.name, sha(entry.bytes)]) }))}`
    const manifest: OfflinePluginDeclarationManifest = { format: 'qianshou.declaration.v1',
      pluginId: spec.pluginId, version: spec.version, releaseId, platforms, architectures, operations }
    const entries: Entry[] = [{ name: 'manifest.json', bytes: json(manifest) }, ...schemas]
    const bytes = storedZip(entries)
    const unpackedTreeSha256 = sha(Buffer.from(JSON.stringify(entries.map(entry => [entry.name, sha(entry.bytes)]))))
    return { bytes, manifest, packageSha256: sha(bytes), unpackedTreeSha256,
      sourceDraftId: input.draft.id, sourceDraftUpdatedAt: input.draft.updatedAt,
      state: 'built-offline-unsubmitted', uploaded: false, reviewed: false,
      publishable: false, dispatchable: false }
  } catch { return invalid() }
}
