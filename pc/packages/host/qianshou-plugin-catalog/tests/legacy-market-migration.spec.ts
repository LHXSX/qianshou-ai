import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { readDeclaredCapabilityIds } from '../../node-contributor/src/market-declarations.ts'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { readMarketInstallFile, writeMarketInstall } from '../src/market.ts'
import type { MarketInstallRecord } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function declaration(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-windows-market-'))
  roots.push(root)
  const path = join(root, 'qianshou', 'market-installed.json')
  await mkdir(dirname(path), { recursive: true })
  return path
}

function config(path: string): Config {
  return {
    registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
    apiBaseUrl: '', installHome: dirname(dirname(path)), publisherKeys: {},
  }
}

function oldEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qianshou.article', version: '1.0.0', caps: ['text.transform'],
    declaredAt: 1_779_984_000_000, visibility: 'public', invitees: [], ...overrides,
  }
}

function newRow(id = 'qianshou.new'): MarketInstallRecord {
  return {
    id, capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z',
    visibility: 'draft', inviteAccountIds: [],
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

it('shows old public capability as a draft, never advertises it, and refuses stale publication', async () => {
  const path = await declaration()
  const original = Buffer.from(`${JSON.stringify({ version: 1, entries: [oldEntry()] }, null, 2)}\n`)
  await writeFile(path, original)
  const ctx = new Context()
  try {
    await ctx.plugin(QianshouPluginCatalog, config(path))
    expect((await ctx.qianshouPluginCatalog.installed()).records).toMatchObject([
      { id: 'qianshou.article', capabilityId: 'text.transform', version: '1.0.0', visibility: 'draft' },
    ])
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).capabilities[0]).toMatchObject({
      title: '文章', advertisable: false, record: { visibility: 'draft' },
    })
    expect(readDeclaredCapabilityIds(path)).toEqual([])
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'public', confirmPublic: true,
    })).rejects.toThrow('preflight-failed')
    expect(await readFile(path)).toEqual(original)
    expect(await readdir(dirname(path))).toEqual(['market-installed.json'])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('backs up exact Windows bytes and a receipt before preserving a legacy public row as draft', async () => {
  const path = await declaration()
  const original = Buffer.from(`{\n "version": 1, "entries": [${JSON.stringify(oldEntry())}]\n}\n`)
  await writeFile(path, original)
  if (process.platform !== 'win32') await chmod(path, 0o600)
  writeMarketInstall(path, newRow())
  const files = await readdir(dirname(path))
  const sourceHash = digest(original)
  const backupName = `market-installed.json.windows-v1-${sourceHash}.bak`
  const receiptName = files.find(name => name.endsWith('.receipt.json'))
  expect(files).toContain(backupName)
  expect(receiptName).toBeDefined()
  expect(await readFile(join(dirname(path), backupName))).toEqual(original)
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dirname(path), backupName))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dirname(path), receiptName!))).mode & 0o777).toBe(0o600)
  }
  const receipt = JSON.parse(await readFile(join(dirname(path), receiptName!), 'utf8')) as Record<string, unknown>
  expect(receipt).toMatchObject({
    schemaFrom: 'windows-entries-v1', schemaTo: 'installed-v1', status: 'prepared',
    backupFile: backupName, sourceSha256: sourceHash, sourceBytes: original.byteLength,
    records: 1, publicDemotedToDraft: 1,
  })
  const migrated = await readFile(path)
  expect(receipt.targetSha256).toBe(digest(migrated))
  expect(readMarketInstallFile(path)).toMatchObject([
    { id: 'qianshou.article', version: '1.0.0', visibility: 'draft' },
    { id: 'qianshou.new', version: '1', visibility: 'draft' },
  ])
  expect(readDeclaredCapabilityIds(path)).toEqual([])
})

it('refuses to replace a conflicting backup and leaves the Windows declaration intact', async () => {
  const path = await declaration()
  const original = Buffer.from(JSON.stringify({ version: 1, entries: [oldEntry()] }))
  await writeFile(path, original)
  const backup = `${path}.windows-v1-${digest(original)}.bak`
  const unrelated = Buffer.from('another backup')
  await writeFile(backup, unrelated)
  expect(() => writeMarketInstall(path, newRow())).toThrow('migration-protection-failed')
  expect(await readFile(path)).toEqual(original)
  expect(await readFile(backup)).toEqual(unrelated)
  expect((await readdir(dirname(path))).filter(name => name.endsWith('.receipt.json'))).toEqual([])
})

it.each([
  ['multiple capabilities', { version: 1, entries: [oldEntry({ caps: ['text.transform', 'image.generate'] })] }],
  ['unmappable invitee', { version: 1, entries: [oldEntry({ visibility: 'invite', invitees: ['alice'] })] }],
  ['unknown field', { version: 1, entries: [oldEntry({ workflow: 'unknown-to-Mac' })] }],
  ['bad shape', { version: 1, entries: 'not-an-array' }],
])('refuses to overwrite a Windows file with %s', async (_name, value) => {
  const path = await declaration()
  const original = Buffer.from(JSON.stringify(value))
  await writeFile(path, original)
  expect(() => readMarketInstallFile(path)).toThrow('declaration-unreadable')
  expect(() => writeMarketInstall(path, newRow())).toThrow('declaration-unreadable')
  expect(await readFile(path)).toEqual(original)
  expect(await readdir(dirname(path))).toEqual(['market-installed.json'])
})

it('refuses malformed JSON and leaves its exact bytes untouched', async () => {
  const path = await declaration()
  const original = Buffer.from('{"version":1,"entries":[')
  await writeFile(path, original)
  expect(() => writeMarketInstall(path, newRow())).toThrow('declaration-unreadable')
  expect(await readFile(path)).toEqual(original)
  expect(await readdir(dirname(path))).toEqual(['market-installed.json'])
})
