import { createPublicKey, verify } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accountOrderPublisherIdentity } from '../src/order-publisher-identity.ts'
import { decodeWindowsPublisherSecret, encodeWindowsPublisherSecret,
  windowsPublisherSecret } from '../src/order-publisher-windows-secret.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('refuses plaintext, malformed, oversized and another account’s encrypted record', () => {
  const ciphertext = Buffer.from('ciphertext is not accepted as plaintext')
  const record = encodeWindowsPublisherSecret(ciphertext, 7)
  expect(decodeWindowsPublisherSecret(record, 7)).toEqual(ciphertext)
  for (const bytes of [Buffer.from('-----BEGIN PRIVATE KEY-----'), Buffer.from('{}'),
    Buffer.alloc(16 * 1024 + 1), encodeWindowsPublisherSecret(ciphertext, 8),
    Buffer.from(JSON.stringify({ schema: 'qianshou.order-publisher.dpapi.v1', ownerId: 7, payload: '!!!!' })),
    Buffer.from(JSON.stringify({ schema: 'qianshou.order-publisher.dpapi.v1', ownerId: 7,
      payload: ciphertext.toString('base64'), unexpected: true }))]) {
    expect(() => decodeWindowsPublisherSecret(bytes, 7)).toThrow('order-author-key-unavailable')
  }
})

it.skipIf(process.platform === 'win32')('never falls back to plaintext or another crypto backend on non-Windows', async () => {
  await expect(windowsPublisherSecret('protect', Buffer.from('secret'), 7))
    .rejects.toMatchObject({ code: 'order-author-key-unavailable' })
})

// These require real Windows CurrentUser DPAPI; a Mac replay cannot establish their result.
describe.skipIf(process.platform !== 'win32')('real Windows publisher storage', () => {
  it('protects a secret with account entropy and rejects mutation or a different account', async () => {
    const plain = Buffer.from('isolated-dpapi-fixture-secret')
    const protectedBytes = await windowsPublisherSecret('protect', plain, 7)
    expect(protectedBytes.includes(plain)).toBe(false)
    expect(await windowsPublisherSecret('unprotect', protectedBytes, 7)).toEqual(plain)
    await expect(windowsPublisherSecret('unprotect', protectedBytes, 8))
      .rejects.toMatchObject({ code: 'order-author-key-unavailable' })
    const damaged = Buffer.from(protectedBytes)
    damaged[Math.floor(damaged.length / 2)]! ^= 1
    await expect(windowsPublisherSecret('unprotect', damaged, 7))
      .rejects.toMatchObject({ code: 'order-author-key-unavailable' })
  }, 60_000)

  it('uses the real operating system directory despite a redirected SystemRoot environment', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'qianshou-fake-windows-'))
    directories.push(fakeRoot)
    const original = process.env.SystemRoot
    try {
      process.env.SystemRoot = fakeRoot
      const plain = Buffer.from('isolated-system-directory-fixture')
      const protectedBytes = await windowsPublisherSecret('protect', plain, 7)
      expect(await windowsPublisherSecret('unprotect', protectedBytes, 7)).toEqual(plain)
    } finally {
      if (original === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = original
    }
  }, 60_000)

  it('keeps real Ed25519 keys stable per account and stores no plaintext key', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'qianshou-dpapi-publisher-'))
    directories.push(profile)
    const [first, again] = await Promise.all([
      accountOrderPublisherIdentity(profile, 7), accountOrderPublisherIdentity(profile, 7),
    ])
    const other = await accountOrderPublisherIdentity(profile, 8)
    expect(again.keyId).toBe(first.keyId)
    expect(other.keyId).not.toBe(first.keyId)
    const directory = join(profile, 'order-publisher-identities')
    expect((await readdir(directory)).sort()).toEqual(['owner-7.dpapi.json', 'owner-8.dpapi.json'])
    const bytes = await readFile(join(directory, 'owner-7.dpapi.json'))
    expect(bytes.toString('utf8')).not.toContain('PRIVATE KEY')
    const publicKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(first.publicKey, 'base64url'),
    ]) })
    expect(verify(null, Buffer.from('{"fixture":true}'), publicKey,
      Buffer.from(first.sign({ fixture: true }), 'base64url'))).toBe(true)
    await writeFile(join(directory, 'owner-7.dpapi.json'), encodeWindowsPublisherSecret(
      decodeWindowsPublisherSecret(await readFile(join(directory, 'owner-8.dpapi.json')), 8), 7))
    await expect(accountOrderPublisherIdentity(profile, 7))
      .rejects.toMatchObject({ code: 'order-author-key-unavailable' })
  }, 90_000)

  it('rejects a private-directory junction without reading or replacing its keys', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'qianshou-dpapi-junction-'))
    directories.push(profile)
    await accountOrderPublisherIdentity(profile, 7)
    const directory = join(profile, 'order-publisher-identities')
    const displaced = join(profile, 'original-identities')
    await rename(directory, displaced)
    const bytes = await readFile(join(displaced, 'owner-7.dpapi.json'))
    await symlink(displaced, directory, 'junction')
    await expect(accountOrderPublisherIdentity(profile, 7))
      .rejects.toMatchObject({ code: 'order-author-key-unavailable' })
    expect(await readFile(join(displaced, 'owner-7.dpapi.json'))).toEqual(bytes)
  }, 60_000)
})
