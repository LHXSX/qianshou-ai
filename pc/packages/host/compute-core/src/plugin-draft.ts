/** Private, non-executable recipes for turning local models, workflows and tools into future plugins. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, statfs } from 'node:fs/promises'
import { arch, platform, totalmem } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import type { ComputePluginDataScope, ComputePluginPermission } from './capability-manifest.ts'
import { previewPluginDraft, type PluginDraftPackagePreview } from './plugin-draft-preview.ts'
import { parseStoredPrivateComfyDraftAsset, preparePrivateComfyDraftAsset, privateComfyDraftAssetSummary,
  type ComfyDraftAssetSummary, type PrivateComfyDraftAsset } from './comfy-draft-asset.ts'

const MAX_DRAFT_BYTES = 64 * 1024
const MAX_SCHEMA_BYTES = 8 * 1024
const DRAFT_ID = /^plugin_draft_[0-9a-f-]{36}$/u
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const BINDING_REF = /^[a-z][a-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const PERMISSIONS = new Set<ComputePluginPermission>(['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'])
const DATA_SCOPES = new Set<ComputePluginDataScope>(['none', 'workspace', 'task-inputs'])
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

/** Bounded JSON Schema subset; external references and executable keywords are not accepted. */
export interface PluginDraftSchema {
  readonly type: (typeof SCHEMA_TYPES)[number]
  readonly description?: string
  readonly properties?: Readonly<Record<string, PluginDraftSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: false
  readonly items?: PluginDraftSchema
}

/** One local runtime identity, never an absolute path, URL, credential or executable command. */
export interface PluginDraftBinding { readonly kind: 'local-model' | 'workflow' | 'tool'; readonly ref: string }

/** Resource claims are proposed requirements; the draft does not report observed hardware. */
export interface PluginDraftResources {
  readonly platforms?: readonly (typeof PLATFORMS)[number][]
  readonly architectures?: readonly (typeof ARCHITECTURES)[number][]
  readonly minTotalMemoryBytes: number
  readonly minFreeDiskBytes: number
  readonly minVramBytes?: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxRunMs: number
}

/** A freely named operation inside one future plugin, with explicit I/O and permission claims. */
export interface PluginDraftOperation {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly binding: PluginDraftBinding
  readonly inputSchema: PluginDraftSchema
  readonly outputSchema: PluginDraftSchema
  readonly permissions: readonly ComputePluginPermission[]
  readonly dataScope: ComputePluginDataScope
  readonly networkOrigins: readonly string[]
  readonly dependencies: readonly { readonly id: string; readonly version: string }[]
  readonly resources: PluginDraftResources
}

/** Private owner design input. A capability ID here is not a Shanghai registry registration. */
export interface PluginDraftSpec {
  readonly pluginId: string
  readonly version: string
  readonly displayName: string
  readonly operations: readonly PluginDraftOperation[]
}

/** Saved receipt cannot be installed, advertised, sold or used as execution authority. */
export interface LocalPluginDraft {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly state: 'private-draft'
  readonly installable: false
  readonly dispatchable: false
  readonly readiness: {
    readonly adapter: 'pending'
    readonly probe: 'pending'
    readonly signing: 'pending'
    readonly review: 'pending'
  }
  readonly spec: PluginDraftSpec
}

/** Create or replace a local recipe. Omit `id` to create one. */
export interface PluginDraftSaveRequest { readonly id?: string; readonly spec: PluginDraftSpec }

/** Download-ready JSON text; it is a private design recipe, not an installable package. */
export interface PluginDraftExport { readonly fileName: string; readonly contentType: 'application/json'; readonly contents: string }

/** Storage capacity and path owned by the Host profile. */
export interface PluginDraftStoreConfig { readonly path: string; readonly maxDrafts: number; readonly maxBytes: number }

/** Owner-only binding bytes share the atomic private store, but never enter public draft receipts. */
interface StoredPluginDraft extends LocalPluginDraft { readonly comfyAssets?: readonly PrivateComfyDraftAsset[] }

function invalid(): ComputeError { return new ComputeError('COMPUTE_PLUGIN_DRAFT_INVALID', 400) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !CONTROL.test(value) ? value : null
}
function bytes(value: unknown, maximum: number, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}
function enumList<T extends string>(value: unknown, allowed: readonly T[]): readonly T[] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length
    || value.some(item => typeof item !== 'string' || !allowed.includes(item as T)) || new Set(value).size !== value.length) return null
  return value as T[]
}

function parseSchema(value: unknown, depth = 0, count = { nodes: 0 }): PluginDraftSchema {
  const item = record(value)
  count.nodes += 1
  if (item === null || depth > 6 || count.nodes > 128
    || !only(item, ['type', 'description', 'properties', 'required', 'additionalProperties', 'items'])
    || !SCHEMA_TYPES.includes(item.type as (typeof SCHEMA_TYPES)[number])) throw invalid()
  const description = item.description === undefined ? undefined : text(item.description, 256)
  if (description === null) throw invalid()
  const type = item.type as PluginDraftSchema['type']
  if (type === 'object') {
    const raw = record(item.properties)
    if (raw === null || Object.keys(raw).length > 32 || item.additionalProperties !== false || item.items !== undefined
      || !Array.isArray(item.required) || item.required.length > Object.keys(raw).length) throw invalid()
    const properties: Record<string, PluginDraftSchema> = {}
    for (const [name, schema] of Object.entries(raw)) {
      if (!FIELD_NAME.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') throw invalid()
      properties[name] = parseSchema(schema, depth + 1, count)
    }
    const required = item.required as unknown[]
    if (new Set(required).size !== required.length || required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name))) throw invalid()
    return { type, ...(description === undefined ? {} : { description }), properties,
      required: required as string[], additionalProperties: false }
  }
  if (type === 'array') {
    if (item.properties !== undefined || item.required !== undefined
      || item.additionalProperties !== undefined || item.items === undefined) throw invalid()
    return { type, ...(description === undefined ? {} : { description }), items: parseSchema(item.items, depth + 1, count) }
  }
  if (item.properties !== undefined || item.required !== undefined
    || item.additionalProperties !== undefined || item.items !== undefined) throw invalid()
  return { type, ...(description === undefined ? {} : { description }) }
}

function parseResources(value: unknown): PluginDraftResources {
  const item = record(value)
  if (item === null || !only(item, ['platforms', 'architectures', 'minTotalMemoryBytes', 'minFreeDiskBytes', 'minVramBytes', 'maxInputBytes', 'maxOutputBytes', 'maxRunMs'])) throw invalid()
  const platforms = enumList(item.platforms, PLATFORMS)
  const architectures = enumList(item.architectures, ARCHITECTURES)
  const minTotalMemoryBytes = bytes(item.minTotalMemoryBytes, 1024 ** 5)
  const minFreeDiskBytes = bytes(item.minFreeDiskBytes, 1024 ** 5)
  const minVramBytes = item.minVramBytes === undefined ? undefined : bytes(item.minVramBytes, 1024 ** 5)
  const maxInputBytes = bytes(item.maxInputBytes, 1024 ** 3, 1)
  const maxOutputBytes = bytes(item.maxOutputBytes, 1024 ** 3, 1)
  const maxRunMs = bytes(item.maxRunMs, 3_600_000, 1_000)
  if (platforms === null || architectures === null || minTotalMemoryBytes === null || minFreeDiskBytes === null
    || minVramBytes === null || maxInputBytes === null || maxOutputBytes === null || maxRunMs === null) throw invalid()
  return { ...(platforms === undefined ? {} : { platforms }), ...(architectures === undefined ? {} : { architectures }),
    minTotalMemoryBytes, minFreeDiskBytes, ...(minVramBytes === undefined ? {} : { minVramBytes }),
    maxInputBytes, maxOutputBytes, maxRunMs }
}

function parseOperation(value: unknown): PluginDraftOperation {
  const item = record(value)
  if (item === null || !only(item, ['id', 'title', 'description', 'binding', 'inputSchema', 'outputSchema', 'permissions', 'dataScope', 'networkOrigins', 'dependencies', 'resources'])) throw invalid()
  const id = text(item.id, 128)
  const title = text(item.title, 80)
  const description = text(item.description, 400)
  const binding = record(item.binding)
  const kind = binding?.kind
  const ref = text(binding?.ref, 160)
  if (id === null || !LOGICAL_ID.test(id) || title === null || description === null || binding === null
    || !only(binding, ['kind', 'ref']) || (kind !== 'local-model' && kind !== 'workflow' && kind !== 'tool')
    || ref === null || !BINDING_REF.test(ref) || ref.includes('://') || ref.includes('..') || ref.startsWith('file:')) throw invalid()
  if (!Array.isArray(item.permissions) || item.permissions.length > PERMISSIONS.size
    || item.permissions.some(permission => !PERMISSIONS.has(permission as ComputePluginPermission))
    || new Set(item.permissions).size !== item.permissions.length
    || !DATA_SCOPES.has(item.dataScope as ComputePluginDataScope)) throw invalid()
  const permissions = item.permissions as ComputePluginPermission[]
  if (kind === 'local-model' && !permissions.includes('model.local')) throw invalid()
  if (item.dataScope === 'workspace' && !permissions.includes('workspace.read') && !permissions.includes('workspace.write')) throw invalid()
  if (!Array.isArray(item.networkOrigins) || item.networkOrigins.length > 8
    || new Set(item.networkOrigins).size !== item.networkOrigins.length) throw invalid()
  const networkOrigins: string[] = []
  for (const raw of item.networkOrigins) {
    if (typeof raw !== 'string' || raw.length > 200) throw invalid()
    let url: URL
    try { url = new URL(raw) } catch { throw invalid() }
    const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if (!(url.protocol === 'https:' || loopback) || url.href !== `${url.origin}/` || url.username || url.password) throw invalid()
    networkOrigins.push(url.origin)
  }
  if (permissions.includes('network.declared') !== (networkOrigins.length > 0)) throw invalid()
  if (!Array.isArray(item.dependencies) || item.dependencies.length > 16) throw invalid()
  const dependencies: Array<{ id: string; version: string }> = []
  for (const raw of item.dependencies) {
    const dependency = record(raw)
    const dependencyId = text(dependency?.id, 128)
    const version = text(dependency?.version, 64)
    if (dependency === null || !only(dependency, ['id', 'version']) || dependencyId === null || !LOGICAL_ID.test(dependencyId)
      || version === null || !/^(?:\*|\^?\d+\.\d+\.\d+|>=\d+\.\d+\.\d+)$/u.test(version)
      || dependencies.some(item => item.id === dependencyId)) throw invalid()
    dependencies.push({ id: dependencyId, version })
  }
  const inputSchema = parseSchema(item.inputSchema)
  const outputSchema = parseSchema(item.outputSchema)
  if (inputSchema.type !== 'object' || outputSchema.type !== 'object'
    || Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_SCHEMA_BYTES
    || Buffer.byteLength(JSON.stringify(outputSchema)) > MAX_SCHEMA_BYTES) throw invalid()
  const resources = parseResources(item.resources)
  if (resources.minVramBytes !== undefined && resources.minVramBytes > 0 && !permissions.includes('gpu')) throw invalid()
  return { id, title, description, binding: { kind, ref }, inputSchema, outputSchema, permissions,
    dataScope: item.dataScope as ComputePluginDataScope, networkOrigins, dependencies, resources }
}

/** Validate one untrusted recipe without executing a model, workflow or package. */
export function parsePluginDraftSpec(value: unknown): PluginDraftSpec {
  const item = record(value)
  if (item === null || !only(item, ['pluginId', 'version', 'displayName', 'operations'])) throw invalid()
  const pluginId = text(item.pluginId, 128)
  const version = text(item.version, 64)
  const displayName = text(item.displayName, 80)
  if (pluginId === null || !LOGICAL_ID.test(pluginId) || version === null || !VERSION.test(version)
    || displayName === null || !Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > 16) throw invalid()
  const operations = item.operations.map(parseOperation)
  if (new Set(operations.map(operation => operation.id)).size !== operations.length) throw invalid()
  const spec = { pluginId, version, displayName, operations }
  if (Buffer.byteLength(JSON.stringify(spec)) > MAX_DRAFT_BYTES) throw invalid()
  return spec
}

/** Parse one owner request; callers cannot set state, readiness or visibility. */
export function parsePluginDraftSaveRequest(value: unknown): PluginDraftSaveRequest {
  const item = record(value)
  if (item === null || !only(item, ['id', 'spec']) || (item.id !== undefined && (typeof item.id !== 'string' || !DRAFT_ID.test(item.id)))) throw invalid()
  return { ...(item.id === undefined ? {} : { id: item.id }), spec: parsePluginDraftSpec(item.spec) }
}

/** Parse an opaque local draft identifier used by read/export. */
export function parsePluginDraftId(value: unknown): string {
  if (typeof value !== 'string' || !DRAFT_ID.test(value)) throw invalid()
  return value
}

function receipt(id: string, createdAt: string, updatedAt: string, spec: PluginDraftSpec): LocalPluginDraft {
  return { id, createdAt, updatedAt, state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
}

/** Atomic private recipe store; it does not touch the market declaration file or Shanghai. */
export class LocalPluginDraftStore {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly config: PluginDraftStoreConfig) {
    if (!isAbsolute(config.path) || !Number.isSafeInteger(config.maxDrafts) || config.maxDrafts < 1 || config.maxDrafts > 1000
      || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < MAX_DRAFT_BYTES || config.maxBytes > 32 * 1024 * 1024) throw invalid()
  }

  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const operation = run()
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation)).catch(() => {})
    return operation
  }

  private async read(): Promise<StoredPluginDraft[]> {
    let file
    try { file = await open(this.config.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw invalid()
      const buffer = Buffer.alloc(this.config.maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const part = await file.read(buffer, length, buffer.length - length, null)
        if (!part.bytesRead) break
        length += part.bytesRead
      }
      if (length > this.config.maxBytes) throw invalid()
      const document = record(JSON.parse(buffer.toString('utf8', 0, length)) as unknown)
      if (document === null || !only(document, ['version', 'drafts']) || document.version !== 1
        || !Array.isArray(document.drafts) || document.drafts.length > this.config.maxDrafts) throw invalid()
      const drafts: StoredPluginDraft[] = []
      for (const raw of document.drafts) {
        const item = record(raw)
        if (item === null || !only(item, ['id', 'createdAt', 'updatedAt', 'state', 'installable', 'dispatchable', 'readiness', 'spec', 'comfyAssets'])) throw invalid()
        const id = parsePluginDraftId(item.id)
        const createdAt = item.createdAt
        const updatedAt = item.updatedAt
        const readiness = record(item.readiness)
        if (typeof createdAt !== 'string' || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
          || !Number.isFinite(Date.parse(updatedAt)) || new Date(createdAt).toISOString() !== createdAt
          || new Date(updatedAt).toISOString() !== updatedAt || item.state !== 'private-draft'
          || item.installable !== false || item.dispatchable !== false || readiness === null
          || !only(readiness, ['adapter', 'probe', 'signing', 'review'])
          || readiness.adapter !== 'pending' || readiness.probe !== 'pending'
          || readiness.signing !== 'pending' || readiness.review !== 'pending'
          || drafts.some(draft => draft.id === id)) throw invalid()
        const spec = parsePluginDraftSpec(item.spec)
        const assets = item.comfyAssets === undefined ? [] : item.comfyAssets
        if (!Array.isArray(assets) || assets.length > spec.operations.length) throw invalid()
        const parsedAssets = assets.map(parseStoredPrivateComfyDraftAsset)
        if (new Set(parsedAssets.map(asset => asset.operationId)).size !== parsedAssets.length
          || parsedAssets.some(asset => !spec.operations.some(operation => operation.id === asset.operationId
            && operation.binding.kind === 'workflow' && operation.binding.ref.startsWith('comfy:')))) throw invalid()
        drafts.push({ ...receipt(id, createdAt, updatedAt, spec),
          ...(parsedAssets.length === 0 ? {} : { comfyAssets: parsedAssets }) })
      }
      return drafts
    } catch { throw new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  /** Read all owner-local drafts without contacting a package manager or a server. */
  list(): Promise<LocalPluginDraft[]> {
    return this.track(async () => (await this.read()).map(draft => receipt(draft.id, draft.createdAt, draft.updatedAt, draft.spec)))
  }

  /** Save a new recipe or replace one by its local id; no package or capability is activated. */
  save(value: unknown): Promise<LocalPluginDraft> {
    return this.track(async () => {
      const request = parsePluginDraftSaveRequest(value)
      try {
        await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
        return await withFileLock(this.config.path, async () => {
          const drafts = await this.read()
          const previous = request.id === undefined ? undefined : drafts.find(draft => draft.id === request.id)
          if (request.id !== undefined && previous === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
          if (previous === undefined && drafts.length >= this.config.maxDrafts) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_CAPACITY', 409)
          const now = new Date().toISOString()
          const keptAssets = previous?.comfyAssets?.filter((asset) => {
            const before = previous.spec.operations.find(operation => operation.id === asset.operationId)
            const after = request.spec.operations.find(operation => operation.id === asset.operationId)
            return before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after)
          }) ?? []
          const draft: StoredPluginDraft = { ...receipt(previous?.id ?? `plugin_draft_${randomUUID()}`,
            previous?.createdAt ?? now, now, request.spec),
          ...(keptAssets.length === 0 ? {} : { comfyAssets: keptAssets }) }
          const content = JSON.stringify({ version: 1, drafts: [draft, ...drafts.filter(item => item.id !== draft.id)] })
          if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_CAPACITY', 409)
          await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
          return receipt(draft.id, draft.createdAt, draft.updatedAt, draft.spec)
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /** Store one confirmed ComfyUI API graph inside this private draft, never in a market package. */
  bindComfyAsset(value: {
    readonly id: unknown
    readonly expectedUpdatedAt: unknown
    readonly operationId: unknown
    readonly workflow: unknown
    readonly mapping: unknown
  }): Promise<ComfyDraftAssetSummary> {
    return this.track(async () => {
      const id = parsePluginDraftId(value.id)
      if (typeof value.expectedUpdatedAt !== 'string') throw invalid()
      const asset = preparePrivateComfyDraftAsset({ operationId: value.operationId,
        workflow: value.workflow, mapping: value.mapping })
      try {
        await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
        return await withFileLock(this.config.path, async () => {
          const drafts = await this.read()
          const previous = drafts.find(draft => draft.id === id)
          if (previous === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
          if (previous.updatedAt !== value.expectedUpdatedAt) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_CHANGED', 409)
          const operation = previous.spec.operations.find(item => item.id === asset.operationId)
          if (operation?.binding.kind !== 'workflow' || !operation.binding.ref.startsWith('comfy:')) throw invalid()
          const now = new Date().toISOString()
          const updated: StoredPluginDraft = { ...receipt(previous.id, previous.createdAt, now, previous.spec),
            comfyAssets: [...(previous.comfyAssets ?? []).filter(item => item.operationId !== asset.operationId), asset] }
          const content = JSON.stringify({ version: 1, drafts: [updated, ...drafts.filter(item => item.id !== id)] })
          if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_CAPACITY', 409)
          await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
          return privateComfyDraftAssetSummary(asset)
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /** Read back the private graph for a future trusted local adapter; never expose it to model tools. */
  readComfyAsset(idValue: unknown, operationId: unknown): Promise<PrivateComfyDraftAsset> {
    return this.track(async () => {
      const id = parsePluginDraftId(idValue)
      if (typeof operationId !== 'string' || !LOGICAL_ID.test(operationId)) throw invalid()
      const draft = (await this.read()).find(item => item.id === id)
      if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      const asset = draft.comfyAssets?.find(item => item.operationId === operationId)
      if (asset === undefined) throw new ComputeError('COMPUTE_COMFY_DRAFT_ASSET_NOT_FOUND', 404)
      return asset
    })
  }

  /** Only hashes and counts are returned to an agent inspecting its owner's draft. */
  comfyAssetSummaries(idValue: unknown): Promise<readonly ComfyDraftAssetSummary[]> {
    return this.track(async () => {
      const id = parsePluginDraftId(idValue)
      const draft = (await this.read()).find(item => item.id === id)
      if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      return (draft.comfyAssets ?? []).map(privateComfyDraftAssetSummary)
    })
  }

  /** Export a private recipe as data only; no code, weights, installer or signature is emitted. */
  export(value: unknown): Promise<PluginDraftExport> {
    return this.track(async () => {
      const id = parsePluginDraftId(value)
      const draft = (await this.read()).find(item => item.id === id)
      if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      return { fileName: `${draft.spec.pluginId}-${draft.spec.version}.plugin-draft.json`, contentType: 'application/json',
        contents: `${JSON.stringify({ format: 'qianshou.plugin-draft.v1', ...receipt(draft.id, draft.createdAt, draft.updatedAt, draft.spec) }, null, 2)}\n` }
    })
  }

  /** Preview a structural package plan against this device without loading the binding. */
  preview(value: unknown): Promise<PluginDraftPackagePreview> {
    return this.track(async () => {
      const id = parsePluginDraftId(value)
      const draft = (await this.read()).find(item => item.id === id)
      if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      let freeDiskBytes: number | null = null
      try {
        const stats = await statfs(dirname(this.config.path))
        const measured = stats.bavail * stats.bsize
        if (Number.isSafeInteger(measured)) freeDiskBytes = measured
      } catch {
        // An unmeasurable volume remains not-probed; it never passes a disk requirement.
      }
      return previewPluginDraft(receipt(draft.id, draft.createdAt, draft.updatedAt, draft.spec), {
        platform: platform(), architecture: arch(), totalMemoryBytes: totalmem(), freeDiskBytes,
      }, (draft.comfyAssets ?? []).map(privateComfyDraftAssetSummary))
    })
  }

  /** Refuse new operations and wait for already admitted disk operations to settle. */
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.pending]) }
}
