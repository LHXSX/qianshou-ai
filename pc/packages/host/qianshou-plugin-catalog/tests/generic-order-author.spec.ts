import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Catalog, { type Config } from '../src/index.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { runGenericOrderChallenge } from '../src/generic-order-adapter.ts'
import { prepareRegisteredOrderAdapter } from '../src/registered-order-adapters.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { normalizeGenericOrderSourceJson } from '../src/order-source-json.ts'
import { canonicalSourceJson } from '../src/order-source-json.ts'
import { signAndRecordOrderAuthorManifest } from '../src/order-publisher-identity.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(options: { oneSample?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-generic-author-'))
  homes.push(home)
  const directory = join(home, 'text-reverse')
  await cp(fileURLToPath(new URL('../examples/text-reverse-skill/', import.meta.url)), directory,
    { recursive: true, errorOnExist: true })
  const skill = join(directory, 'SKILL.md')
  const root = join(directory, 'scripts', 'order_adapter')
  if (!options.oneSample) {
    const declarationPath = join(root, 'local-adapter.json')
    const declaration = JSON.parse(await readFile(declarationPath, 'utf8')) as Record<string, unknown>
    await writeFile(join(root, 'samples/second.input.json'), JSON.stringify({ text: '你好' }))
    await writeFile(join(root, 'samples/second.expected.json'), JSON.stringify({ text: '好你' }))
    await writeFile(declarationPath, JSON.stringify({ ...declaration, selfTests: [
      ...(declaration.selfTests as unknown[]),
      { input: 'samples/second.input.json', expected: 'samples/second.expected.json' },
    ] }))
    await normalizeGenericOrderSourceJson(skill)
  }
  return { skill, root, home }
}

it('packs a non-SVG installed skill as the exact v5 sorted source archive', async () => {
  const { skill, root } = await fixture()
  const source = await readGenericOrderSource(skill)
  expect(source.declaration.taskType).toBe('text_reverse_v1')
  expect(source.taskDefinition).toMatchObject({ schema: 'qianshou.reviewed-task-definition.v1',
    taskType: 'text_reverse_v1', inputContract: 'inline-text-reverse.v1',
    resultStrategy: 'inline-text-reverse.v1' })
  expect(source.files.map(file => file.path)).toEqual([...source.files.map(file => file.path)].sort())
  const prepared = await prepareRegisteredOrderAdapter(skill)
  expect(prepared.inventoryAlgorithm).toBe('qianshou.source-package.v1')
  if (process.platform === 'darwin') {
    expect(await prepared.verifyLocal(undefined)).toMatchObject({ taskType: 'text_reverse_v1',
      localVerified: true, platformReady: false, artifactDigest: `sha256:${source.digest}` })
  }
  const archive = await buildCanonicalOrderArchive(root, `sha256:${source.digest}`, prepared.inventoryAlgorithm)
  expect(archive.taskType).toBe('text_reverse_v1')
  expect(archive.capabilityId).toBe('text.transform')
  expect(archive.inventoryAlgorithm).toBe('qianshou.source-package.v1')
  expect(archive.files.map(file => file.path)).toEqual(source.files.map(file => file.path))
  expect(archive.sizeBytes).toBe(archive.bytes.length)
})

it('rejects one-example generic skills before reaching the platform', async () => {
  const { skill, home } = await fixture({ oneSample: true })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {} } satisfies Config)
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{
    name: 'text-reverse', source: 'user-agents', path: skill,
  }] }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'local-test-token' })
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  try {
    await expect(ctx.qianshouPluginCatalog.submitInstalledOrderSkill({
      source: 'user-agents', name: 'text-reverse', displayName: '文字反转',
      purpose: '反转文字', configuration: '', priceYuan: '0.50',
    })).rejects.toMatchObject({ code: 'order-review-samples-insufficient' })
    expect(send).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('prepares and executes a newly authored task type with the generic runner', async () => {
  if (process.platform !== 'darwin') return
  const { skill, root } = await fixture()
  const declarationPath = join(root, 'local-adapter.json')
  const definitionPath = join(root, 'task-definition.json')
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8')) as Record<string, unknown>
  const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>
  const taskType = 'sample_character_count_v1'
  await writeFile(declarationPath, JSON.stringify({ ...declaration,
    taskType, capabilityId: 'text.count' }))
  await writeFile(definitionPath, JSON.stringify({ ...definition,
    taskType, capabilityId: 'text.count', inputContract: 'inline-json-bounded.v1',
    resultStrategy: 'buyer-confirmed-structure.v1',
    outputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'], additionalProperties: false } }))
  await writeFile(join(root, 'src/adapter.mjs'), `let raw = ''
for await (const chunk of process.stdin) raw += chunk
const { text } = JSON.parse(raw)
if (typeof text !== 'string') throw new TypeError('text must be a string')
process.stdout.write(JSON.stringify({ count: [...text].length }))
`)
  await writeFile(join(root, 'samples/reverse.expected.json'), JSON.stringify({ count: 3 }))
  await writeFile(join(root, 'samples/second.expected.json'), JSON.stringify({ count: 2 }))
  await normalizeGenericOrderSourceJson(skill)

  const prepared = await prepareRegisteredOrderAdapter(skill)
  expect(prepared).toMatchObject({ taskType, capabilityId: 'text.count',
    outputKind: 'inline_json', category: 'text' })
  expect(await prepared.verifyLocal(undefined)).toMatchObject({ taskType, localVerified: true,
    platformReady: false })
  const result = await runGenericOrderChallenge(await readGenericOrderSource(skill),
    Buffer.from(JSON.stringify({ text: '千手AI' })))
  expect(result.output).toEqual({ count: 4 })
  expect(result.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
})

it('normalizes every v5 JSON member before self-test and rejects duplicate keys', async () => {
  const { skill, root } = await fixture()
  for (const name of ['package.json', 'local-adapter.json', 'samples/reverse.input.json',
    'samples/reverse.expected.json', 'task-definition.json']) {
    const path = join(root, name)
    await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2) + '\n')
  }
  const before = await readGenericOrderSource(skill, { forNormalization: true })
  await expect(buildCanonicalOrderArchive(root, `sha256:${before.digest}`, before.inventoryAlgorithm))
    .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await expect(normalizeGenericOrderSourceJson(skill)).resolves.toBe(true)
  const after = await readGenericOrderSource(skill)
  expect(after.digest).not.toBe(before.digest)
  const archive = await buildCanonicalOrderArchive(root, `sha256:${after.digest}`, after.inventoryAlgorithm)
  expect(archive.files.filter(file => file.path.endsWith('.json'))).toHaveLength(7)
  const prepared = await prepareRegisteredOrderAdapter(skill)
  if (process.platform === 'darwin') await expect(prepared.verifyLocal(undefined)).resolves.toMatchObject({
    localVerified: true, artifactDigest: `sha256:${after.digest}` })
  await writeFile(join(root, 'package.json'),
    '{"name":"text-reverse-order-adapter","name":"text-reverse-order-adapter","type":"module","version":"0.1.0"}')
  await expect(normalizeGenericOrderSourceJson(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('uses the independent Python issuer JSON number spelling for bounded decimals', () => {
  expect(canonicalSourceJson(Buffer.from('{"标题":"千手","value":0.00001,"half":0.5}')).toString())
    .toBe('{"half":0.5,"value":1e-05,"标题":"千手"}')
  expect(() => canonicalSourceJson(Buffer.from('{"unsafe":9007199254740993}')))
    .toThrowError()
})

it('rejects changed source, missing example, and symlink before a publication is attempted', async () => {
  const { skill, root } = await fixture()
  const source = await readGenericOrderSource(skill)
  await writeFile(join(root, 'src/adapter.mjs'), 'process.stdout.write("{}")\n')
  await expect(buildCanonicalOrderArchive(root, `sha256:${source.digest}`, 'qianshou.source-package.v1'))
    .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await rm(join(root, 'samples/reverse.expected.json'))
  await expect(prepareRegisteredOrderAdapter(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await symlink(join(root, 'src/adapter.mjs'), join(root, 'src/alias.mjs'))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects a lockfile that could fetch dependencies after author self-test', async () => {
  const { skill, root } = await fixture()
  await writeFile(join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      unreviewed: 1.0.0\n")
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await expect(prepareRegisteredOrderAdapter(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects a changed or noncanonical machine task contract before publication', async () => {
  const { skill, root } = await fixture()
  const path = join(root, 'task-definition.json')
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...original, taskType: 'other_task_v1' }))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  await writeFile(path, JSON.stringify(original, null, 2))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('keeps a bounded buyer-confirmed output shape inside the exact v5 source identity', async () => {
  const { skill, root } = await fixture()
  const path = join(root, 'task-definition.json')
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const outputSchema = { type: 'object', properties: { text: { type: 'string', maxLength: 16384 } },
    required: ['text'], additionalProperties: false }
  const definition = { ...original, inputContract: 'inline-json-bounded.v1',
    resultStrategy: 'buyer-confirmed-structure.v1', outputSchema }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') {
      const row = value as Record<string, unknown>
      return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  await writeFile(path, canonical(definition))
  const source = await readGenericOrderSource(skill)
  expect(source.taskDefinition?.outputSchema).toEqual(outputSchema)
  const archive = await buildCanonicalOrderArchive(root, `sha256:${source.digest}`, source.inventoryAlgorithm)
  expect(archive.files.find(file => file.path === 'task-definition.json')?.sha256)
    .toBe(createHash('sha256').update(canonical(definition)).digest('hex'))
  await writeFile(path, canonical({ ...definition, outputSchema: { ...outputSchema,
    properties: { text: { type: 'string', pattern: '.*' } } } }))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects local sample mismatch without calling a platform endpoint', async () => {
  if (process.platform !== 'darwin') return
  const { skill, root } = await fixture()
  await writeFile(join(root, 'samples/reverse.expected.json'), JSON.stringify({ text: 'wrong' }))
  const prepared = await prepareRegisteredOrderAdapter(skill)
  await expect(prepared.verifyLocal(undefined)).rejects.toMatchObject({ code: 'order-local-verification-failed' })
  expect(JSON.parse(await readFile(join(root, 'local-adapter.json'), 'utf8'))).toMatchObject({ taskType: 'text_reverse_v1' })
})

it('quotes a signed generic source against Shanghai and binds the preview to its exact bytes', async () => {
  const { skill, root } = await fixture()
  const prepared = await prepareRegisteredOrderAdapter(skill)
  const ctx = new Context()
  contexts.push(ctx)
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: root, publisherKeys: {},
    coreOrigin: 'http://127.0.0.1:47123' }
  await ctx.plugin(Catalog, config)
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{
    name: 'text-reverse', source: 'user-agents', path: skill,
  }] }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'author-test-token' })
  const originalFetch = globalThis.fetch
  const send = vi.fn(async (_url: URL, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>
    expect(body).toEqual({ task_type: prepared.taskType, task_definition: prepared.taskDefinition })
    return Response.json({ pricing_mode: 'platform', currency: 'CNY', price_yuan: '1.25',
      settings_version: 4, task_definition_sha256: prepared.taskDefinitionSha256,
      input_contract: prepared.taskDefinition?.inputContract,
      result_strategy: prepared.taskDefinition?.resultStrategy, output_kind: prepared.outputKind })
  })
  globalThis.fetch = send as unknown as typeof fetch
  try {
    expect(await ctx.qianshouPluginCatalog.localOrderSkillEligibility()).toEqual({ items: [{
      source: 'user-agents', name: 'text-reverse', path: skill, taskType: prepared.taskType,
      artifactDigest: `sha256:${prepared.digest}`, platformPriced: true }] })
    await expect(ctx.qianshouPluginCatalog.previewInstalledOrderSkillPrice({
      source: 'user-agents', name: 'text-reverse' })).resolves.toEqual({
      taskType: prepared.taskType, artifactDigest: `sha256:${prepared.digest}`,
      priceYuan: '1.25', settingsVersion: 4,
      taskDefinitionSha256: prepared.taskDefinitionSha256 })
    expect(send).toHaveBeenCalledOnce()
    await writeFile(join(root, 'src/adapter.mjs'), 'process.stdout.write("{}")\n')
    await expect(ctx.qianshouPluginCatalog.submitInstalledOrderSkill({
      source: 'user-agents', name: 'text-reverse', displayName: '文字反转',
      purpose: '反转文本', configuration: '', priceYuan: '1.25',
      expectedArtifactDigest: `sha256:${prepared.digest}`,
      ...(prepared.taskDefinitionSha256 == null ? {} : {
        expectedTaskDefinitionSha256: prepared.taskDefinitionSha256,
      }),
    })).rejects.toMatchObject({ code: 'order-local-verification-failed' })
    expect(send).toHaveBeenCalledOnce()
  } finally { globalThis.fetch = originalFetch }
})

it('one-click price preview normalizes installed JSON before binding a publication digest', async () => {
  const { skill, root } = await fixture()
  const path = join(root, 'package.json')
  await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2) + '\n')
  const before = await readGenericOrderSource(skill)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: root, publisherKeys: {},
    coreOrigin: 'http://127.0.0.1:47123' } satisfies Config)
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{
    name: 'text-reverse', source: 'user-agents', path: skill }] }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'author-test-token' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ pricing_mode: 'platform', currency: 'CNY',
    price_yuan: '0.50', settings_version: 4,
    task_definition_sha256: (await prepareRegisteredOrderAdapter(skill)).taskDefinitionSha256,
    input_contract: 'inline-text-reverse.v1', result_strategy: 'inline-text-reverse.v1',
    output_kind: 'inline_json' })
  try {
    const quoted = await ctx.qianshouPluginCatalog.previewInstalledOrderSkillPrice({
      source: 'user-agents', name: 'text-reverse' })
    const after = await readGenericOrderSource(skill)
    expect(after.digest).not.toBe(before.digest)
    expect(quoted.artifactDigest).toBe(`sha256:${after.digest}`)
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(false)
  } finally { globalThis.fetch = originalFetch }
})

it('submits a non-SVG contract after local execution and respects platform rejection', async () => {
  if (process.platform !== 'darwin') return
  const { skill, root } = await fixture()
  const definitionPath = join(root, 'task-definition.json')
  const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>
  await writeFile(definitionPath, canonicalSourceJson(Buffer.from(JSON.stringify({ ...definition,
    title: '执行器默认名', description: '执行器默认介绍' }))))
  const ctx = new Context()
  contexts.push(ctx)
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: root, publisherKeys: {},
    coreOrigin: 'http://127.0.0.1:47123' }
  await ctx.plugin(Catalog, config)
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{
    name: 'text-reverse', source: 'user-agents', path: skill,
  }] }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'author-test-token' })
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    return new Response('{}', { status: 400 })
  }
  try {
    await expect(ctx.qianshouPluginCatalog.submitInstalledOrderSkill({
      source: 'user-agents', name: 'text-reverse', displayName: '文字反转',
      purpose: '按 Unicode 字符反转文本', configuration: '', priceYuan: '1.00',
    })).rejects.toMatchObject({ code: 'order-platform-contract' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ task_type: 'text_reverse_v1', capability_id: 'text.transform',
      name: '文字反转', description: '按 Unicode 字符反转文本',
      input_kinds: ['inline'], output_kind: 'inline_json', category: 'text', price_yuan: '1.00',
      configuration: '', task_definition: { taskType: 'text_reverse_v1',
        title: '执行器默认名', description: '执行器默认介绍',
        inputContract: 'inline-text-reverse.v1', resultStrategy: 'inline-text-reverse.v1' } })
  } finally { globalThis.fetch = originalFetch }
})

it('signs generic task metadata and sorted v5 files rather than fixed SVG names', async () => {
  const { skill, root, home } = await fixture()
  const source = await readGenericOrderSource(skill)
  const archive = await buildCanonicalOrderArchive(root, `sha256:${source.digest}`, 'qianshou.source-package.v1')
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  let payload: Record<string, unknown> | undefined
  const send = vi.fn(async (url: URL, options: RequestInit) => {
    if (url.pathname.endsWith('/challenge')) return Response.json({
      schema: 'qianshou.order-adapter-key-enrollment.v1', owner_id: 7,
      challenge_id: 'b9418e38-b3a5-5722-8005-cc7afbe2a21b', nonce: 'n'.repeat(43),
      expires_at: Math.floor(Date.now() / 1000) + 200,
    })
    const body = JSON.parse(String(options.body)) as Record<string, any>
    if (url.pathname.endsWith('/task-adapter-publisher-keys')) return Response.json({
      schema: 'qianshou.order-adapter-publisher-key.v1', owner_id: 7,
      key_id: body.key_id, public_key: body.public_key, status: 'active',
    })
    payload = body.author_manifest.payload
    return Response.json({ publication_id: publicationId, owner_id: 7,
      key_id: body.author_manifest.key_id, status: 'recorded' })
  })
  await signAndRecordOrderAuthorManifest({ origin: 'http://127.0.0.1:47123',
    token: 'isolated-test-token', publicationId, ownerId: 7,
    packageDigest: `sha256:${source.digest}`, version: source.version, archive,
    profileDir: home, fetch: send as typeof fetch })
  expect(payload).toMatchObject({ task_type: 'text_reverse_v1', capability_id: 'text.transform',
    inventory_algorithm: 'qianshou.source-package.v1', files: archive.files })
  expect(send).toHaveBeenCalledTimes(3)
})
