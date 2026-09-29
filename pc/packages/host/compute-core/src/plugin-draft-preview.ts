/** Read-only package plan for a private recipe. It never collects executable or local files. */
import { createHash } from 'node:crypto'
import type { LocalPluginDraft, PluginDraftOperation, PluginDraftSchema } from './plugin-draft.ts'
import type { ComfyDraftAssetSummary } from './comfy-draft-asset.ts'

export interface PluginDraftHostFacts {
  readonly platform: string
  readonly architecture: string
  readonly totalMemoryBytes: number
  readonly freeDiskBytes: number | null
}

export type PluginDraftCheckState = 'matched' | 'mismatched' | 'not-declared' | 'not-probed' | 'not-required' | 'unverified'

/** Only declared, structural facts enter this manifest. No binding ref, free text, URL or file content. */
export interface PluginDraftPlanManifest {
  readonly format: 'qianshou.plugin-package-plan.v1'
  readonly pluginId: string
  readonly version: string
  readonly installable: false
  readonly dispatchable: false
  readonly operations: readonly {
    readonly id: string
    readonly bindingKind: PluginDraftOperation['binding']['kind']
    readonly workflowGraphSha256?: string
    readonly inputFields: readonly string[]
    readonly outputFields: readonly string[]
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
    readonly permissions: readonly string[]
    readonly dataScope: PluginDraftOperation['dataScope']
    readonly dependencyCount: number
    readonly networkOriginCount: number
    readonly resources: PluginDraftOperation['resources']
  }[]
}

export interface PluginDraftOperationCheck {
  readonly operationId: string
  readonly state: 'blocked' | 'pending'
  readonly platform: PluginDraftCheckState
  readonly architecture: PluginDraftCheckState
  readonly memory: PluginDraftCheckState
  readonly disk: PluginDraftCheckState
  readonly gpuMemory: PluginDraftCheckState
  readonly binding: 'unverified'
  readonly bindingAsset: 'not-configured' | 'stored-needs-trial'
  readonly dependencies: 'unverified' | 'not-required'
}

/** A user can download the plan, but it is neither a runnable bundle nor an install declaration. */
export interface PluginDraftPackagePreview {
  readonly fileName: string
  readonly contentType: 'application/json'
  readonly contents: string
  readonly manifestSha256: string
  readonly manifest: PluginDraftPlanManifest
  readonly host: PluginDraftHostFacts
  readonly checks: readonly PluginDraftOperationCheck[]
  readonly state: 'blocked' | 'pending'
  readonly summary: string
}

function fields(schema: PluginDraftSchema): readonly string[] {
  return Object.keys(schema.properties ?? {}).sort()
}

function order(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function schemaStructure(schema: PluginDraftSchema): unknown {
  if (schema.type === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(schema.properties ?? {})
      .map(([key, value]) => [key, schemaStructure(value)])),
    required: [...(schema.required ?? [])].sort(), additionalProperties: false }
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) throw new Error('plugin-draft-preview-schema-invalid')
    return { type: 'array', items: schemaStructure(schema.items) }
  }
  return { type: schema.type }
}

function schemaDigest(schema: PluginDraftSchema): string {
  return createHash('sha256').update(canonical(schemaStructure(schema))).digest('hex')
}

/** Stable content across draft IDs, timestamps, declaration order and JSON key insertion order. */
export function pluginDraftPlanManifest(draft: LocalPluginDraft,
  bindings: readonly ComfyDraftAssetSummary[] = []): PluginDraftPlanManifest {
  return {
    format: 'qianshou.plugin-package-plan.v1', pluginId: draft.spec.pluginId, version: draft.spec.version,
    installable: false, dispatchable: false,
    operations: draft.spec.operations.map((operation) => {
      const binding = bindings.find(item => item.operationId === operation.id)
      return {
        id: operation.id, bindingKind: operation.binding.kind,
        ...(binding === undefined ? {} : { workflowGraphSha256: binding.graphSha256 }),
        inputFields: fields(operation.inputSchema), outputFields: fields(operation.outputSchema),
        inputSchemaSha256: schemaDigest(operation.inputSchema), outputSchemaSha256: schemaDigest(operation.outputSchema),
        permissions: [...operation.permissions].sort(), dataScope: operation.dataScope,
        dependencyCount: operation.dependencies.length, networkOriginCount: operation.networkOrigins.length,
        resources: { ...operation.resources,
          ...(operation.resources.platforms === undefined ? {} : { platforms: [...operation.resources.platforms].sort() }),
          ...(operation.resources.architectures === undefined ? {} : { architectures: [...operation.resources.architectures].sort() }) },
      }
    }).sort((a, b) => order(a.id, b.id)),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => order(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function declared(required: readonly string[] | undefined, observed: string): PluginDraftCheckState {
  if (required === undefined) return 'not-declared'
  return required.includes(observed) ? 'matched' : 'mismatched'
}

/** Hardware observations are limited to OS, CPU, physical memory and free disk. */
export function previewPluginDraft(draft: LocalPluginDraft, host: PluginDraftHostFacts,
  bindings: readonly ComfyDraftAssetSummary[] = []): PluginDraftPackagePreview {
  const manifest = pluginDraftPlanManifest(draft, bindings)
  const manifestSha256 = createHash('sha256').update(canonical(manifest)).digest('hex')
  const checks = draft.spec.operations.map((operation): PluginDraftOperationCheck => {
    const resources = operation.resources
    const platform = declared(resources.platforms, host.platform)
    const architecture = declared(resources.architectures, host.architecture)
    const memory = host.totalMemoryBytes >= resources.minTotalMemoryBytes ? 'matched' : 'mismatched'
    const disk = host.freeDiskBytes === null ? 'not-probed'
      : host.freeDiskBytes >= resources.minFreeDiskBytes ? 'matched' : 'mismatched'
    return {
      operationId: operation.id,
      state: [platform, architecture, memory, disk].includes('mismatched') ? 'blocked' : 'pending',
      platform, architecture, memory, disk,
      gpuMemory: (resources.minVramBytes ?? 0) > 0 ? 'not-probed' : 'not-required',
      binding: 'unverified',
      bindingAsset: bindings.some(binding => binding.operationId === operation.id) ? 'stored-needs-trial' : 'not-configured',
      dependencies: operation.dependencies.length > 0 ? 'unverified' : 'not-required',
    }
  }).sort((a, b) => order(a.operationId, b.operationId))
  const state = checks.some(check => check.state === 'blocked') ? 'blocked' : 'pending'
  const summary = state === 'blocked'
    ? '这台电脑至少有一项已检测的系统或资源条件不符合。模型、工作流或工具仍未试跑。此计划不能安装、发布或接单；分享前请核对你填写的标识和字段名。'
    : '已检测的系统和资源条件未发现阻碍；模型、工作流或工具绑定、依赖与显存仍需验证。此计划不能安装、发布或接单；分享前请核对你填写的标识和字段名。'
  const contents = `${canonical(manifest)}\n`
  return { fileName: `${manifest.pluginId}-${manifest.version}.plugin-plan.json`, contentType: 'application/json',
    contents, manifestSha256, manifest, host, checks, state, summary }
}
