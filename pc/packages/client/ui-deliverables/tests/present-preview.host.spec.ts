/** Receipt coordinates authorize bounded safe media through the existing Session filesystem. */
import { mkdtemp, rm, writeFile, mkdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest } from '@deepseek-ai/dsh-session-query'
import { FsError } from '@deepseek-ai/dsh-fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPresentOpen } from '../src/present-open.ts'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const MAX_BYTES = 32 * 1024 * 1024
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function fixture(maxBytes = 64 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-preview-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const file = { path: 'out.gif' }
  await writeFile(join(cwd, file.path), GIF)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const session = { cwd }
  await ctx.plugin(LocalFileSystem, { cwd })
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  await ctx.plugin({ inject: ['fs', 'sandboxPolicy'], apply: (scope) => {
    new WorkspaceFiles(scope, { maxBytes, maxFileBytes: MAX_BYTES * 2, maxLines: 100, maxEntries: 100 })
  } })
  const readEvent = vi.fn(async (request: SessionEventReadRequest) => {
    if (request.sessionId !== 'owner') throw new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
    if (request.seq !== 7) throw new SessionQueryError('missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
    return { session, target: { type: 'deliverables/presented', data: {
      turn: 1, callId: 'present-call', files: [file],
    } } as SessionEvent }
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  const resolveAgent = vi.fn(() => { throw new Error('no Agent activation') })
  ctx.provide('sessionController', { resolveAgent, workspaceDesktop: () => ({
    name: 'headless', available: false, fileManager: null,
  }) } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: ['connection', 'sessionQuery', 'sessionController', 'workspaceFiles', 'fs', 'sandboxPolicy'], apply: registerPresentOpen })
  await fiber
  const handler = connection.createSharedFetchHandler('/api')
  const preview = (query = '?sessionId=owner&seq=7&index=0', init?: RequestInit) => handler.fetch(new Request(
    `http://localhost/api/present.preview${query}`, init,
  ))
  return { root, cwd, ctx, session, file, fiber, readEvent, preview, resolveAgent }
}

describe('receipt-coordinate media preview', () => {
  it('serves a real GIF from the Session header cwd without an Agent or desktop', async () => {
    const { ctx, cwd, preview, readEvent, resolveAgent } = await fixture()
    const stat = vi.spyOn(ctx.workspaceFiles, 'stat')
    const response = await preview()
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(GIF)
    expect(response.headers.get('content-type')).toBe('image/gif')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(stat.mock.calls[0]?.[0]).toEqual({ sessionId: 'owner', workspaceRoot: cwd })
    expect(readEvent.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'owner', seq: 7, before: 0, after: 0 })
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it.each(['', '?sessionId=owner&seq=7', '?sessionId=owner&seq=-1&index=0',
    '?sessionId=owner&seq=07&index=0', '?sessionId=owner&seq=7&index=0.5',
    '?sessionId=owner&seq=7&index=0&path=/tmp/a.gif', '?sessionId=owner&seq=7&index=0&url=https://evil',
    '?sessionId=owner&seq=7&index=0&sessionId=other', '?sessionId=owner&seq=9007199254740992&index=0',
  ])('rejects malformed and caller-path coordinates before reading %s', async (query) => {
    const { preview, readEvent } = await fixture()
    expect((await preview(query)).status).toBe(400)
    expect(readEvent).not.toHaveBeenCalled()
  })

  it('refuses wrong Sessions, absent events, wrong types, and indices before file reads', async () => {
    const { ctx, preview, readEvent, session } = await fixture()
    const reads = vi.spyOn(ctx.workspaceFiles, 'readBytes')
    for (const query of ['?sessionId=other&seq=7&index=0', '?sessionId=owner&seq=8&index=0', '?sessionId=owner&seq=7&index=1']) {
      expect((await preview(query)).status).toBe(404)
    }
    readEvent.mockResolvedValueOnce({ session, target: { type: 'turn/start' } as SessionEvent })
    expect((await preview()).status).toBe(404)
    readEvent.mockResolvedValueOnce({ session, target: { type: 'deliverables/presented', data: {
      turn: 1, callId: 'call', files: [{ path: '' }],
    } } as SessionEvent })
    expect((await preview()).status).toBe(404)
    expect(reads).not.toHaveBeenCalled()
  })

  it.each(['file.svg', 'file.html', 'deck.pptx', 'sound.mp3'])('keeps %s as a file card only', async (path) => {
    const { ctx, preview, file } = await fixture()
    file.path = path
    const reads = vi.spyOn(ctx.workspaceFiles, 'readBytes')
    expect((await preview()).status).toBe(415)
    expect(reads).not.toHaveBeenCalled()
  })

  it('refuses active-content bytes disguised as a GIF, missing sources, and final symlinks', async () => {
    const { cwd, preview, file, root } = await fixture()
    await writeFile(join(cwd, file.path), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect((await preview()).status).toBe(415)
    await unlink(join(cwd, file.path))
    expect((await preview()).status).toBe(404)
    await writeFile(join(root, 'real.gif'), GIF)
    await symlink(join(root, 'real.gif'), join(cwd, file.path))
    expect((await preview()).status).toBe(404)
  })

  it('keeps the existing FS policy for a declared outside-cwd file', async () => {
    const { root, preview, file } = await fixture()
    file.path = join(root, 'declared.gif')
    await writeFile(file.path, GIF)
    expect((await preview()).status).toBe(200)
  })

  it('rejects oversized sources even when the global full-file cap is greater', async () => {
    const { ctx, cwd, preview } = await fixture()
    const stat = await ctx.workspaceFiles.stat({ sessionId: 'owner' as never, workspaceRoot: cwd }, 'out.gif', new AbortController().signal)
    vi.spyOn(ctx.workspaceFiles, 'stat').mockResolvedValue({ ...stat, bytes: MAX_BYTES + 1 })
    const reads = vi.spyOn(ctx.workspaceFiles, 'readBytes')
    expect((await preview()).status).toBe(413)
    expect(reads).not.toHaveBeenCalled()
  })

  it('reads fixed bounded windows and refuses version drift or incomplete bytes', async () => {
    const { ctx, cwd, preview } = await fixture()
    const bytes = Buffer.alloc(70 * 1024)
    GIF.copy(bytes)
    await writeFile(join(cwd, 'out.gif'), bytes)
    const reads = vi.spyOn(ctx.workspaceFiles, 'readBytes')
    expect((await preview()).status).toBe(200)
    expect(reads.mock.calls.map(call => call[2])).toEqual([{ offset: 0, length: 65536 }, { offset: 65536, length: 6144 }])
    const current = await ctx.workspaceFiles.readBytes({ sessionId: 'owner' as never, workspaceRoot: cwd }, 'out.gif', { offset: 0, length: 65536 }, new AbortController().signal)
    reads.mockResolvedValueOnce({ ...current, version: 'changed' })
    expect((await preview()).status).toBe(409)
    reads.mockResolvedValueOnce({ ...current, data: 'R0lG' })
    expect((await preview()).status).toBe(409)
  })

  it('refuses a source that changes after its bytes were read', async () => {
    const { ctx, cwd, preview } = await fixture()
    const current = await ctx.workspaceFiles.stat({ sessionId: 'owner' as never, workspaceRoot: cwd }, 'out.gif', new AbortController().signal)
    vi.spyOn(ctx.workspaceFiles, 'stat').mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, version: 'later-version' })
    expect((await preview()).status).toBe(409)
  })

  it('keeps a lower deployment window limit fail-closed', async () => {
    const { preview } = await fixture(8)
    expect((await preview()).status).toBe(413)
  })

  it('handles initial, seek and suffix video requests after validating the full source', async () => {
    const { file, cwd, preview } = await fixture()
    file.path = 'clip.mp4'
    const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
    await writeFile(join(cwd, file.path), bytes)
    for (const [range, start, end] of [['bytes=0-', 0, 15], ['bytes=4-7', 4, 7], ['bytes=-4', 12, 15]] as const) {
      const response = await preview(undefined, { headers: { range } })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/16`)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1))
    }
    expect((await preview(undefined, { headers: { range: 'bytes=16-' } })).status).toBe(416)
    expect((await preview(undefined, { headers: { range: 'bytes=0-1,4-7' } })).status).toBe(400)
  })

  it('classifies permission and read failures without disclosing paths', async () => {
    const { ctx, preview } = await fixture()
    const reads = vi.spyOn(ctx.workspaceFiles, 'readBytes')
    for (const [code, status] of [['FS_PERMISSION_DENIED', 403], ['FS_SANDBOX_DENIED', 403],
      ['FS_TOO_LARGE', 413], ['FS_IO_ERROR', 500]] as const) {
      reads.mockRejectedValueOnce(new FsError('/private/hidden.gif', code))
      const response = await preview()
      expect(response.status).toBe(status)
      expect(await response.text()).not.toContain('/private')
    }
  })

  it('aborts pending reads and unregisters the route on disposal', async () => {
    const { ctx, preview, fiber } = await fixture()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(ctx.workspaceFiles, 'readBytes').mockImplementationOnce(async (_scope, _path, _range, signal) => {
      started()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('preview aborted')) }, { once: true })
      })
    })
    const pending = preview()
    const settled = expect(pending).rejects.toThrow()
    await ready
    await fiber.dispose()
    await settled
    expect((await preview()).status).toBe(404)
  })
})
