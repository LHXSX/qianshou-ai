import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { H3OwnerSetupContextId } from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'

const contextId = brandString<H3OwnerSetupContextId>('b68437ec-41c6-47e9-aab2-ed33bb9cdb05')
import { createH3OwnerSetupTransport, type H3OwnerSetupRemote } from '../src/client/node-status/h3-owner-setup-transport.ts'

function fixture() {
  const remote: H3OwnerSetupRemote = { inspectH3OwnerSetup: vi.fn(), saveH3OwnerSetup: vi.fn(), startH3OwnerSelfTest: vi.fn(),
    h3OwnerSelfTestStatus: vi.fn(), createH3SkillDraft: vi.fn() }
  return { remote, transport: createH3OwnerSetupTransport(remote) }
}

describe('H3 owner setup remote boundaries', () => {
  it('only reads current state; no save, test or publication side effect', async () => {
    const f = fixture()
    vi.mocked(f.remote.inspectH3OwnerSetup).mockResolvedValue({ ok: true, value: {
      kind: 'current', contextId, runtime: null, revision: 0, configured: false, state: 'unconfigured', code: 'H3_SETUP_NOT_CONFIGURED',
    } })
    await expect(f.transport.inspect()).resolves.toMatchObject({ configured: false })
    expect(f.remote.saveH3OwnerSetup).not.toHaveBeenCalled()
    expect(f.remote.startH3OwnerSelfTest).not.toHaveBeenCalled()
    expect(f.remote.createH3SkillDraft).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'current', runtime: 'v2', revision: 1, configured: true, state: 'saved', code: 'H3_SETUP_SAVED' },
    { kind: 'current', contextId: 'owner-222222', runtime: 'v2', revision: 1,
      configured: true, state: 'saved', code: 'H3_SETUP_SAVED' },
    { kind: 'current', contextId, runtime: null, revision: -1, configured: false, state: 'unconfigured', code: 'H3_SETUP_NOT_CONFIGURED' },
    { kind: 'current', contextId, runtime: 'v2', revision: 1, configured: true, state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED' },
    { kind: 'current', contextId, runtime: null, revision: 0, configured: false, state: 'unconfigured', code: 'H3_SETUP_NOT_CONFIGURED', configPath: 'C:\\private' },
  ])('rejects invalid or private current state %#', async (value) => {
    const f = fixture()
    vi.mocked(f.remote.inspectH3OwnerSetup).mockResolvedValue({ ok: true, value })
    await expect(f.transport.inspect()).rejects.toThrow('INVALID_RESPONSE')
  })

  it('does not turn a platform ready flag into real local trial evidence', async () => {
    const f = fixture()
    vi.mocked(f.remote.startH3OwnerSelfTest).mockResolvedValue({ ok: true, value: {
      operationId: 'local-1', revision: 1, state: 'ready', code: 'PLATFORM_APPROVED', startedAt: 100,
    } })
    await expect(f.transport.start({ contextId, revision: 1, prompt: '测试' })).rejects.toThrow('INVALID_RESPONSE')
    expect(f.remote.startH3OwnerSelfTest).toHaveBeenCalledOnce()
  })

  it('rejects another operation or revision and does not automatically resubmit', async () => {
    const f = fixture()
    const status = { operationId: 'local-2', revision: 9, state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: 100 }
    vi.mocked(f.remote.h3OwnerSelfTestStatus).mockResolvedValue({ ok: true, value: status })
    await expect(f.transport.status('local-1' as never)).rejects.toThrow('INVALID_RESPONSE')
    vi.mocked(f.remote.startH3OwnerSelfTest).mockResolvedValue({ ok: true, value: status })
    await expect(f.transport.start({ contextId, revision: 1, prompt: '测试' })).rejects.toThrow('INVALID_RESPONSE')
    expect(f.remote.startH3OwnerSelfTest).toHaveBeenCalledOnce()
  })

  it('rejects save ABA and a draft claiming automatic publication', async () => {
    const f = fixture()
    vi.mocked(f.remote.saveH3OwnerSetup).mockResolvedValue({ ok: true, value: { state: 'saved', contextId, revision: 1 } })
    await expect(f.transport.save({ inspectionId: 'checked' as never, expectedRevision: 1 })).rejects.toThrow('INVALID_RESPONSE')
    vi.mocked(f.remote.createH3SkillDraft).mockResolvedValue({ ok: true, value: {
      state: 'draft', revision: 1, name: 'h3-video', displayName: '视频', published: true,
    } })
    await expect(f.transport.draft({ contextId, revision: 1, name: 'h3-video', displayName: '视频', description: '描述' })).rejects.toThrow('INVALID_RESPONSE')
  })

  it('retains only the opaque Host context and never substitutes an owner field', async () => {
    const f = fixture()
    vi.mocked(f.remote.inspectH3OwnerSetup).mockResolvedValue({ ok: true, value: {
      kind: 'current', contextId, runtime: 'v2', revision: 1, configured: true, state: 'saved', code: 'H3_SETUP_SAVED',
    } })
    const current = await f.transport.inspect()
    vi.mocked(f.remote.startH3OwnerSelfTest).mockResolvedValue({ ok: true, value: {
      operationId: 'local-1', revision: 1, state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: 100,
    } })
    await f.transport.start({ contextId: current.contextId, revision: 1, prompt: '镜头缓慢推进' })
    expect(f.remote.startH3OwnerSelfTest).toHaveBeenCalledExactlyOnceWith({ contextId, revision: 1, prompt: '镜头缓慢推进' })
  })
})
