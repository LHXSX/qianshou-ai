import { createHash } from 'node:crypto'
import { readFile, readdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { CSV_SEED_IDENTITY, executeOfficialCsvProfile, inspectOfficialCsvSeedArchive,
  installPrivateOfficialCsvSeed, runPrivateOfficialCsvSeed } from '../src/official-seed-csv.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'seed', 'csv-profile')
const artifact = join(root, 'qianshou.csv-profile-1.0.0.qspkg')
const signal = new AbortController().signal
async function privateDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-csv-seed-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

it('ships a fixed five-file reviewed-format package and executes its real sample', async () => {
  const bytes = await readFile(artifact)
  expect(bytes.length).toBe(CSV_SEED_IDENTITY.packageBytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(CSV_SEED_IDENTITY.packageSha256)
  const dir = await privateDirectory()
  const staged = join(dir, 'staged.qspkg')
  await writeFile(staged, bytes, { mode: 0o600 })
  expect(await inspectOfficialCsvSeedArchive(staged, signal)).toMatchObject({
    samplePassed: true, dispatchable: false, identity: { operationId: 'csv.profile' },
  })
  const input = JSON.parse(await readFile(join(root, 'basic-input.json'), 'utf8')) as unknown
  const output = JSON.parse(await readFile(join(root, 'basic-output.json'), 'utf8')) as unknown
  expect(executeOfficialCsvProfile(input)).toEqual(output)
})

it('performs an owner-approved private install, rechecks package, and profiles a real CSV', async () => {
  const dir = await privateDirectory()
  const approvals: string[] = []
  const installed = await installPrivateOfficialCsvSeed({ sourceArchivePath: artifact,
    privateDir: dir, signal, approveOwner: async sha => { approvals.push(sha); return true } })
  expect(approvals).toEqual([CSV_SEED_IDENTITY.packageSha256])
  expect(installed).toMatchObject({ scope: 'private-local', dispatchable: false, samplePassed: true })
  const result = await runPrivateOfficialCsvSeed(dir,
    { csv: '城市;人数;备注\r\n上海;3;"南区;北区"\r\n广州;2;"先试\n再改"\r\n', delimiter: ';', sampleRows: 2 }, signal)
  expect(result).toEqual({ rowCount: 2, columnCount: 3, delimiter: ';',
    columns: [
      { index: 0, name: '城市', nonEmptyCount: 2, emptyCount: 0, kind: 'text' },
      { index: 1, name: '人数', nonEmptyCount: 2, emptyCount: 0, kind: 'number' },
      { index: 2, name: '备注', nonEmptyCount: 2, emptyCount: 0, kind: 'text' },
    ], sampleRows: [['上海', '3', '南区;北区'], ['广州', '2', '先试\n再改']] })
  expect((await stat(installed.archivePath)).mode & 0o077).toBe(0)
  const record = JSON.parse(await readFile(join(dir, 'qianshou.csv-profile-1.0.0.json'), 'utf8')) as Record<string, unknown>
  expect(record).toMatchObject({ scope: 'private-local', dispatchable: false })
  await writeFile(installed.archivePath, 'tampered')
  await expect(runPrivateOfficialCsvSeed(dir, { csv: 'x\n1' }, signal)).rejects.toThrow('QIANSHOU_CSV_SEED_INVALID')
})

it('denies installation without current owner approval and leaves no receipt', async () => {
  const dir = await privateDirectory()
  await expect(installPrivateOfficialCsvSeed({ sourceArchivePath: artifact, privateDir: dir,
    signal, approveOwner: async () => false })).rejects.toThrow('QIANSHOU_CSV_SEED_INVALID')
  expect(await readdir(dir)).toEqual([])
})

it('rejects malformed, ragged and excessive CSV rather than silently guessing', () => {
  for (const csv of ['a,b\n1', 'a,b\n"unterminated,2', 'a,b\n"x"y,2', 'a,b\n1,2\0']) {
    expect(() => executeOfficialCsvProfile({ csv })).toThrow('QIANSHOU_CSV_SEED_INVALID')
  }
  expect(() => executeOfficialCsvProfile({ csv: 'a\n1', sampleRows: 100 })).toThrow('QIANSHOU_CSV_SEED_INVALID')
  expect(() => executeOfficialCsvProfile({ csv: 'a\n1', network: true })).toThrow('QIANSHOU_CSV_SEED_INVALID')
  expect(executeOfficialCsvProfile({ csv: '\ufeffa,b\n"x,y",42\n' }).sampleRows).toEqual([['x,y', '42']])
})
