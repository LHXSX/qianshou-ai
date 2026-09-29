import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { H3CanonicalSetupContextId, H3CanonicalTrialId } from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'
import { createH3CanonicalSetupTransport, type H3CanonicalSetupRemote }
  from '../src/client/node-status/h3-canonical-setup-transport.ts'

const contextId = brandString<H3CanonicalSetupContextId>('b68437ec-41c6-47e9-aab2-ed33bb9cdb05')
const operationId = brandString<H3CanonicalTrialId>('933a70e3-3e5b-4d04-a00b-05c824e5116e')
const secondId = brandString<H3CanonicalTrialId>('41111111-2222-4333-8444-555555555555')
const ready = { operationId, revision: 1, sample: 1, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED',
  startedAt: 100, finishedAt: 200 } as const
const saved = { kind: 'current', contextId, runtime: 'canonical', configured: true, revision: 1,
  state: 'saved', code: 'H3_CANONICAL_SAVED', samples: [] } as const

function fixture() {
  const remote: H3CanonicalSetupRemote = { inspectH3CanonicalSetup: vi.fn(), saveH3CanonicalSetup: vi.fn(),
    startH3CanonicalTrial: vi.fn(), h3CanonicalTrialStatus: vi.fn(), createH3CanonicalSkillDraft: vi.fn() }
  return { remote, transport: createH3CanonicalSetupTransport(remote) }
}

describe('canonical setup response ownership', () => {
  it('reads saved state through the canonical namespace with no trial command', async () => {
    const f = fixture()
    vi.mocked(f.remote.inspectH3CanonicalSetup).mockResolvedValue({ ok: true, value: saved })
    expect(await f.transport.inspect()).toEqual(saved)
    expect(f.remote.startH3CanonicalTrial).not.toHaveBeenCalled()
    expect(f.remote.saveH3CanonicalSetup).not.toHaveBeenCalled()
  })

  it('keeps a shared unknown admission with no sample as a read-only blocking state', async () => {
    const f = fixture()
    const value = { ...saved, state: 'unknown', code: 'H3_CANONICAL_TRIAL_UNKNOWN' }
    vi.mocked(f.remote.inspectH3CanonicalSetup).mockResolvedValue({ ok: true, value })
    expect(await f.transport.inspect()).toEqual(value)
    expect(f.remote.startH3CanonicalTrial).not.toHaveBeenCalled()
    vi.mocked(f.remote.inspectH3CanonicalSetup).mockResolvedValue({ ok: true,
      value: { ...value, state: 'pending', code: 'H3_CANONICAL_TRIAL_PENDING' } })
    await expect(f.transport.inspect()).rejects.toThrow('INVALID_RESPONSE')
  })

  it.each([
    { ...saved, runtime: 'v2' },
    { ...saved, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED', samples: [ready] },
    { ...saved, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED', samples: [ready, ready] },
    { ...saved, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED', samples: [ready, { ...ready, sample: 2 }] },
    { ...saved, samples: [{ ...ready, sample: 2 }] },
    { ...saved, configPath: 'private-owner-runtime' },
  ])('refuses old runtime, duplicate samples or private response fields %#', async (value) => {
    const f = fixture()
    vi.mocked(f.remote.inspectH3CanonicalSetup).mockResolvedValue({ ok: true, value })
    await expect(f.transport.inspect()).rejects.toThrow('INVALID_RESPONSE')
    expect(f.remote.startH3CanonicalTrial).not.toHaveBeenCalled()
  })

  it('accepts two distinct terminal samples and refuses an unconfirmed terminal timestamp', async () => {
    const f = fixture()
    const value = { ...saved, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED',
      samples: [ready, { ...ready, operationId: secondId, sample: 2 }] }
    vi.mocked(f.remote.inspectH3CanonicalSetup).mockResolvedValue({ ok: true, value })
    expect(await f.transport.inspect()).toEqual(value)
    vi.mocked(f.remote.h3CanonicalTrialStatus).mockResolvedValue({ ok: true, value: { ...ready, finishedAt: undefined } })
    await expect(f.transport.status(operationId)).rejects.toThrow('INVALID_RESPONSE')
  })

  it('does not retry a lost explicit trial command or consume a foreign sample response', async () => {
    const f = fixture()
    vi.mocked(f.remote.startH3CanonicalTrial).mockRejectedValue(new Error('connection lost'))
    await expect(f.transport.start({ contextId, revision: 1, sample: 1, prompt: '镜头推进' })).rejects.toThrow('connection lost')
    expect(f.remote.startH3CanonicalTrial).toHaveBeenCalledOnce()
    vi.mocked(f.remote.startH3CanonicalTrial).mockResolvedValue({ ok: true, value: ready })
    await expect(f.transport.start({ contextId, revision: 1, sample: 2, prompt: '镜头推进' })).rejects.toThrow('INVALID_RESPONSE')
    vi.mocked(f.remote.h3CanonicalTrialStatus).mockResolvedValue({ ok: true, value: { ...ready, operationId: secondId } })
    await expect(f.transport.status(operationId)).rejects.toThrow('INVALID_RESPONSE')
  })
})
