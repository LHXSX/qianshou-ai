/** Real Loader and HTTP recovery for ordinary packages, without running their scripts. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import Catalog from '../src/index.ts'
import { captureOrdinarySkill } from '../src/ordinary-skill-archive.ts'

it('submits one ordinary snapshot through Loader and reconciles its original UUID after restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ordinary-loader-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const skill = join(home, 'skills', 'sample'); await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# 名称\nRead the provided text.\n')
  await writeFile(join(skill, '.env'), 'secret-hidden-value')
  await writeFile(join(skill, 'credentials.json'), 'secret-credential-value')
  await writeFile(join(skill, 'script.js'), 'throw new Error("must not execute")')
  const archive = await captureOrdinarySkill(join(skill, 'SKILL.md'))
  expect(archive.files.map(f => f.path)).toEqual(['SKILL.md', 'script.js'])
  let posts = 0; let reads = 0; let catalogReads = 0; let accountId = '167'; let receipt: Record<string, unknown> | null = null
  const token = 'fixture-ordinary-account-token'
  const server = createServer((request, response) => {
    void (async () => {
      expect(request.url).toBe('/qianshou-market/skills')
      if (request.method === 'GET') {
        expect(request.headers.authorization).toBeUndefined()
        catalogReads++; response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, kind: 'ordinary_skill', purchase_available: false, listings: [], nextCursor: null }))
        return
      }
      expect(request.headers.authorization).toBe(`Bearer ${token}`)
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      if (body.action === 'submit') {
        posts++
        expect(Buffer.from(body.archiveBase64 as string, 'base64')).toEqual(archive.bytes)
        receipt = { ...body, accountId, submissionId: randomUUID(), kind: 'ordinary_skill',
          currency: 'CNY', packageSha256: archive.packageSha256, packageBytes: archive.packageBytes,
          unpackedTreeSha256: archive.unpackedTreeSha256, skillMdSha256: archive.skillMdSha256,
          skillMdPath: 'SKILL.md', files: archive.files, submittedAt: Date.now(), publisher_kind: 'user',
          review: { status: 'pending' }, purchase_available: false, installable: false }
        response.destroy(); return
      }
      expect(body).toEqual({ action: 'mine', requestId: receipt?.requestId })
      reads++; response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, submissions: [receipt], nextCursor: null }))
    })().catch((error: unknown) => { response.writeHead(500).end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture port')
  const dir = join(home, 'profiles', 'test'); initProfile(dir, ['core'])
  const anchor = join(home, 'package.json'); await writeFile(anchor, '{"name":"ordinary-host","dependencies":{}}')
  const core = join(dir, 'node_modules', 'core'); await mkdir(core, { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, overlays: [],
    telemetryDisabledEnv: undefined, packageManager: { command: process.execPath, args: [], env: {} } }
  const open = async (ordinarySkillsApiOrigin = `http://127.0.0.1:${address.port}`) => {
    await writeFile(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'market', name: 'cordis:market',
      config: { connection: 'shipped', apiBaseUrl: '', ordinarySkillsApiOrigin, installHome: home,
        registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, publisherKeys: {}, operatorKeys: {} } }] }]))
    return boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (preparing) => {
      preparing.provide('profileContext', profile)
      preparing.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      preparing.provide('qianshouAccount' as never, { state: async () => ({ phase: 'authenticated', account: { id: accountId } }) } as never)
      preparing.provide('accountSession' as never, { ensureAccessToken: async () => token } as never)
      preparing.provide('qianshouSkillImport' as never, { listLocal: async () => ({ skills: [{ source: 'user-dsh',
        name: 'sample', path: join(skill, 'SKILL.md'), displayName: '样例', description: '说明' }] }) } as never)
      Object.assign(preparing.loader.builtins, { market: Catalog })
    })
  }
  const input = { requestId: randomUUID(), source: 'user-dsh' as const, name: 'sample',
    title: '样例', summary: '说明', priceYuan: '2.50' }
  let ctx = await open()
  try {
    await expect(ctx.qianshouPluginCatalog.ordinarySkillCatalog()).resolves.toEqual({ listings: [] })
    expect(catalogReads).toBe(1)
    await expect(ctx.qianshouPluginCatalog.submitOrdinarySkill({ ...input, priceYuan: '' })).rejects.toThrow('TERMS_INVALID')
    const [a, b] = await Promise.all([ctx.qianshouPluginCatalog.submitOrdinarySkill(input),
      ctx.qianshouPluginCatalog.submitOrdinarySkill(input)])
    expect(a).toEqual(b); expect(a.state).toBe('unknown'); expect(posts).toBe(1)
    await expect(ctx.qianshouPluginCatalog.submitOrdinarySkill({ ...input, priceYuan: '3' })).rejects.toThrow('REQUEST_CONFLICT')
    const saved = await readFile(join(home, 'qianshou', 'ordinary-skill-publications.json'), 'utf8')
    expect(saved).not.toContain(token); expect(saved).not.toContain('archiveBase64'); expect(saved).not.toContain(skill)
    await ctx.fiber.dispose(); await writeFile(join(skill, 'SKILL.md'), '# Changed after original capture')
    ctx = await open()
    expect(await ctx.qianshouPluginCatalog.submitOrdinarySkill(input)).toMatchObject({ state: 'submitted',
      submission: { priceYuan: '2.50', publisherKind: 'user', purchaseAvailable: false, installable: false } })
    expect(posts).toBe(1); expect(reads).toBe(1)
    accountId = '168'
    expect(await ctx.qianshouPluginCatalog.ordinarySkillMine()).toEqual({ accountId: '168', submissions: [] })
    expect(reads).toBe(1)
    await ctx.fiber.dispose(); ctx = await open('')
    await expect(ctx.qianshouPluginCatalog.ordinarySkillCatalog()).rejects.toThrow('ORDINARY_SKILL_UNAVAILABLE')
    await expect(ctx.qianshouPluginCatalog.submitOrdinarySkill(input)).rejects.toThrow('ORDINARY_SKILL_UNAVAILABLE')
    expect(catalogReads).toBe(1); expect(posts).toBe(1); expect(reads).toBe(1)
  } finally { await ctx.fiber.dispose() }
})

it('defaults ordinary discovery to its official origin while retaining shipped adapter discovery', () => {
  const defaults = Catalog.Config()
  expect(defaults.connection).toBe('shipped')
  expect(defaults.apiBaseUrl).toBe('')
  expect(defaults.ordinarySkillsApiOrigin).toBe('https://app.qianshousuanli.com')
  expect(Catalog.Config({ ...defaults, ordinarySkillsApiOrigin: '' }).ordinarySkillsApiOrigin).toBe('')
})

it('refuses links and a second SKILL.md without executing any file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ordinary-path-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'SKILL.md'), '# Ordinary')
  await symlink(join(home, 'SKILL.md'), join(home, 'linked'))
  await expect(captureOrdinarySkill(join(home, 'SKILL.md'))).rejects.toThrow('PACKAGE_INVALID')
  await rm(join(home, 'linked')); await mkdir(join(home, 'other')); await writeFile(join(home, 'other', 'SKILL.md'), '# Nested')
  await expect(captureOrdinarySkill(join(home, 'SKILL.md'))).rejects.toThrow('PACKAGE_INVALID')
})
