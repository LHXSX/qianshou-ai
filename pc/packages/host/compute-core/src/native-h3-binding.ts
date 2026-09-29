/** Fixed H3 declarations contain identities, never executable code or owner paths. */
import { ComputeError } from './errors.ts'
import { createHash } from 'node:crypto'

/** Public ABI for the compiled, owner-configured H3 runner. */
export const NATIVE_H3_RUNTIME_ABI = 'qianshou.order-runtime.native-h3.v1' as const

/** Fixed shipped Python sources; publication source identity is a separate digest. */
export const NATIVE_H3_RUNTIME = Object.freeze({
  engine: 'h3' as const,
  version: 'h3-runtime-v1' as const,
  entrySha256: '9af9d263aa8b9d9e68c73e6b5686de86a43df10e208add88df24064efd2f4467',
  runtimeSha256: 'cf977bcf259901274cf2b44016fa0964f59b661c8d663b75a08f4dbe45c66e52',
})

/** Runtime identity admitted only for the shipped fixed H3 implementation. */
export type NativeH3Runtime = typeof NATIVE_H3_RUNTIME

/** These five fields are included in the platform task contract SHA. */
export interface NativeH3ContractBinding {
  readonly runtimeAbi: typeof NATIVE_H3_RUNTIME_ABI
  readonly runtime: NativeH3Runtime
  /** Digest of the current private configuration and actual adapter identities. */
  readonly ownerConfigDigest: string
  /** SHA of the actual generation graph, excluding only prompt and seed inputs. */
  readonly executionRecipeSha256: string
  /** SHA of the actual model bytes used by that graph, not file stat facts. */
  readonly modelSha256: string
}

/** Author preparation returns only identities; it neither grants supply nor runs a job. */
export type NativeH3AuthorBinding = NativeH3ContractBinding

/** Exact JSON-only author declaration; inputs cannot select paths or executables. */
export interface NativeH3Declaration extends NativeH3ContractBinding {
  readonly schema: 'qianshou.native-h3-binding.v1'
  readonly taskType: string
  readonly capabilityId: 'video.render'
  readonly inputKinds: readonly ['inline']
  readonly outputKind: 'artifact_ref'
  readonly contractVersion: 'v1'
  readonly category: 'video'
  readonly platformDispatchable: true
}

const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const TASK = /^[a-z][a-z0-9_]{2,63}$/u
const BINDING_KEYS = ['executionRecipeSha256', 'modelSha256', 'ownerConfigDigest', 'runtime', 'runtimeAbi']
const DECLARATION_KEYS = [...BINDING_KEYS, 'schema', 'taskType', 'capabilityId', 'inputKinds',
  'outputKind', 'contractVersion', 'category', 'platformDispatchable']

function invalid(): never { throw new ComputeError('H3_NATIVE_BINDING_INVALID', 400) }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}

function bindingOf(value: Record<string, unknown>): NativeH3ContractBinding {
  const runtime = object(value.runtime)
  exact(runtime, ['engine', 'version', 'entrySha256', 'runtimeSha256'])
  if (value.runtimeAbi !== NATIVE_H3_RUNTIME_ABI
    || Object.entries(NATIVE_H3_RUNTIME).some(([key, expected]) => runtime[key] !== expected)
    || typeof value.ownerConfigDigest !== 'string' || !DIGEST.test(value.ownerConfigDigest)
    || typeof value.executionRecipeSha256 !== 'string' || !HASH.test(value.executionRecipeSha256)
    || typeof value.modelSha256 !== 'string' || !HASH.test(value.modelSha256)) invalid()
  return Object.freeze({ runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
    ownerConfigDigest: value.ownerConfigDigest, executionRecipeSha256: value.executionRecipeSha256,
    modelSha256: value.modelSha256 })
}

/** Parse the exact public native binding included in a reviewed task contract.
 * @param value - Untrusted JSON from an author or platform contract.
 * @returns A frozen binding with the fixed shipped runtime pins.
 */
export function parseNativeH3ContractBinding(value: unknown): NativeH3ContractBinding {
  const item = object(value)
  exact(item, BINDING_KEYS)
  return bindingOf(item)
}

/** Parse a fixed H3 author declaration without accepting private paths or code.
 * @param value - Untrusted local-adapter JSON.
 * @returns A frozen exact declaration suitable for source inventory checks.
 */
export function parseNativeH3Declaration(value: unknown): NativeH3Declaration {
  const item = object(value)
  exact(item, DECLARATION_KEYS)
  const binding = bindingOf(item)
  if (item.schema !== 'qianshou.native-h3-binding.v1'
    || typeof item.taskType !== 'string' || !TASK.test(item.taskType)
    || item.capabilityId !== 'video.render' || item.outputKind !== 'artifact_ref'
    || item.contractVersion !== 'v1' || item.category !== 'video' || item.platformDispatchable !== true
    || !Array.isArray(item.inputKinds) || item.inputKinds.length !== 1 || item.inputKinds[0] !== 'inline') invalid()
  return Object.freeze({ ...binding, schema: 'qianshou.native-h3-binding.v1', taskType: item.taskType,
    capabilityId: 'video.render', inputKinds: Object.freeze(['inline'] as const), outputKind: 'artifact_ref',
    contractVersion: 'v1', category: 'video', platformDispatchable: true })
}

/** Independently audited V2 recipe/runtime; V1 source and ABI remain unchanged. */
export const NATIVE_H3_RUNTIME_ABI_V2 = 'qianshou.order-runtime.native-h3.v2' as const
/** Fixed V2 node entry and runtime byte identities, separate from the V1 runner. */
export const NATIVE_H3_RUNTIME_V2 = Object.freeze({ engine: 'h3', version: 'h3-runtime-v2',
  entrySha256: '47e701742c3f4a38845e562ab7d578cb4de16877f9f13f60dca35d509ba860b8',
  runtimeSha256: '2c4690b84aefc3fcf036de2b9ccc73f4b68fca33560b208123a9c5ffff239bdf' } as const)

/** Portable execution identity. Local paths and file timestamps never enter this contract. */
export interface NativeH3ExecutionBindingV2 {
  readonly schema: 'qianshou.native-h3-execution-binding.v2'
  readonly runtimeAbi: typeof NATIVE_H3_RUNTIME_ABI_V2
  readonly runtime: typeof NATIVE_H3_RUNTIME_V2
  readonly executionRecipeSha256: string
  readonly modelSha256: string
  readonly firstFrameSha256: string
}

/** Explicit successor author declaration; v1 publications retain their exact original bytes. */
export interface NativeH3DeclarationV2 extends Omit<NativeH3Declaration,
  'schema' | 'ownerConfigDigest' | 'contractVersion' | 'runtimeAbi' | 'runtime'> {
  readonly schema: 'qianshou.native-h3-binding.v2'
  readonly contractVersion: 'v2'
  readonly runtimeAbi: typeof NATIVE_H3_RUNTIME_ABI_V2
  readonly runtime: typeof NATIVE_H3_RUNTIME_V2
  readonly firstFrameSha256: string
}

/** Explicit software variant measured from the received canonical Windows source, not an approval. */
export const NATIVE_H3_RUNTIME_ABI_CANONICAL = 'qianshou.order-runtime.native-h3.canonical.v1' as const
/** Source entry and runner pins for the source-only Windows 48558c snapshot. */
export const NATIVE_H3_RUNTIME_CANONICAL = Object.freeze({ engine: 'h3-canonical-api', version: 'h3-canonical-api-v1',
  entrySha256: '2f91973ae7b9f0cf9764715770408a192042c9a22cdc9715caa6de280102f483',
  runtimeSha256: 'b7ef04c2a87394f94cc13d6098cab1a18b57be29e7be6c865acd5772d6133557' } as const)

/** Portable canonical identity uses the existing six-field contract with its own explicit runtime ABI. */
export interface NativeH3CanonicalExecutionBinding extends Omit<NativeH3ExecutionBindingV2, 'runtimeAbi' | 'runtime'> {
  readonly runtimeAbi: typeof NATIVE_H3_RUNTIME_ABI_CANONICAL
  readonly runtime: typeof NATIVE_H3_RUNTIME_CANONICAL
}
/** Canonical author source is a V2 task contract with a separately declared software variant. */
export interface NativeH3CanonicalDeclaration extends Omit<NativeH3DeclarationV2, 'runtimeAbi' | 'runtime'> {
  readonly runtimeAbi: typeof NATIVE_H3_RUNTIME_ABI_CANONICAL
  readonly runtime: typeof NATIVE_H3_RUNTIME_CANONICAL
}
/** V2 task-contract variants retain distinct runtime types and parsers. */
export type NativeH3PortableExecutionBinding = NativeH3ExecutionBindingV2 | NativeH3CanonicalExecutionBinding

/** Public identities accepted by the fixed runner, discriminated by their schema. */
export type AnyNativeH3ContractBinding = NativeH3ContractBinding | NativeH3PortableExecutionBinding
/** Versioned immutable author declarations, without optional private binding fields. */
export type AnyNativeH3Declaration = NativeH3Declaration | NativeH3DeclarationV2 | NativeH3CanonicalDeclaration

const V2_BINDING_KEYS = ['schema', 'runtimeAbi', 'runtime', 'executionRecipeSha256', 'modelSha256', 'firstFrameSha256']
const V2_DECLARATION_KEYS = ['schema', 'runtimeAbi', 'runtime', 'executionRecipeSha256',
  'modelSha256', 'firstFrameSha256', 'taskType', 'capabilityId', 'inputKinds', 'outputKind',
  'contractVersion', 'category', 'platformDispatchable']

/** Parse an exact path-independent public execution identity.
 * @param value - Untrusted v2 execution metadata, never an owner configuration.
 * @returns Frozen binding with the independently audited V2 ABI and source pins.
 */
export function parseNativeH3ExecutionBindingV2(value: unknown): NativeH3ExecutionBindingV2 {
  const item = object(value)
  exact(item, V2_BINDING_KEYS)
  const runtime = object(item.runtime)
  exact(runtime, ['engine', 'version', 'entrySha256', 'runtimeSha256'])
  if (item.schema !== 'qianshou.native-h3-execution-binding.v2' || item.runtimeAbi !== NATIVE_H3_RUNTIME_ABI_V2
    || Object.entries(NATIVE_H3_RUNTIME_V2).some(([key, expected]) => runtime[key] !== expected)
    || ![item.executionRecipeSha256, item.modelSha256, item.firstFrameSha256]
      .every(value => typeof value === 'string' && HASH.test(value))) invalid()
  return Object.freeze({ schema: 'qianshou.native-h3-execution-binding.v2', runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2,
    runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: String(item.executionRecipeSha256),
    modelSha256: String(item.modelSha256), firstFrameSha256: String(item.firstFrameSha256) })
}

/** Parse the explicit v2 declaration; a v1 source is never promoted implicitly.
 * @param value - Exact JSON-only v2 author declaration.
 * @returns Frozen public declaration with a v2 task contract and no local configuration digest.
 */
export function parseNativeH3DeclarationV2(value: unknown): NativeH3DeclarationV2 {
  const item = object(value)
  exact(item, V2_DECLARATION_KEYS)
  const binding = parseNativeH3ExecutionBindingV2({ schema: 'qianshou.native-h3-execution-binding.v2',
    runtimeAbi: item.runtimeAbi, runtime: item.runtime, executionRecipeSha256: item.executionRecipeSha256,
    modelSha256: item.modelSha256, firstFrameSha256: item.firstFrameSha256 })
  if (item.schema !== 'qianshou.native-h3-binding.v2'
    || typeof item.taskType !== 'string' || !TASK.test(item.taskType)
    || item.capabilityId !== 'video.render' || item.outputKind !== 'artifact_ref'
    || item.contractVersion !== 'v2' || item.category !== 'video' || item.platformDispatchable !== true
    || !Array.isArray(item.inputKinds) || item.inputKinds.length !== 1 || item.inputKinds[0] !== 'inline') invalid()
  return Object.freeze({ runtimeAbi: binding.runtimeAbi, runtime: binding.runtime,
    executionRecipeSha256: binding.executionRecipeSha256, modelSha256: binding.modelSha256,
    firstFrameSha256: binding.firstFrameSha256, schema: 'qianshou.native-h3-binding.v2',
    taskType: item.taskType, capabilityId: 'video.render', inputKinds: Object.freeze(['inline'] as const),
    outputKind: 'artifact_ref', contractVersion: 'v2', category: 'video', platformDispatchable: true })
}

/** Parse the supported canonical software identity without promoting it to the fixed V2 runner.
 * @param value - Untrusted public six-field binding; private configuration and approval are excluded.
 * @returns Frozen canonical source pins and portable measured identities.
 */
export function parseNativeH3CanonicalExecutionBinding(value: unknown): NativeH3CanonicalExecutionBinding {
  const item = object(value)
  exact(item, V2_BINDING_KEYS)
  const runtime = object(item.runtime)
  exact(runtime, ['engine', 'version', 'entrySha256', 'runtimeSha256'])
  if (item.schema !== 'qianshou.native-h3-execution-binding.v2'
    || item.runtimeAbi !== NATIVE_H3_RUNTIME_ABI_CANONICAL
    || Object.entries(NATIVE_H3_RUNTIME_CANONICAL).some(([key, expected]) => runtime[key] !== expected)
    || ![item.executionRecipeSha256, item.modelSha256, item.firstFrameSha256]
      .every(value => typeof value === 'string' && HASH.test(value))) invalid()
  return Object.freeze({ schema: 'qianshou.native-h3-execution-binding.v2', runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL,
    runtime: NATIVE_H3_RUNTIME_CANONICAL, executionRecipeSha256: String(item.executionRecipeSha256),
    modelSha256: String(item.modelSha256), firstFrameSha256: String(item.firstFrameSha256) })
}

/** Dispatch only explicitly supported V2 task-contract software variants.
 * @param value - Exact public portable binding received through an authenticated contract.
 * @returns The distinct canonical or fixed V2 parser result; no software fallback occurs.
 */
export function parseNativeH3PortableExecutionBinding(value: unknown): NativeH3PortableExecutionBinding {
  return object(value).runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL
    ? parseNativeH3CanonicalExecutionBinding(value) : parseNativeH3ExecutionBindingV2(value)
}

/** Parse an explicitly declared canonical author source with an ordinary V2 task contract.
 * @param value - JSON-only author source with the canonical ABI and fixed source pins.
 * @returns Frozen declaration without private paths, device permissions or approval claims.
 */
export function parseNativeH3CanonicalDeclaration(value: unknown): NativeH3CanonicalDeclaration {
  const item = object(value)
  exact(item, V2_DECLARATION_KEYS)
  const binding = parseNativeH3CanonicalExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
    runtimeAbi: item.runtimeAbi, runtime: item.runtime, executionRecipeSha256: item.executionRecipeSha256,
    modelSha256: item.modelSha256, firstFrameSha256: item.firstFrameSha256 })
  if (item.schema !== 'qianshou.native-h3-binding.v2'
    || typeof item.taskType !== 'string' || !TASK.test(item.taskType)
    || item.capabilityId !== 'video.render' || item.outputKind !== 'artifact_ref'
    || item.contractVersion !== 'v2' || item.category !== 'video' || item.platformDispatchable !== true
    || !Array.isArray(item.inputKinds) || item.inputKinds.length !== 1 || item.inputKinds[0] !== 'inline') invalid()
  return Object.freeze({ runtimeAbi: binding.runtimeAbi, runtime: binding.runtime,
    executionRecipeSha256: binding.executionRecipeSha256, modelSha256: binding.modelSha256,
    firstFrameSha256: binding.firstFrameSha256, schema: 'qianshou.native-h3-binding.v2',
    taskType: item.taskType, capabilityId: 'video.render', inputKinds: Object.freeze(['inline'] as const),
    outputKind: 'artifact_ref', contractVersion: 'v2', category: 'video', platformDispatchable: true })
}

/** Parse only one explicitly declared binding generation.
 * @param value - Untrusted v1 or v2 public binding.
 * @returns The matching exact parser result; unknown versions are refused.
 */
export function parseAnyNativeH3ContractBinding(value: unknown): AnyNativeH3ContractBinding {
  return object(value).schema === 'qianshou.native-h3-execution-binding.v2'
    ? parseNativeH3PortableExecutionBinding(value) : parseNativeH3ContractBinding(value)
}

/** Parse one explicitly versioned author source without rewriting it.
 * @param value - Untrusted native author declaration.
 * @returns Exact v1 or v2 declaration, refusing unknown schemas.
 */
export function parseAnyNativeH3Declaration(value: unknown): AnyNativeH3Declaration {
  return object(value).schema === 'qianshou.native-h3-binding.v2'
    ? object(value).runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL
      ? parseNativeH3CanonicalDeclaration(value) : parseNativeH3DeclarationV2(value)
    : parseNativeH3Declaration(value)
}

/** Extract public execution metadata from a versioned author declaration.
 * @param declaration - Already parsed immutable source declaration.
 * @returns Exact public task binding, without device-private configuration.
 */
export function nativeH3DeclarationBinding(declaration: AnyNativeH3Declaration): AnyNativeH3ContractBinding {
  return declaration.schema === 'qianshou.native-h3-binding.v2'
    ? parseNativeH3PortableExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
      runtimeAbi: declaration.runtimeAbi, runtime: declaration.runtime,
      executionRecipeSha256: declaration.executionRecipeSha256, modelSha256: declaration.modelSha256,
      firstFrameSha256: declaration.firstFrameSha256 })
    : parseNativeH3ContractBinding({ runtimeAbi: declaration.runtimeAbi, runtime: declaration.runtime,
      ownerConfigDigest: declaration.ownerConfigDigest,
      executionRecipeSha256: declaration.executionRecipeSha256, modelSha256: declaration.modelSha256 })
}

/** Canonical public logical identity; does not include the digest in its own input.
 * @param binding - Exact v2 public identity from the real recipe reader.
 * @returns Raw lowercase SHA256 of recursively ASCII-sorted six-field metadata.
 */
export function nativeH3LogicalBindingSha256(binding: NativeH3PortableExecutionBinding): string {
  const stable = (value: unknown): string => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  return createHash('sha256').update(stable(parseNativeH3PortableExecutionBinding(binding))).digest('hex')
}

/** The public package identity preserves the original v1 digest meaning.
 * @param value - Parsed binding or author declaration.
 * @returns Original private-bound v1 digest, or the explicitly versioned v2 logical digest.
 */
export function nativeH3PublicBindingDigest(value: AnyNativeH3ContractBinding | AnyNativeH3Declaration): string {
  if ('ownerConfigDigest' in value) return value.ownerConfigDigest
  const binding = 'taskType' in value ? nativeH3DeclarationBinding(value) : value
  if ('ownerConfigDigest' in binding) return binding.ownerConfigDigest
  return `sha256:${nativeH3LogicalBindingSha256(binding)}`
}
