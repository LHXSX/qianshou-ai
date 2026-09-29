/** Owner-local H3 draft preparation; local evidence never implies cloud approval or supply. */
import { createHash } from 'node:crypto'
import { nativeH3LogicalBindingSha256, parseNativeH3PortableExecutionBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import type { NativeH3LocalIdentityV2 } from '@deepseek-ai/dsh-host-node-contributor/src/h3-video.ts'
import type { NativeH3LocalIdentityCanonical } from '@deepseek-ai/dsh-host-node-contributor/src/h3-canonical-provider.ts'
import type { H3SkillDraftRequest, H3SkillDraftResult, H3OwnerSetupContextId, H3CanonicalSetupContextId } from '@deepseek-ai/dsh-host-node-contributor/h3-owner-setup-types'
import type { NativeSkillDraftRequest, NativeSkillDraftReceipt } from '@deepseek-ai/dsh-host-qianshou-skill-import/src/native-skill-draft.ts'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from './native-h3-order-source.ts'

/** Current authenticated author and actual profile; no credential fallback is accepted. */
export interface H3DraftScope { readonly ownerId: number; readonly profileDir: string }

/** Independent managed contexts retain their original runtime namespace. */
export type H3DraftContextId = H3OwnerSetupContextId | H3CanonicalSetupContextId

/** Draft commands carry the context issued by their owning setup helper. */
export type H3DraftRequest<C extends H3DraftContextId = H3OwnerSetupContextId> = Omit<H3SkillDraftRequest, 'contextId'> & { readonly contextId: C }

/** The catalog owns the files; the importer owns the destination and rollback. */
export interface H3DraftPorts<C extends H3DraftContextId = H3OwnerSetupContextId> {
  readonly readScope: () => Promise<H3DraftScope | null>
  readonly readBinding: (revision: number, contextId: C)
  => Promise<NativeH3LocalIdentityV2 | NativeH3LocalIdentityCanonical>
  readonly installDraft: (request: NativeSkillDraftRequest, signal: AbortSignal) => Promise<NativeSkillDraftReceipt>
}

/** Only finite machine-readable diagnostics may cross the remote method. */
export class H3OwnerOnboardingError extends Error {
  /** Discard filesystem paths and upstream response details.
   * @param error - Local failure from the setup, provider or importer.
   */
  constructor(error: unknown) {
    const code: unknown = error instanceof Error && 'code' in error ? error.code
      : error instanceof Error ? error.message : undefined
    super(typeof code === 'string' && /^(?:H3_[A-Z0-9_]{1,80}|NATIVE_SKILL_DRAFT_[A-Z0-9_]{1,64})$/u.test(code)
      ? code : 'H3_SETUP_UNAVAILABLE')
  }
}

function invalid(): never { throw new H3OwnerOnboardingError(new Error('H3_SETUP_DRAFT_INVALID')) }

/** Save one validated five-file local draft from the current real trial, with no platform write.
 * @param ports - Current author, verified provider and trusted local importer.
 * @param request - Explicit name and display text for the current managed revision.
 * @param signal - Cancellation before the importer publishes SKILL.md.
 * @returns A local draft receipt without private paths or runtime configuration.
 */
export async function createH3OwnerSkillDraft<C extends H3DraftContextId>(ports: H3DraftPorts<C>, request: H3DraftRequest<C>,
  signal: AbortSignal): Promise<H3SkillDraftResult> {
  const input: unknown = request
  if (input === null || typeof input !== 'object'
    || Object.keys(request).sort().join(',') !== 'contextId,description,displayName,name,revision'
    || typeof request.contextId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(request.contextId)
    || !Number.isSafeInteger(request.revision) || request.revision < 1
    || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)
    || typeof request.displayName !== 'string' || !request.displayName.isWellFormed() || !request.displayName.trim()
    || Array.from(request.displayName).length > 80
    || typeof request.description !== 'string' || !request.description.isWellFormed() || !request.description.trim()
    || Array.from(request.description).length > 500) invalid()
  signal.throwIfAborted()
  const scope = await ports.readScope()
  if (scope === null) throw new H3OwnerOnboardingError(new Error('H3_SETUP_LOGIN_REQUIRED'))
  const original = await ports.readBinding(request.revision, request.contextId)
  const identity = canonicalNativeH3ReviewJson(original)
  const taskType = `qianshou_h3_${createHash('sha256').update(`${scope.ownerId}\0`)
    .update(nativeH3LogicalBindingSha256(original.binding)).digest('hex').slice(0, 32)}_v2`
  const template = nativeH3AuthoringTemplate(parseNativeH3PortableExecutionBinding(original.binding), request.name, taskType)
  const files = {
    'SKILL.md': `---\nname: ${request.name}\ndescription: ${JSON.stringify(request.description)}\nmetadata:\n`
      + `  displayName: ${JSON.stringify(request.displayName)}\n  category: video\n---\n\n# ${request.displayName}\n\n`
      + '填写视频描述，使用已核验的本机 H3 生成固定五秒 MP4。发布前仍需平台独立样例核验和人工审核。\n',
    'scripts/order_adapter/package.json': template.files['scripts/order_adapter/package.json'],
    'scripts/order_adapter/pnpm-lock.yaml': template.files['scripts/order_adapter/pnpm-lock.yaml'],
    'scripts/order_adapter/local-adapter.json': template.files['scripts/order_adapter/local-adapter.json'],
    'scripts/order_adapter/task-definition.json': template.files['scripts/order_adapter/task-definition.json'],
  }
  const assertCurrent = async (): Promise<void> => {
    signal.throwIfAborted()
    const current = await ports.readScope()
    if (current?.ownerId !== scope.ownerId || current.profileDir !== scope.profileDir
      || canonicalNativeH3ReviewJson(await ports.readBinding(request.revision, request.contextId)) !== identity) {
      throw new H3OwnerOnboardingError(new Error('H3_SETUP_OWNER_CHANGED'))
    }
    signal.throwIfAborted()
  }
  await ports.installDraft({ name: request.name, files, assertCurrent,
    async verifyWritten(skillPath) {
      const source = await readNativeH3OrderSource(skillPath)
      if (source.declaration.contractVersion !== 'v2' || source.taskDefinition.taskType !== taskType
        || canonicalNativeH3ReviewJson(source.taskDefinition.nativeBinding)
          !== canonicalNativeH3ReviewJson(original.binding)) invalid()
      for (const file of source.files) {
        const expected = Object.entries(files).find(([path]) => path === `scripts/order_adapter/${file.path}`)?.[1]
        if (expected === undefined || file.bytes.toString('utf8') !== expected) invalid()
      }
    },
  }, signal)
  return { state: 'draft', revision: request.revision, name: request.name,
    displayName: request.displayName, published: false }
}
