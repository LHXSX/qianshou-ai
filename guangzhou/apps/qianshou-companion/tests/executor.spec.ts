import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJobRequest, type DeviceId, type JobId, type RemoteJob, type WorkspaceId } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import { executeJob, workspacePath } from '../src/executor.ts'
import { deviceEndpoint } from '../src/peer.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'qianshou-executor-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function fixture(kind: RemoteJob['kind'], payload: Record<string, string>): RemoteJob {
  return { id: 'job' as JobId, deviceId: 'device' as DeviceId, workspaceId: 'workspace' as WorkspaceId, kind, payload, status: 'running', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z', output: '' }
}

describe('companion workspace boundary', () => {
  it('blocks traversal, absolute paths, and symlinks pointing outside the approved directory', async () => {
    await expect(workspacePath(root, '../outside')).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
    await expect(workspacePath(root, '/etc/passwd')).rejects.toThrow('PATH_OUTSIDE_WORKSPACE')
    await symlink(tmpdir(), join(root, 'escape'))
    await expect(workspacePath(root, 'escape/outside', true)).rejects.toThrow('SYMLINK_NOT_ALLOWED')
  })
  it('writes and reads an approved local file', async () => {
    const base = fixture('write', { path: 'result.txt', content: 'verified' })
    const workspace = { id: 'workspace' as WorkspaceId, name: 'test', path: root }
    await executeJob({ ...base, kind: 'write' }, workspace, new AbortController().signal, () => {})
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('verified')
    expect(await executeJob({ ...base, kind: 'read' }, workspace, new AbortController().signal, () => {})).toMatchObject({ content: 'verified' })
  })
  it('refuses an oversized read', async () => {
    await writeFile(join(root, 'large'), Buffer.alloc(513_000))
    const job = fixture('read', { path: 'large' })
    await expect(executeJob(job, { id: 'ws' as WorkspaceId, name: 'test', path: root }, new AbortController().signal, () => {})).rejects.toThrow('FILE_TOO_LARGE')
  })
  it('requires validated TLS for a non-loopback coordinator', () => {
    expect(deviceEndpoint('http://127.0.0.1:3081')).toBe('ws://127.0.0.1:3081/qianshou-device')
    expect(deviceEndpoint('https://my-controller.example')).toBe('wss://my-controller.example/qianshou-device')
    expect(() => deviceEndpoint('http://192.168.1.8:3081')).toThrow('TLS_REQUIRED')
    expect(() => deviceEndpoint('https://user:secret@example.com')).toThrow('INVALID_ENDPOINT')
  })
  it('rejects a JSON-escaped write that would exceed the transport frame limit', () => {
    expect(() => parseJobRequest(fixture('write', { path: 'control.txt', content: '\0'.repeat(300_000) }))).toThrow('PAYLOAD_TOO_LARGE')
  })
})
