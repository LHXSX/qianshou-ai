// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { H3OwnerSetupContextId, H3OwnerSelfTestStatus } from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'
import { H3OwnerWizard, chooseH3LocalFile } from '../src/client/node-status/H3OwnerWizard.tsx'
import type { H3OwnerSetupTransport } from '../src/client/node-status/h3-owner-setup-transport.ts'
import { zh } from '../src/client/node-status/locales.ts'
import { NodeIntakePage } from '../src/client/node-status/NodeIntakePage.tsx'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { createStubTransport } from './fixtures/node-status.fixture.ts'

const contextId = brandString<H3OwnerSetupContextId>('b68437ec-41c6-47e9-aab2-ed33bb9cdb05')
const nextContextId = brandString<H3OwnerSetupContextId>('933a70e3-3e5b-4d04-a00b-05c824e5116e')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(operation?: H3OwnerSelfTestStatus) {
  const transport: H3OwnerSetupTransport = { inspect: vi.fn(async () => ({ kind: 'current', contextId, runtime: 'v2', revision: 1,
    configured: true, state: operation?.state ?? 'saved', code: operation?.code ?? 'H3_SETUP_SAVED',
    ...(operation ? { operation } : {}) } as const)),
  save: vi.fn(), start: vi.fn(), status: vi.fn(), draft: vi.fn() }
  const view = render(<H3OwnerWizard t={makeTranslate(zh)} transport={transport} />)
  return { transport, view }
}

describe('H3 setup for ordinary users', () => {
  it('reads only after opening and never starts GPU on mount or current-state refresh', async () => {
    const { transport } = fixture()
    expect(transport.inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupSaved)
    expect(transport.inspect).toHaveBeenCalledOnce()
    expect(transport.start).not.toHaveBeenCalled()
    expect(transport.save).not.toHaveBeenCalled()
    expect(transport.draft).not.toHaveBeenCalled()
    expect(screen.queryByText('输入 JSON')).toBeNull()
  })

  it('does not retry an unknown trial and lets the owner read its state', async () => {
    const operation = { operationId: 'local-1' as never, revision: 1, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN', startedAt: 100 } as const
    const { transport } = fixture(operation)
    vi.mocked(transport.status).mockResolvedValue(operation)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupUnknown)
    expect(screen.getByRole('button', { name: zh.h3SetupRun }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
    await waitFor(() => { expect(transport.status).toHaveBeenCalledExactlyOnceWith('local-1') })
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('requires an explicit test click and retains returned pending status', async () => {
    const { transport } = fixture()
    vi.mocked(transport.start).mockResolvedValue({ operationId: 'local-1' as never, revision: 1,
      state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: 100 })
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupSaved)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRun }))
    await screen.findByText(zh.h3SetupPending)
    expect(transport.start).toHaveBeenCalledExactlyOnceWith({ contextId, revision: 1, prompt: zh.h3SetupDefaultPrompt })
    expect(transport.draft).not.toHaveBeenCalled()
  })

  it('creates only a local draft after real ready state, without publishing', async () => {
    const { transport } = fixture({ operationId: 'local-1' as never, revision: 1, state: 'ready',
      code: 'H3_SETUP_SELF_TEST_VERIFIED', startedAt: 100, finishedAt: 110 })
    vi.mocked(transport.draft).mockResolvedValue({ state: 'draft', revision: 1, name: 'h3', displayName: '视频', published: false })
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupVerified)
    expect(transport.draft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupCreate }))
    await screen.findByText(zh.h3SetupCreated)
    expect(transport.draft).toHaveBeenCalledOnce()
    expect(vi.mocked(transport.draft).mock.calls[0]?.[0]).toMatchObject({ contextId, revision: 1, displayName: zh.h3SetupSkillDefault })
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('refreshes an expired ready context read-only and creates only after a fresh owner click', async () => {
    const ready = { operationId: 'local-1' as never, revision: 1, state: 'ready',
      code: 'H3_SETUP_SELF_TEST_VERIFIED', startedAt: 100, finishedAt: 110 } as const
    const { transport } = fixture(ready)
    vi.mocked(transport.status).mockResolvedValue(ready)
    vi.mocked(transport.draft).mockRejectedValueOnce(new Error('H3_SETUP_CONTEXT_EXPIRED'))
    vi.mocked(transport.draft).mockResolvedValueOnce({ state: 'draft', revision: 1, name: 'h3', displayName: '视频', published: false })
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupVerified)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupCreate }))
    await screen.findByRole('alert')
    vi.mocked(transport.inspect).mockResolvedValueOnce({ kind: 'current', contextId: nextContextId, runtime: 'v2', revision: 1,
      configured: true, state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED', operation: ready })
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
    await waitFor(() => { expect(transport.inspect).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(transport.draft).toHaveBeenCalledOnce()
    expect(transport.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupCreate }))
    await screen.findByText(zh.h3SetupCreated)
    expect(vi.mocked(transport.draft).mock.calls[1]?.[0]).toMatchObject({ contextId: nextContextId, revision: 1 })
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('never fabricates native paths in an ordinary browser', async () => {
    await expect(chooseH3LocalFile('first-frame')).rejects.toThrow('PICKER_UNAVAILABLE')
  })

  it('drops an old pending command when the transport scope changes to an equal revision', async () => {
    const { transport, view } = fixture()
    const delayed = Promise.withResolvers<H3OwnerSelfTestStatus>()
    vi.mocked(transport.start).mockReturnValue(delayed.promise)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupSaved)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRun }))
    const next = { ...transport, start: vi.fn(async () => ({ operationId: 'new' as never, revision: 1, state: 'pending',
      code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: 200 } as const)),
    inspect: vi.fn(async () => ({ kind: 'current', contextId: nextContextId, runtime: 'v2', revision: 1,
      configured: true, state: 'saved', code: 'H3_SETUP_SAVED' } as const)) }
    view.rerender(<H3OwnerWizard t={makeTranslate(zh)} transport={next} />)
    await screen.findByText(zh.h3SetupSaved)
    await act(async () => { delayed.resolve({ operationId: 'old' as never, revision: 1, state: 'ready',
      code: 'H3_SETUP_SELF_TEST_VERIFIED', startedAt: 100, finishedAt: 200 }); await delayed.promise })
    expect(screen.queryByText(zh.h3SetupVerified)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.h3SetupCreate })).toBeNull()
    expect(next.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRun }))
    await screen.findByText(zh.h3SetupPending)
    expect(next.start).toHaveBeenCalledExactlyOnceWith({ contextId: nextContextId, revision: 1, prompt: zh.h3SetupDefaultPrompt })
  })

  it('removes ready-state confirmation immediately on the actual identity invalidation seam', async () => {
    cleanup()
    const ready = { operationId: 'old' as never, revision: 1, state: 'ready',
      code: 'H3_SETUP_SELF_TEST_VERIFIED', startedAt: 100, finishedAt: 200 } as const
    const { transport } = fixture(ready)
    cleanup()
    const controller = new NodeStatusController({ transport: createStubTransport([]), storage: null })
    render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} h3SetupTransport={transport} dashboard={null} />)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupVerified)
    await act(async () => { controller.invalidateIdentity() })
    expect(screen.queryByRole('button', { name: zh.h3SetupCreate })).toBeNull()
    expect(screen.getByRole('button', { name: zh.h3SetupOpen }).getAttribute('aria-expanded')).toBe('false')
    expect(transport.start).not.toHaveBeenCalled()
    expect(transport.draft).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('drops an old native chooser result when a new transport replaces its scope', async () => {
    const { transport, view } = fixture()
    const delayed = Promise.withResolvers<string | null>()
    const chooser = vi.fn(() => delayed.promise)
    view.rerender(<H3OwnerWizard t={makeTranslate(zh)} transport={transport} chooseFile={chooser} />)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await screen.findByText(zh.h3SetupSaved)
    fireEvent.click(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${zh.h3SetupFirstFrame}` }))
    const next = { ...transport }
    view.rerender(<H3OwnerWizard t={makeTranslate(zh)} transport={next} chooseFile={chooser} />)
    await screen.findByText(zh.h3SetupSaved)
    await act(async () => { delayed.resolve('C:\\owner-a-private\\first.png'); await delayed.promise })
    expect(screen.queryByText('first.png')).toBeNull()
    expect(transport.save).not.toHaveBeenCalled()
  })

  it('passes the selected real adapter output folder and keeps inspect, save and GPU separate', async () => {
    const { transport, view } = fixture()
    const chooseFile = vi.fn(async (purpose: string) => `C:\\h3\\${purpose}`)
    const chooseDirectory = vi.fn(async () => 'D:\\H3\\LocalAPI\\outputs')
    vi.mocked(transport.inspect).mockResolvedValueOnce({ kind: 'current', contextId, configured: false, runtime: null,
      revision: 0, state: 'unconfigured', code: 'H3_SETUP_NOT_CONFIGURED' })
    vi.mocked(transport.inspect).mockResolvedValueOnce({ kind: 'inspection', contextId, inspectionId: 'checked' as never,
      revision: 0, expiresAt: Date.now() + 60_000, adapterAvailable: true, code: 'H3_SETUP_INSPECTED' })
    vi.mocked(transport.save).mockResolvedValue({ state: 'saved', contextId, revision: 1 })
    view.rerender(<H3OwnerWizard t={makeTranslate(zh)} transport={transport}
      chooseFile={chooseFile} chooseDirectory={chooseDirectory} />)
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupOpen }))
    await waitFor(() => { expect(screen.queryByText(zh.h3SetupLoading)).toBeNull() })
    fireEvent.click(screen.getByText(zh.h3SetupEnvironment))
    const fileLabels = [zh.h3SetupFirstFrame, zh.h3SetupWorkflow, zh.h3SetupModel,
      zh.h3SetupPython, zh.h3SetupFfmpeg, zh.h3SetupFfprobe]
    for (const label of fileLabels) {
      fireEvent.click(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${label}` }))
      await waitFor(() => { expect(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${label}` }).hasAttribute('disabled')).toBe(false) })
    }
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupChooseFolder }))
    await screen.findByText('outputs')
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupInspect }))
    await screen.findByText(zh.h3SetupInspected)
    expect(vi.mocked(transport.inspect).mock.calls[1]?.[0]).toMatchObject({ adapterOutputRoot: 'D:\\H3\\LocalAPI\\outputs' })
    expect(transport.save).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.h3SetupSave }))
    await screen.findByText(zh.h3SetupSaved)
    expect(transport.save).toHaveBeenCalledExactlyOnceWith({ inspectionId: 'checked', expectedRevision: 0 })
    expect(transport.start).not.toHaveBeenCalled()
    expect(transport.draft).not.toHaveBeenCalled()
  })
})
