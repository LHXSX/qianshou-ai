import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { verifyPublicDesktopUpdate } from '../scripts/public-update-readback.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<{ plan: DesktopUploadPlan; binary: string; feed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-readback-'))
  roots.push(root)
  const binary = 'signed installer bytes'
  const feed = 'version: 1.2.3\n'
  const executable = join(root, 'qianshou-1.2.3-win-x64.exe')
  await writeFile(executable, binary)
  return {
    binary, feed,
    plan: {
      environment: 'production', target: 'win-x64', version: '1.2.3',
      bucket: 'qianshou-release', publicUrl: 'https://download.qianshousuanli.com/qianshou-desktop/feeds/win-x64/',
      secretIdEnvName: 'UNREAD_ID', secretKeyEnvName: 'UNREAD_KEY',
      artifacts: [
        { path: executable, filename: 'qianshou-1.2.3-win-x64.exe',
          key: 'qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe',
          contentType: 'application/vnd.microsoft.portable-executable', channelMetadata: false },
        { path: join(root, 'nightly.yml'), filename: 'nightly.yml',
          key: 'qianshou-desktop/feeds/win-x64/nightly.yml',
          contentType: 'application/yaml', channelMetadata: true, contents: feed },
      ],
    },
  }
}

function response(url: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const result = new Response(body, { status, headers })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

describe('public Desktop update readback', () => {
  it('streams exact public installer bytes before the feed and records their SHA-512', async () => {
    const f = await fixture()
    const requested: string[] = []
    const fetchPublic = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requested.push(url)
      expect(init).toMatchObject({ redirect: 'manual', headers: { 'accept-encoding': 'identity' } })
      return response(url, requested.length === 1 ? f.binary : f.feed)
    }) as typeof fetch
    const receipts = await verifyPublicDesktopUpdate(f.plan, fetchPublic)
    expect(requested).toEqual([
      'https://download.qianshousuanli.com/qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe',
      'https://download.qianshousuanli.com/qianshou-desktop/feeds/win-x64/nightly.yml',
    ])
    expect(receipts).toEqual([
      expect.objectContaining({ size: Buffer.byteLength(f.binary), sha512: createHash('sha512').update(f.binary).digest('base64') }),
      expect.objectContaining({ size: Buffer.byteLength(f.feed), channelMetadata: true }),
    ])
  })

  it('stops before reading the feed when a public installer is stale or missing', async () => {
    const f = await fixture()
    const stale = vi.fn(async (input: URL | RequestInfo) => response(String(input), 'signed installer bytEs')) as typeof fetch
    await expect(verifyPublicDesktopUpdate(f.plan, stale)).rejects.toThrow(/differs from the local release/u)
    expect(stale).toHaveBeenCalledOnce()

    const missing = vi.fn(async (input: URL | RequestInfo) => response(String(input), '', 404)) as typeof fetch
    await expect(verifyPublicDesktopUpdate(f.plan, missing)).rejects.toThrow(/HTTP 404/u)
    expect(missing).toHaveBeenCalledOnce()
  })

  it('rejects redirects, transformations, and dishonest lengths', async () => {
    const f = await fixture()
    const url = 'https://download.qianshousuanli.com/qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe'
    await expect(verifyPublicDesktopUpdate(f.plan, async () => response('https://other.example/file', '', 302)))
      .rejects.toThrow(/redirected/u)
    await expect(verifyPublicDesktopUpdate(f.plan, async () => response(url, f.binary, 200, { 'content-encoding': 'gzip' })))
      .rejects.toThrow(/content encoded/u)
    await expect(verifyPublicDesktopUpdate(f.plan, async () => response(url, f.binary, 200, { 'content-length': '1' })))
      .rejects.toThrow(/Content-Length/u)
  })

  it('refuses a plan whose feed could precede its binary or whose key escapes the origin', async () => {
    const f = await fixture()
    const fetchPublic = vi.fn(async () => response('', '')) as typeof fetch
    const reversed = { ...f.plan, artifacts: [...f.plan.artifacts].reverse() }
    await expect(verifyPublicDesktopUpdate(reversed, fetchPublic)).rejects.toThrow(/channel metadata must follow/u)
    const escaped = { ...f.plan, artifacts: [{ ...f.plan.artifacts[0]!, key: '../foreign' }, f.plan.artifacts[1]!] }
    await expect(verifyPublicDesktopUpdate(escaped, fetchPublic)).rejects.toThrow(/invalid object key/u)
  })
})
