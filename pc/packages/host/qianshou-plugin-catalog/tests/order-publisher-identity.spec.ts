import { createPublicKey, verify } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { accountOrderPublisherIdentity, signAndRecordOrderAuthorManifest } from '../src/order-publisher-identity.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qianshou-author-identity-'))
  homes.push(path)
  return path
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

it.skipIf(process.platform === 'win32')('keeps account keys distinct, stable, mode 0600 and rejects linked or loosened key files', async () => {
  const profile = await home()
  const first = await accountOrderPublisherIdentity(profile, 7)
  const same = await accountOrderPublisherIdentity(profile, 7)
  const other = await accountOrderPublisherIdentity(profile, 8)
  expect(same.keyId).toBe(first.keyId)
  expect(other.keyId).not.toBe(first.keyId)
  const directory = join(profile, 'order-publisher-identities')
  expect((await lstat(directory)).mode & 0o777).toBe(0o700)
  const file = join(directory, 'owner-7.pem')
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  await chmod(file, 0o644)
  await expect(accountOrderPublisherIdentity(profile, 7)).rejects.toMatchObject({
    code: 'order-author-key-unavailable',
  })
  await rm(file)
  await symlink(join(directory, 'owner-8.pem'), file)
  await expect(accountOrderPublisherIdentity(profile, 7)).rejects.toMatchObject({
    code: 'order-author-key-unavailable',
  })
})

it.skipIf(process.platform === 'win32')('rejects replacement of the private identity directory with a symlink', async () => {
  const profile = await home()
  await accountOrderPublisherIdentity(profile, 7)
  const directory = join(profile, 'order-publisher-identities')
  const displaced = join(profile, 'displaced-identities')
  await rename(directory, displaced)
  await symlink(displaced, directory)
  await expect(accountOrderPublisherIdentity(profile, 7)).rejects.toMatchObject({
    code: 'order-author-key-unavailable',
  })
})

it('signs server challenge and exact v2 owner/publication/runtime manifest without sending private key', async () => {
  const profileDir = await home()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const packageDigest = `sha256:${'b'.repeat(64)}`
  const archive = {
    bytes: Buffer.from('fixed-zip'), artifactDigest: `sha256:${'a'.repeat(64)}`,
    archiveDigest: `sha256:${'c'.repeat(64)}`, sizeBytes: 9, platformDispatchable: true,
    inventoryAlgorithm: 'qianshou.bar-chart-package.v4' as const,
    taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    files: ['package.json', 'pnpm-lock.yaml', 'local-adapter.json', 'src/adapter.mjs',
      'src/assemble_gif.py', 'src/encode_frames.swift'].map(path => ({
      path, size_bytes: 4, sha256: 'd'.repeat(64),
    })),
  }
  let publicKey = ''
  let keyId = ''
  let authorPayload: Record<string, unknown> | undefined
  const send = vi.fn(async (url: URL, request: RequestInit) => {
    expect(request.headers).toMatchObject({ authorization: 'Bearer account-test-token' })
    expect(request.body ?? '').not.toContain('PRIVATE KEY')
    if (url.pathname.endsWith('/challenge')) return Response.json({
      schema: 'qianshou.order-adapter-key-enrollment.v1', owner_id: 7,
      challenge_id: 'b9418e38-b3a5-5722-8005-cc7afbe2a21b', nonce: 'n'.repeat(43),
      expires_at: Math.floor(Date.now() / 1000) + 200,
    })
    expect(typeof request.body).toBe('string')
    if (typeof request.body !== 'string') throw new Error('expected JSON body')
    const body = JSON.parse(request.body) as Record<string, unknown>
    const field = (key: string): string => {
      const value = body[key]
      if (typeof value !== 'string') throw new Error(`expected string ${key}`)
      return value
    }
    if (url.pathname.endsWith('/task-adapter-publisher-keys')) {
      keyId = field('key_id')
      publicKey = field('public_key')
      const raw = Buffer.from(publicKey, 'base64url')
      const key = createPublicKey({ key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), raw,
      ]), format: 'der', type: 'spki' })
      const challenge = { schema: 'qianshou.order-adapter-key-enrollment.v1', owner_id: 7,
        key_id: keyId, public_key: publicKey,
        challenge_id: field('challenge_id'), nonce: 'n'.repeat(43) }
      expect(verify(null, Buffer.from(canonical(challenge)), key,
        Buffer.from(field('signature'), 'base64url'))).toBe(true)
      return Response.json({ schema: 'qianshou.order-adapter-publisher-key.v1',
        owner_id: 7, key_id: keyId, public_key: publicKey, status: 'active' })
    }
    const manifest = body.author_manifest as Record<string, unknown>
    expect(manifest.payload).toBeTypeOf('object')
    authorPayload = manifest.payload as Record<string, unknown>
    if (typeof manifest.signature !== 'string') throw new Error('expected author signature')
    const key = createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64url'),
    ]), format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(canonical(authorPayload)), key,
      Buffer.from(manifest.signature, 'base64url'))).toBe(true)
    return Response.json({ publication_id: publicationId, owner_id: 7,
      key_id: keyId, status: 'recorded' })
  })
  await signAndRecordOrderAuthorManifest({ origin: 'https://qianshousuanli.com',
    token: 'account-test-token', publicationId, ownerId: 7, packageDigest,
    version: '0.1.0', archive, profileDir, fetch: send as typeof fetch })
  expect(send).toHaveBeenCalledTimes(3)
  expect(authorPayload).toMatchObject({
    schema: 'qianshou.order-adapter-author-manifest.v2', publication_id: publicationId,
    owner_id: 7, publisher_key_id: keyId, package_digest: packageDigest,
    inventory_algorithm: 'qianshou.bar-chart-package.v4',
    artifact_digest: archive.artifactDigest, version: '0.1.0',
    files: archive.files,
  })
  expect((await readdir(join(profileDir, 'order-publisher-identities'))).sort())
    .toEqual([process.platform === 'win32' ? 'owner-7.dpapi.json' : 'owner-7.pem'])
})
