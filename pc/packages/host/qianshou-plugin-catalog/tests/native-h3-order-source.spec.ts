import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from '../src/native-h3-order-source.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { identifyRegisteredOrderAdapter, prepareRegisteredOrderAdapter } from '../src/registered-order-adapters.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import { NATIVE_BINDING_INVENTORY_ALGORITHM, validateOrderSourceInventory } from '../src/order-source-inventory.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'a'.repeat(64)}`, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qs-native-h3-source-'))
  roots.push(root)
  const template = nativeH3AuthoringTemplate(binding, 'native-h3-test', 'qianshou_native_h3_test_v1')
  for (const [name, bytes] of Object.entries(template.files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  return join(root, 'SKILL.md')
}

it('packages a Chinese plain-text form with fixed duration and actual runtime identities, without executable code', async () => {
  const skill = await fixture()
  const source = await readNativeH3OrderSource(skill)
  expect(source.files.map(file => file.path)).toEqual(['local-adapter.json', 'package.json', 'pnpm-lock.yaml', 'task-definition.json'])
  expect(source.taskDefinition.inputSchema).toEqual({ type: 'string', title: '描述你想生成的视频',
    contentMediaType: 'text/plain', minLength: 1, maxLength: 7000 })
  expect(source.taskDefinition.nativeBinding).toEqual(binding)
  expect(source.taskDefinition.paramsSchema).toMatchObject({ additionalProperties: false, properties: {
    seconds: { enum: [5], minimum: 5, maximum: 5 }, seed: { minimum: 1, maximum: 2147483647 } } })
  const identity = await identifyRegisteredOrderAdapter(skill)
  expect(identity).toMatchObject({ taskType: 'qianshou_native_h3_test_v1', platformPriced: true, serviceTitle: 'H3 五秒视频生成' })
  const archive = await buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`, NATIVE_BINDING_INVENTORY_ALGORITHM)
  expect(archive.files).toHaveLength(4)
  expect(archive.artifactDigest).toBe(`sha256:${source.digest}`)
  expect(archive.archiveDigest).toBe(`sha256:${createHash('sha256').update(archive.bytes).digest('hex')}`)
})

it('requires the real native contributor and exact source/configuration tuple before publication preparation', async () => {
  const source = await prepareRegisteredOrderAdapter(await fixture())
  await expect(source.verifyLocal(undefined)).rejects.toMatchObject({ code: 'order-node-contributor-unavailable' })
  let observed: unknown
  const good = { taskType: source.taskType, artifactDigest: `sha256:${source.digest}`, packageDigest: binding.ownerConfigDigest,
    inventoryAlgorithm: NATIVE_BINDING_INVENTORY_ALGORITHM, localVerified: true, platformReady: false }
  const result = await source.verifyLocal({ selectNativeH3AuthorBinding: async (input) => { observed = input; return good } })
  expect(observed).toMatchObject({ sourceDigest: `sha256:${source.digest}`, taskDefinitionSha256: source.taskDefinitionSha256,
    declaration: { ...binding, capabilityId: 'video.render' } })
  expect(result.platformReady).toBe(false)
  await expect(source.verifyLocal({ selectNativeH3AuthorBinding: async () => ({ ...good, packageDigest: `sha256:${'d'.repeat(64)}` }) }))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it.each(['src/adapter.mjs', 'owner.config.json', 'model.safetensors'])('rejects extra source member %s', async (name) => {
  const skill = await fixture()
  const path = join(dirname(skill), 'scripts/order_adapter', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'untrusted')
  await expect(readNativeH3OrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it.each(['privatePath', 'dependencies', 'scripts'])('rejects package manifest field %s', async (field) => {
  const skill = await fixture()
  const path = join(dirname(skill), 'scripts/order_adapter/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, canonicalOrderJson({ ...manifest, [field]: 'forbidden' }))
  await expect(readNativeH3OrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects a declaration/contract model mismatch and a symlinked source member', async () => {
  const skill = await fixture()
  const path = join(dirname(skill), 'scripts/order_adapter/task-definition.json')
  const definition = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, canonicalOrderJson({ ...definition, nativeBinding: { ...binding, modelSha256: 'd'.repeat(64) } }))
  await expect(readNativeH3OrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  const next = await fixture()
  const member = join(dirname(next), 'scripts/order_adapter/package.json')
  const outside = join(dirname(next), 'other.json')
  await writeFile(outside, await readFile(member))
  await rm(member)
  await symlink(outside, member)
  await expect(readNativeH3OrderSource(next)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects noncanonical duplicate keys, changed archive source and an executable inventory', async () => {
  const skill = await fixture()
  const source = await readNativeH3OrderSource(skill)
  await writeFile(join(source.root, 'package.json'), '{"name":"qianshou-a","name":"qianshou-b","type":"module","version":"0.0.1"}')
  await expect(readNativeH3OrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await expect(buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`, NATIVE_BINDING_INVENTORY_ALGORITHM))
    .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  expect(() => { validateOrderSourceInventory(NATIVE_BINDING_INVENTORY_ALGORITHM,
    [{ path: 'src/adapter.mjs', sizeBytes: 2, sha256: 'a'.repeat(64) }]) }).toThrow()
})

it('saves a real explicit V2 five-file template and validates its same four-file source without private device identity', async () => {
  const { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, nativeH3PublicBindingDigest }
    = await import('../../compute-core/src/native-h3-binding.ts')
  const v2 = { schema: 'qianshou.native-h3-execution-binding.v2' as const,
    runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: 'b'.repeat(64),
    modelSha256: 'c'.repeat(64), firstFrameSha256: 'd'.repeat(64) }
  const root = await mkdtemp(join(tmpdir(), 'qs-h3-v2-template-')); roots.push(root)
  const files = nativeH3AuthoringTemplate(v2, 'native-h3-v2-test', 'qianshou_h3_shared_v2').files
  expect(Object.keys(files)).toHaveLength(5)
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), bytes)
  }
  const source = await readNativeH3OrderSource(join(root, 'SKILL.md'))
  expect(source.declaration.contractVersion).toBe('v2')
  expect(source.taskDefinition.schema).toBe('qianshou.reviewed-task-definition.v2')
  expect(source.taskDefinition.nativeBinding).toEqual(v2)
  expect(source.taskDefinition.inputSchema).toMatchObject({ type: 'string', title: '描述你想生成的视频', contentMediaType: 'text/plain' })
  expect(source.files.every(file =>
    !/localOwnerConfigDigest|device_binding_revision|config_digest|ownerConfigDigest/u.test(file.bytes.toString()))).toBe(true)
  const prepared = await prepareRegisteredOrderAdapter(join(root, 'SKILL.md'))
  expect(prepared.contractVersion).toBe('v2')
  const good = { taskType: prepared.taskType, artifactDigest: `sha256:${source.digest}`,
    packageDigest: nativeH3PublicBindingDigest(v2), inventoryAlgorithm: NATIVE_BINDING_INVENTORY_ALGORITHM,
    localVerified: true, platformReady: false }
  expect(await prepared.verifyLocal({ selectNativeH3AuthorBinding: async () => good })).toMatchObject({ platformReady: false })
  await expect(prepared.verifyLocal({ selectNativeH3AuthorBinding: async () => ({ ...good, packageDigest: binding.ownerConfigDigest }) }))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})
