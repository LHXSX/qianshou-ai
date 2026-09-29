import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'

const config: Config = {
  registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
  apiBaseUrl: '', installHome: '', publisherKeys: {},
}

it('exposes private candidates read-only without treating them as market listings', async () => {
  const ctx = new Context()
  const candidate = { draftId: 'plugin_draft_1', packageName: 'qianshou-local-1', packagePath: '/private/candidate',
    toolName: 'qianshou_local_1', sourceDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
    displayName: '文字统计', description: '计算字数', operationTitle: '统计文字', preparedAt: 1,
    installableLocally: true as const, published: false as const, dispatchable: false as const }
  ctx.provide('computeCore', { listLocalPluginCandidates: async () => [candidate] })
  try {
    await ctx.plugin(QianshouPluginCatalog, config)
    expect(await ctx.qianshouPluginCatalog.localCandidates()).toEqual({ candidates: [candidate] })
    expect((await ctx.qianshouPluginCatalog.listings()).listings.some(item => item.id === candidate.packageName)).toBe(false)
  } finally { await ctx.fiber.dispose() }
})

it('compares installed bytes with the current candidate before executable activation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-candidate-check-'))
  const ctx = new Context()
  const files = { 'package.json': '{"name":"qianshou-local-test"}\n',
    'cordis.patch.yml': '[]\n', 'index.js': 'export function apply() {}\n' }
  const digest = createHash('sha256').update(Object.entries(files).map(([name, body]) => `${name}\0${body}`).join('\0')).digest('hex')
  const candidate = { draftId: 'plugin_draft_12345678-1234-1234-1234-123456789abc',
    packageName: 'qianshou-local-test', packagePath: join(home, 'candidate'), toolName: 'count',
    sourceDigest: 'a'.repeat(64), packageDigest: digest, displayName: '文字统计', description: '',
    operationTitle: '统计文字', preparedAt: 1, installableLocally: true as const,
    published: false as const, dispatchable: false as const }
  let installed = false
  ctx.provide('profileContext', { dir: join(home, 'profile') })
  ctx.provide('computeCore', { listLocalPluginCandidates: async () => [candidate] })
  ctx.provide('pluginManager', { listBundles: async () => installed ? [{ name: candidate.packageName, installed: true }] : [] })
  try {
    await mkdir(candidate.packagePath)
    for (const [name, body] of Object.entries(files)) await writeFile(join(candidate.packagePath, name), body)
    await ctx.plugin(QianshouPluginCatalog, config)
    const request = { draftId: candidate.draftId, packageDigest: digest }
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(request)).toMatchObject({
      matched: false, reason: 'adapter-missing' })
    const localRequest = { ...request, requireOrderAdapter: false as const }
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(localRequest)).toMatchObject({
      matched: false, reason: 'not-installed' })
    const packageDir = join(home, 'profile', 'node_modules', candidate.packageName)
    await mkdir(packageDir, { recursive: true })
    for (const [name, body] of Object.entries(files)) await writeFile(join(packageDir, name), body)
    installed = true
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(localRequest)).toMatchObject({
      matched: true, reason: 'matched' })
    await writeFile(join(packageDir, 'index.js'), 'export function apply() { throw Error("tampered") }\n')
    expect(await ctx.qianshouPluginCatalog.checkLocalCandidateInstall(localRequest)).toMatchObject({
      matched: false, reason: 'changed' })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
