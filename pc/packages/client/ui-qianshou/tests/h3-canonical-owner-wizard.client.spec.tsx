// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { H3CanonicalSetupContextId, H3CanonicalInspectionId, H3CanonicalTrialId,
  H3CanonicalSetupSummary, H3CanonicalTrialStatus } from '@deepseek-ai/dsh-host-qianshou-plugin-catalog/types'
import { H3CanonicalOwnerWizard } from '../src/client/node-status/H3CanonicalOwnerWizard.tsx'
import type { H3CanonicalSetupTransport } from '../src/client/node-status/h3-canonical-setup-transport.ts'
import { zh } from '../src/client/node-status/locales.ts'
import type { NodeTranslate } from '../src/client/node-status/NodeStatusPanel.tsx'

const contextId = brandString<H3CanonicalSetupContextId>('b68437ec-41c6-47e9-aab2-ed33bb9cdb05')
const inspectionId = brandString<H3CanonicalInspectionId>('41111111-2222-4333-8444-555555555555')
const firstId = brandString<H3CanonicalTrialId>('933a70e3-3e5b-4d04-a00b-05c824e5116e')
const secondId = brandString<H3CanonicalTrialId>('42222222-2222-4333-8444-555555555555')
const t: NodeTranslate = key => zh[key]
afterEach(cleanup)

function fixture(configured = true) {
  let current: H3CanonicalSetupSummary = { kind: 'current', contextId, runtime: configured ? 'canonical' : null,
    configured, revision: configured ? 1 : 0, state: configured ? 'saved' : 'unconfigured',
    code: configured ? 'H3_CANONICAL_SAVED' : 'H3_CANONICAL_NOT_CONFIGURED', samples: [] }
  const transport: H3CanonicalSetupTransport = {
    inspect: vi.fn<H3CanonicalSetupTransport['inspect']>(async selection => selection ? { kind: 'inspection', contextId, inspectionId,
      revision: current.revision, expiresAt: 1000, code: 'H3_CANONICAL_INSPECTED' } : current),
    save: vi.fn<H3CanonicalSetupTransport['save']>(async () => {
      current = { ...current, runtime: 'canonical', configured: true, revision: 1, state: 'saved', code: 'H3_CANONICAL_SAVED' }
      return { contextId, state: 'saved', revision: 1 }
    }),
    start: vi.fn<H3CanonicalSetupTransport['start']>(async (request) => {
      const operation: H3CanonicalTrialStatus = { operationId: request.sample === 1 ? firstId : secondId,
        revision: 1, sample: request.sample, state: 'pending', code: 'H3_CANONICAL_TRIAL_PENDING', startedAt: 100 }
      current = { ...current, state: 'pending', code: 'H3_CANONICAL_TRIAL_PENDING', samples: [...current.samples, operation] }
      return operation
    }),
    status: vi.fn<H3CanonicalSetupTransport['status']>(async (id) => { const found = current.samples.find(row => row.operationId === id); if (!found) throw new Error('missing'); return found }),
    draft: vi.fn<H3CanonicalSetupTransport['draft']>(async request => ({ state: 'draft', revision: request.revision,
      name: request.name, displayName: request.displayName, published: false })),
  }
  const view = render(<H3CanonicalOwnerWizard transport={transport} t={t} chooseFile={async () => 'C:\\owner\\first.png'} />)
  fireEvent.click(screen.getByRole('button', { name: zh.h3CanonicalOpen }))
  return { transport, view, setCurrent(value: H3CanonicalSetupSummary) { current = value }, current: () => current }
}

it('asks only for a PNG and keeps checking, saving and GPU starts separate', async () => {
  const f = fixture(false)
  await waitFor(() => { expect(f.transport.inspect).toHaveBeenCalledOnce() })
  expect(document.querySelector('[data-h3-readiness]')?.getAttribute('data-h3-readiness')).toBe('unchecked')
  expect(screen.getByText(zh.h3CanonicalWorkflowRequirement)).toBeTruthy()
  expect(screen.getByText(zh.h3CanonicalInstallGuide)).toBeTruthy()
  expect(screen.getAllByText(zh.h3CanonicalRequirementUnchecked)).toHaveLength(4)
  expect(screen.queryByText(zh.h3SetupModel)).toBeNull()
  expect(screen.queryByText(zh.h3SetupPython)).toBeNull()
  expect(screen.queryByText(/JSON/u)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${zh.h3SetupFirstFrame}` }))
  await screen.findByText('first.png')
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupInspect }))
  await screen.findByText(zh.h3CanonicalInspected)
  expect(document.querySelector('[data-h3-readiness]')?.getAttribute('data-h3-readiness')).toBe('inspected')
  expect(vi.mocked(f.transport.inspect).mock.calls[1]?.[0]).toEqual({ firstFramePath: 'C:\\owner\\first.png',
    adapterBase: 'http://127.0.0.1:8791', negative: '' })
  expect(f.transport.save).not.toHaveBeenCalled()
  expect(f.transport.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupSave }))
  await screen.findByText(zh.h3CanonicalSaved)
  expect(document.querySelector('[data-h3-readiness]')?.getAttribute('data-h3-readiness')).toBe('unchecked')
  expect(f.transport.start).not.toHaveBeenCalled()
})

it('starts each sample once and allows a draft only after two confirmed samples', async () => {
  const f = fixture()
  await screen.findByText(zh.h3CanonicalSaved)
  fireEvent.click(screen.getByRole('button', { name: zh.h3CanonicalRunFirst }))
  fireEvent.click(screen.getByRole('button', { name: zh.h3CanonicalRunFirst }))
  await screen.findByText(zh.h3CanonicalPending)
  expect(f.transport.start).toHaveBeenCalledExactlyOnceWith({ contextId, revision: 1, sample: 1, prompt: zh.h3SetupDefaultPrompt })
  expect(screen.queryByRole('button', { name: zh.h3SetupCreate })).toBeNull()
  const first = { operationId: firstId, revision: 1, sample: 1, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED',
    startedAt: 100, finishedAt: 200 } as const
  f.setCurrent({ ...f.current(), state: 'saved', code: 'H3_CANONICAL_SAVED', samples: [first] })
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
  await screen.findByText(zh.h3CanonicalFirstReady)
  expect(f.transport.start).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: zh.h3CanonicalRunSecond }))
  await screen.findByText(zh.h3CanonicalPending)
  expect(vi.mocked(f.transport.start).mock.calls[1]?.[0].sample).toBe(2)
  f.setCurrent({ ...f.current(), state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED',
    samples: [first, { ...first, operationId: secondId, sample: 2 }] })
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
  await screen.findByText(zh.h3CanonicalReady)
  expect(document.querySelector('[data-h3-readiness]')?.getAttribute('data-h3-readiness')).toBe('trial')
  expect(screen.getAllByText(zh.h3CanonicalRequirementTrial)).toHaveLength(4)
  expect(f.transport.draft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupCreate }))
  await screen.findByText(zh.h3SetupCreated)
  expect(f.transport.draft).toHaveBeenCalledOnce()
  expect(f.transport.start).toHaveBeenCalledTimes(2)
})

it('explains an unavailable local service without claiming which model or plugin is missing', async () => {
  const f = fixture(false)
  await waitFor(() => { expect(f.transport.inspect).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${zh.h3SetupFirstFrame}` }))
  await screen.findByText('first.png')
  vi.mocked(f.transport.inspect).mockRejectedValueOnce(new Error('H3_CANONICAL_READ_UNAVAILABLE'))
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupInspect }))
  await screen.findByText(zh.h3CanonicalServiceOffline)
  expect(screen.getAllByText(zh.h3CanonicalRequirementUnchecked)).toHaveLength(4)
  expect(f.transport.save).not.toHaveBeenCalled()
  expect(f.transport.start).not.toHaveBeenCalled()
  expect(f.transport.draft).not.toHaveBeenCalled()
})

it('keeps an uncertain trial blocked without another start command', async () => {
  const f = fixture()
  await screen.findByText(zh.h3CanonicalSaved)
  const unknown = { operationId: firstId, revision: 1, sample: 1, state: 'unknown',
    code: 'H3_CANONICAL_TRIAL_UNKNOWN', startedAt: 100 } as const
  f.setCurrent({ ...f.current(), state: 'unknown', code: unknown.code, samples: [unknown] })
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
  await screen.findByText(zh.h3CanonicalUnknown)
  expect(screen.getByRole('button', { name: zh.h3CanonicalRunFirst }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.h3SetupRefresh }))
  await waitFor(() => { expect(f.transport.inspect).toHaveBeenCalledTimes(3) })
  expect(f.transport.start).not.toHaveBeenCalled()
  expect(f.transport.draft).not.toHaveBeenCalled()
})

it('drops a late native file result after the transport scope changes', async () => {
  const f = fixture(false)
  const pending = Promise.withResolvers<string | null>()
  const chooser = vi.fn(() => pending.promise)
  f.view.rerender(<H3CanonicalOwnerWizard transport={f.transport} t={t} chooseFile={chooser} />)
  await waitFor(() => { expect(f.transport.inspect).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: `${zh.h3SetupChoose} · ${zh.h3SetupFirstFrame}` }))
  const next = { ...f.transport }
  f.view.rerender(<H3CanonicalOwnerWizard transport={next} t={t} chooseFile={chooser} />)
  await waitFor(() => { expect(next.inspect).toHaveBeenCalledTimes(2) })
  await act(async () => { pending.resolve('C:\\private-owner-a\\old.png'); await pending.promise })
  expect(screen.queryByText('old.png')).toBeNull()
  expect(f.transport.save).not.toHaveBeenCalled()
})
