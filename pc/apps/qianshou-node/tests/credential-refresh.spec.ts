import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshRotatedCredential, type RefreshTransport } from '../credential-refresh.ts'

const directories: string[] = []

afterEach(() => { directories.splice(0) })

async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-credential-'))
  directories.push(dir)
  return join(dir, 'account.json')
}

function pair(refreshToken: string): string {
  return JSON.stringify({ ok: true, tokens: { access_token: `access-${refreshToken}`, refresh_token: refreshToken } })
}

describe('rotated credential refresh', () => {
  it('sends one request when two callers refresh the same file together', async () => {
    const path = await store()
    await writeFile(path, `${JSON.stringify({ account: '111111', refreshToken: 'old' })}\n`)
    let calls = 0
    const transport: RefreshTransport = async body => {
      calls += 1
      expect(body.refresh_token).toBe('old')
      await new Promise(resolve => setTimeout(resolve, 20))
      return { status: 200, text: pair('new') }
    }
    const [first, second] = await Promise.all([
      refreshRotatedCredential({ storePath: path, transport }),
      refreshRotatedCredential({ storePath: path, transport }),
    ])
    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(first).toEqual({ state: 'rotated', accessToken: 'access-new', refreshToken: 'new' })
    const saved = JSON.parse(await readFile(path, 'utf8')) as { account: string; refreshToken: string }
    expect(saved.refreshToken).toBe('new')
    expect(saved.account).toBe('111111')
  })

  it('leaves the previous token on disk when the write fails', async () => {
    const path = await store()
    const original = `${JSON.stringify({ account: '111111', refreshToken: 'old' })}\n`
    await writeFile(path, original)
    const result = await refreshRotatedCredential({
      storePath: path,
      transport: async () => ({ status: 200, text: pair('new') }),
      write: async () => { throw new Error('disk full') },
    })
    expect(result).toEqual({ state: 'persist-failed', code: 'AUTH_REFRESH_PERSIST_FAILED' })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('keeps the raw body and the old file when the platform rejects or the body is not a pair', async () => {
    const path = await store()
    const original = `${JSON.stringify({ refreshToken: 'old' })}\n`
    await writeFile(path, original)
    const rejected = await refreshRotatedCredential({
      storePath: path,
      transport: async () => ({ status: 401, text: '{"code":"AUTH_TOKEN_INVALID"}' }),
    })
    expect(rejected).toEqual({ state: 'relogin', code: 'AUTH_REFRESH_REJECTED', raw: '{"code":"AUTH_TOKEN_INVALID"}' })
    expect(await readFile(path, 'utf8')).toBe(original)
    const unread = await refreshRotatedCredential({
      storePath: path,
      transport: async () => ({ status: 200, text: 'not-json' }),
    })
    expect(unread).toEqual({ state: 'relogin', code: 'AUTH_REFRESH_UNREADABLE', raw: 'not-json' })
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
