import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import Catalog from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-local-trial-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const skillRoot = join(home, 'char-count')
  await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)),
    skillRoot, { recursive: true })
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {} })
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{ name: 'char-count',
    source: 'user-agents', path: join(skillRoot, 'SKILL.md') }] }) })
  return { catalog: ctx.qianshouPluginCatalog, skillRoot }
}

const request = { source: 'user-agents' as const, name: 'char-count', inputJson: '{"text":"千手🙂"}' }

it('tries exact scanned local source without login, native installation, network or publication', async () => {
  const { catalog } = await fixture()
  const send = vi.fn(() => { throw new Error('unexpected network') })
  vi.stubGlobal('fetch', send)
  try {
    const result = await catalog.tryInstalledOrderSkill(request)
    expect(JSON.parse(result.outputJson)).toEqual({ count: 3 })
    expect(result.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(send).not.toHaveBeenCalled()
    await expect(catalog.tryInstalledOrderSkill({ ...request, inputJson: '{"text":1}' }))
      .rejects.toMatchObject({ code: 'order-local-verification-failed' })
  } finally { vi.unstubAllGlobals() }
})

it('denies arbitrary paths, unknown source/name and oversized inputs before execution', async () => {
  const { catalog } = await fixture()
  for (const invalid of [{ ...request, name: '../char-count' },
    { ...request, name: 'unscanned' }, { ...request, inputJson: ' '.repeat(65 * 1024) },
    { ...request, path: '/etc/passwd' }]) {
    await expect(catalog.tryInstalledOrderSkill(invalid)).rejects.toBeDefined()
  }
})

it('rechecks self-tests so tampered source cannot silently run a different operation', async () => {
  const { catalog, skillRoot } = await fixture()
  await writeFile(join(skillRoot, 'scripts/order_adapter/src/adapter.quickjs.js'),
    'function run(){ return {count:999} }')
  await expect(catalog.tryInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it('reads the actual bounded input form without running or rewriting source, then executes the same digest', async () => {
  const { catalog, skillRoot } = await fixture()
  const definitionPath = join(skillRoot, 'scripts/order_adapter/task-definition.json')
  const original = await readFile(definitionPath)
  const originalFetch = globalThis.fetch
  const send = vi.fn(() => { throw new Error('unexpected network') })
  vi.stubGlobal('fetch', send)
  try {
    const form = await catalog.readInstalledOrderSkillTrial({ source: request.source, name: request.name })
    expect(form).toMatchObject({ schema: 'qianshou.local-skill-trial.v1', supportsLocalTrial: true,
      unavailableReason: null })
    expect(JSON.parse(form.inputSchemaJson!)).toMatchObject({ contentSchema: {
      required: ['text'], properties: { text: { title: '文字内容', type: 'string', minLength: 1, maxLength: 8000 } },
    } })
    expect(await readFile(definitionPath)).toEqual(original)
    const result = await catalog.tryInstalledOrderSkill({ ...request, expectedArtifactDigest: form.artifactDigest })
    expect(result.artifactDigest).toBe(form.artifactDigest)
    expect(JSON.parse(result.outputJson)).toEqual({ count: 3 })
    await expect(catalog.tryInstalledOrderSkill({ ...request, inputJson: '{"text":1}', expectedArtifactDigest: form.artifactDigest }))
      .rejects.toMatchObject({ code: 'order-local-verification-failed' })
    expect(send).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    expect(globalThis.fetch).toBe(originalFetch)
  }
})

it('refuses a form read to run against changed local source and does not normalize the changed bytes', async () => {
  const { catalog, skillRoot } = await fixture()
  const form = await catalog.readInstalledOrderSkillTrial({ source: request.source, name: request.name })
  const entry = join(skillRoot, 'scripts/order_adapter/src/adapter.quickjs.js')
  const updated = `${await readFile(entry, 'utf8')}\n// author saved a new version\n`
  await writeFile(entry, updated)
  await expect(catalog.tryInstalledOrderSkill({ ...request, expectedArtifactDigest: form.artifactDigest }))
    .rejects.toMatchObject({ code: 'order-publication-conflict' })
  expect(await readFile(entry, 'utf8')).toBe(updated)
})

it('returns a missing form faithfully and does not accept a caller-selected path for metadata', async () => {
  const { catalog, skillRoot } = await fixture()
  await rm(join(skillRoot, 'scripts/order_adapter/task-definition.json'))
  expect(await catalog.readInstalledOrderSkillTrial({ source: request.source, name: request.name }))
    .toMatchObject({ inputSchemaJson: null, supportsLocalTrial: true })
  for (const invalid of [{ source: request.source, name: '../char-count' },
    { source: request.source, name: 'unscanned' }, { source: request.source, name: request.name, path: '/etc/passwd' }]) {
    await expect(catalog.readInstalledOrderSkillTrial(invalid)).rejects.toBeDefined()
  }
})
