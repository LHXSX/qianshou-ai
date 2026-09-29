/** A damaged or foreign identity file is refused, so this PC never silently becomes a new one at the relay. */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileSyncFailure } from '../src/failure.ts'
import { PC_ID_FILE_VERSION, resolvePcId } from '../src/pc-id.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function identityPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-pc-id-'))
  dirs.push(dir)
  return join(dir, 'nested', 'pc-id.json')
}

/** Assert a refusal names one stable wire code. */
async function refuses(operation: () => Promise<unknown>, kind: string): Promise<void> {
  try { await operation(); expect.unreachable('expected a refusal') }
  catch (error) {
    expect(error).toBeInstanceOf(MobileSyncFailure)
    expect((error as MobileSyncFailure).kind).toBe(kind)
  }
}

describe('a configured identity', () => {
  it('wins over any persisted file and is reported as configured', async () => {
    const path = await identityPath()
    await expect(resolvePcId('owner-chosen-pc', path)).resolves.toEqual({ pcId: 'owner-chosen-pc', source: 'configured' })
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('refuses a configured value that cannot be an identifier', async () => {
    const path = await identityPath()
    await refuses(() => resolvePcId('   ', path), 'PC_ID_INVALID')
    await refuses(() => resolvePcId('pc\u0001id', path), 'PC_ID_INVALID')
  })
})

describe('a generated identity', () => {
  it('creates one UUID, persists it owner-only, and reads the same one back afterwards', async () => {
    const path = await identityPath()
    const first = await resolvePcId('', path)
    expect(first.source).toBe('generated')
    expect(first.pcId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: PC_ID_FILE_VERSION, pcId: first.pcId })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(resolvePcId('', path)).resolves.toEqual({ pcId: first.pcId, source: 'persisted' })
  })

  it('creates the private directory it needs', async () => {
    const path = await identityPath()
    await resolvePcId('', path)
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
  })
})

describe('a damaged identity file', () => {
  it.each([
    ['text that is not JSON', '{'],
    ['another file version', JSON.stringify({ version: PC_ID_FILE_VERSION + 1, pcId: '11111111-1111-1111-1111-111111111111' })],
    ['a missing version', JSON.stringify({ pcId: '11111111-1111-1111-1111-111111111111' })],
    ['an id that is not a UUID', JSON.stringify({ version: PC_ID_FILE_VERSION, pcId: 'not-a-uuid' })],
    ['an uppercase UUID', JSON.stringify({ version: PC_ID_FILE_VERSION, pcId: '11111111-1111-1111-1111-11111111111A' })],
    ['a JSON array', '[]'],
  ])('refuses %s instead of generating a new identity', async (_case, content) => {
    const path = await identityPath()
    await resolvePcId('', path)
    await writeFile(path, content)
    await refuses(() => resolvePcId('', path), 'PC_ID_INVALID')
  })

  it('refuses a path it cannot read at all rather than generating a new identity for this PC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-pc-id-'))
    dirs.push(dir)
    await refuses(() => resolvePcId('', dir), 'PC_ID_INVALID')
  })

  it('reports an identity it cannot persist as a storage failure, leaving no partial file behind', async () => {
    // The name fits the filesystem, its private temporary sibling does not, so the atomic write fails before any rename.
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-pc-id-'))
    dirs.push(dir)
    const path = join(dir, `${'n'.repeat(250)}.json`)
    await refuses(() => resolvePcId('', path), 'STORAGE_FAILED')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('refuses a file larger than the bound without parsing it', async () => {
    const path = await identityPath()
    await resolvePcId('', path)
    await writeFile(path, JSON.stringify({ version: PC_ID_FILE_VERSION, pcId: '11111111-1111-1111-1111-111111111111', pad: 'x'.repeat(4096) }))
    await refuses(() => resolvePcId('', path), 'PC_ID_INVALID')
  })
})
