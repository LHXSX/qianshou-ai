/** Real exclusive writer plus native archive reader: no platform requests or GPU execution. */
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { H3OwnerSetupContextId } from '../src/types.ts'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { installNativeSkillDraft } from '../../qianshou-skill-import/src/native-skill-draft.ts'
import { createH3OwnerSkillDraft, H3OwnerOnboardingError, type H3DraftScope } from '../src/h3-owner-onboarding.ts'
import { readNativeH3OrderSource } from '../src/native-h3-order-source.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { binding: { schema: 'qianshou.native-h3-execution-binding.v2' as const,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: 'b'.repeat(64),
  modelSha256: 'c'.repeat(64), firstFrameSha256: 'd'.repeat(64) }, localOwnerConfigDigest: `sha256:${'e'.repeat(64)}` }
const request = { contextId: brandString<H3OwnerSetupContextId>('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), revision: 1, name: 'qs-wizard-h3-test', displayName: '我的五秒视频', description: '根据文字和我的固定首帧生成视频。' }
async function fixture(runtime: 'python-v2' | 'canonical' = 'python-v2') {
  const actual = runtime === 'canonical' ? { ...binding, binding: { ...binding.binding, runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL } } : binding
  const root = await mkdtemp(join(await realpath(tmpdir()), 'qs-wizard-draft-')); roots.push(root)
  const scope = { value: { ownerId: 7, profileDir: root } as H3DraftScope | null }
  return { root, scope, actual, ports: { readScope: async () => scope.value, readBinding: async (revision: number) => {
    if (revision !== 1) throw new Error('H3_SETUP_REVISION_CONFLICT')
    return actual
  }, installDraft: (input: Parameters<typeof installNativeSkillDraft>[1], signal: AbortSignal) =>
    installNativeSkillDraft(root, input, signal) } }
}

it.each(['python-v2', 'canonical'] as const)('creates all five real %s files with Chinese presentation and reads the actual V2 declaration before success', async (runtime) => {
  const f = await fixture(runtime)
  expect(await createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)).toEqual({ state: 'draft',
    revision: 1, name: request.name, displayName: request.displayName, published: false })
  const skill = join(f.root, request.name, 'SKILL.md')
  const source = await readNativeH3OrderSource(skill)
  expect(source.declaration.contractVersion).toBe('v2')
  expect(source.taskDefinition.schema).toBe('qianshou.reviewed-task-definition.v2')
  expect(source.taskDefinition.nativeBinding).toEqual(f.actual.binding)
  expect(source.files).toHaveLength(4)
  expect(await readFile(skill, 'utf8')).toContain('我的五秒视频')
  expect(source.files.every(file => !file.bytes.includes(Buffer.from(binding.localOwnerConfigDigest)))).toBe(true)
  await expect(createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)).rejects.toThrow('NATIVE_SKILL_DRAFT_CONFLICT')
  expect((await readNativeH3OrderSource(skill)).digest).toBe(source.digest)
})

it('keeps the locked public task definition stable when only local display text differs', async () => {
  const f = await fixture()
  await createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)
  await createH3OwnerSkillDraft(f.ports, { ...request, name: 'qs-another-local-name', displayName: '另一个中文名称' }, new AbortController().signal)
  const a = await readNativeH3OrderSource(join(f.root, request.name, 'SKILL.md'))
  const b = await readNativeH3OrderSource(join(f.root, 'qs-another-local-name', 'SKILL.md'))
  expect(a.taskDefinition).toEqual(b.taskDefinition)
  expect(a.taskDefinition.taskType).toBe(b.taskDefinition.taskType)
})

it('rejects unauthenticated authors and noncurrent revisions before creating any skill', async () => {
  const f = await fixture()
  f.scope.value = null
  await expect(createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)).rejects.toThrow('H3_SETUP_LOGIN_REQUIRED')
  f.scope.value = { ownerId: 7, profileDir: f.root }
  await expect(createH3OwnerSkillDraft(f.ports, { ...request, revision: 2 }, new AbortController().signal)).rejects.toThrow('H3_SETUP_REVISION_CONFLICT')
  expect(await readdir(f.root)).toEqual([])
})

it('rolls back only the just-created draft when the author changes during actual verification', async () => {
  const f = await fixture()
  const install = f.ports.installDraft
  f.ports.installDraft = (input, signal) => install({ ...input, verifyWritten: async (path) => {
    await input.verifyWritten(path)
    f.scope.value = { ownerId: 8, profileDir: f.root }
  } }, signal)
  await expect(createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)).rejects.toThrow('H3_SETUP_OWNER_CHANGED')
  expect(await readdir(f.root)).toEqual([])
})

it('preserves foreign bytes when a real source member changes before source verification', async () => {
  const f = await fixture()
  const install = f.ports.installDraft
  f.ports.installDraft = (input, signal) => install({ ...input, verifyWritten: async (path) => {
    const changed = join(f.root, request.name, 'scripts/order_adapter/local-adapter.json')
    await writeFile(changed, 'foreign change')
    await input.verifyWritten(path)
  } }, signal)
  await expect(createH3OwnerSkillDraft(f.ports, request, new AbortController().signal)).rejects.toThrow()
  expect(await readFile(join(f.root, request.name, 'scripts/order_adapter/local-adapter.json'), 'utf8')).toBe('foreign change')
  expect(await readdir(join(f.root, request.name))).toEqual(['scripts'])
})

it('redacts local paths and arbitrary upstream error text at the Remote facade boundary', () => {
  expect(new H3OwnerOnboardingError(new Error('/private/account/token.json failed')).message).toBe('H3_SETUP_UNAVAILABLE')
  expect(new H3OwnerOnboardingError(new Error('H3_SETUP_BUSY')).message).toBe('H3_SETUP_BUSY')
})
