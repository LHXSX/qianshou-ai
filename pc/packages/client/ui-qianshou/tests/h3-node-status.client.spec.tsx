// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { NodeStatusPanel } from '../src/client/node-status/NodeStatusPanel.tsx'
import { h3VideoStatusKey } from '../src/client/node-status/h3-status-copy.ts'
import { h3TrialBlocksIntake, parseH3VideoStatus } from '../src/client/node-status/h3-status.ts'
import { zh } from '../src/client/node-status/locales.ts'
import { createHttpNodeTransport } from '../src/client/node-status/transport.ts'
import { parseNodeStatus } from '../src/client/node-status/types.ts'
import { onlineSnapshot } from './fixtures/node-status.fixture.ts'

const controllers: NodeStatusController[] = []
afterEach(() => {
  cleanup()
  for (const controller of controllers.splice(0)) controller.dispose()
})

function localStatus(code: string, ready = false) {
  return { configured: true, ready, code }
}

function httpPanel(initial: Record<string, unknown>) {
  let payload = initial
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (init?.method !== 'GET') throw new Error('The H3 status panel must only read')
    if (url.pathname === '/api/qianshou/node/status') return Response.json(payload)
    if (url.pathname === '/api/qianshou/node/power') {
      return Response.json({ running: true, managed: true, mode: 'paused' })
    }
    throw new Error('Unexpected status route')
  })
  const transport = createHttpNodeTransport({ baseUrl: 'https://host.invalid/api/qianshou/node/', fetchImpl })
  const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
  controllers.push(controller)
  const view = render(<NodeStatusPanel controller={controller} t={makeTranslate(zh)} diagnosticsOnly />)
  return { controller, view, fetchImpl, setPayload: (next: Record<string, unknown>) => { payload = next } }
}

describe('local H3 status contract', () => {
  it.each([
    'H3_SETUP_SELF_TEST_PENDING', 'H3_SETUP_SELF_TEST_UNKNOWN',
    'H3_SETUP_SELF_TEST_UNSETTLED', 'H3_SETUP_TRIAL_GUARD_INVALID',
  ])('preserves the unconfigured fact for %s while refusing readiness', (code) => {
    const evidence = { configured: false, ready: false, code }
    expect(parseH3VideoStatus(evidence)).toEqual(evidence)
    expect(h3TrialBlocksIntake(evidence)).toBe(true)
    expect(parseH3VideoStatus({ ...evidence, ready: true })).toBeNull()
    expect(parseH3VideoStatus({ ...evidence, code: 'H3_NEW_UNKNOWN_FAILURE' })).toBeNull()
  })
  it.each([
    null,
    [],
    { configured: 'true', ready: true, code: 'H3_REAL_SELF_TEST_VERIFIED' },
    { configured: true, ready: 'true', code: 'H3_REAL_SELF_TEST_VERIFIED' },
    { configured: true, ready: true, code: 1 },
    localStatus('H3_NOT_CHECKED', true),
    localStatus('H3_REAL_SELF_TEST_VERIFIED'),
    localStatus('H3_V2_REAL_SELF_TEST_VERIFIED'),
    localStatus('H3_V2_REAL_SELF_TEST_REQUIRED', true),
    { configured: false, ready: true, code: 'H3_REAL_SELF_TEST_VERIFIED' },
    localStatus('H3_OWNER_CONFIG_NOT_CONFIGURED'),
    localStatus('H3_FAILURE /private/author/model.bin'),
    localStatus(`H3_${'A'.repeat(77)}`),
    { ...localStatus('H3_REAL_SELF_TEST_VERIFIED', true), platformApproved: true },
  ])('isolates malformed or contradictory evidence %# from the valid node record', (h3Video) => {
    const original = onlineSnapshot()
    const parsed = parseNodeStatus({ ...original, h3Video })
    expect(parsed).not.toBeNull()
    expect(parsed?.connection).toEqual(original.connection)
    expect(parsed?.counters).toEqual(original.counters)
    expect(parsed?.current).toEqual(original.current)
    expect(parsed?.h3Video).toBeUndefined()
    expect(parseH3VideoStatus(h3Video)).toBeNull()
  })

  it.each(['H3_REAL_SELF_TEST_VERIFIED', 'H3_V2_REAL_SELF_TEST_VERIFIED'])(
    'accepts the exact Host readiness extension %s without adding approval evidence', (code) => {
      const value = localStatus(code, true)
      expect(parseNodeStatus({ ...onlineSnapshot(), h3Video: value })?.h3Video).toEqual(value)
      expect(parseH3VideoStatus({ configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' }))
        .toEqual({ configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' })
    })

  it.each([
    ['H3_NOT_CHECKED', 'h3PreflightPending'],
    ['H3_REAL_SELF_TEST_REQUIRED', 'h3PreflightTrialRequired'],
    ['H3_V2_REAL_SELF_TEST_REQUIRED', 'h3PreflightTrialRequired'],
    ['H3_V2_OWNER_CONFIG_REQUIRED', 'h3PreflightConfigurationInvalid'],
    ['H3_EXECUTION_IDENTITY_CHANGED', 'h3PreflightBindingChanged'],
    ['H3_NATIVE_SELF_TEST_CHANGED', 'h3PreflightBindingChanged'],
    ['H3_ADAPTER_UNAVAILABLE', 'h3PreflightAdapterUnavailable'],
    ['H3_OWNER_MODEL_NOT_INSTALLED', 'h3PreflightModelMissing'],
    ['H3_OWNER_CONFIG_INVALID', 'h3PreflightConfigurationInvalid'],
    ['H3_LOCAL_OUTPUT_INVALID', 'h3PreflightOutputInvalid'],
    ['H3_SETUP_SELF_TEST_PENDING', 'h3SetupUnsettled'],
    ['H3_SETUP_SELF_TEST_UNKNOWN', 'h3SetupUnsettled'],
    ['H3_SETUP_SELF_TEST_UNSETTLED', 'h3SetupUnsettled'],
    ['H3_SETUP_TRIAL_GUARD_INVALID', 'h3SetupRecordNeedsCheck'],
    ['H3_NEW_UNKNOWN_FAILURE', 'h3PreflightFailed'],
  ])('uses bounded copy for %s', (code, key) => {
    const parsed = parseH3VideoStatus(localStatus(code))
    if (parsed === null) throw new Error('Expected a valid failed preflight fixture')
    expect(h3VideoStatusKey(parsed)).toBe(key)
  })
})

describe('H3 node details through the actual HTTP reader and controller', () => {
  it.each([
    ['H3_SETUP_SELF_TEST_PENDING', zh.h3SetupUnsettled],
    ['H3_SETUP_SELF_TEST_UNKNOWN', zh.h3SetupUnsettled],
    ['H3_SETUP_TRIAL_GUARD_INVALID', zh.h3SetupRecordNeedsCheck],
  ])('keeps unresolved trial admission %s unverified with bounded Chinese copy', async (code, message) => {
    const f = httpPanel({ ...onlineSnapshot(), h3Video: { configured: false, ready: false, code } })
    await act(async () => { await f.controller.poll() })
    const block = f.view.container.querySelector('[data-node-h3-preflight="not-ready"]')
    expect(block?.textContent).toContain(message)
    expect(block?.textContent).not.toContain(code)
    expect(block?.textContent).not.toContain('本机预检已通过')
    expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it.each([
    {},
    { h3Video: { configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' } },
  ])('keeps old Hosts and unconfigured Macs compact %#', async (extension) => {
    const f = httpPanel({ ...onlineSnapshot(), ...extension })
    await act(async () => { await f.controller.poll() })
    expect(f.view.container.querySelector('[data-node-h3-preflight]')).toBeNull()
    expect(f.view.getByText('已连接')).toBeTruthy()
    expect(f.view.container.querySelector('[data-node-connection]')).toHaveProperty('dataset.nodeConnection', 'online')
    expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it.each(['H3_REAL_SELF_TEST_VERIFIED', 'H3_V2_REAL_SELF_TEST_VERIFIED'])(
    'reports local success for %s while preserving the actual paused connection and permission boundaries', async (code) => {
      const original = onlineSnapshot()
      const f = httpPanel({ ...original, current: null, tasks: [],
        connection: { state: 'online', reason: null, core: 'https://qianshousuanli.com',
          workerId: 'actual-worker-fixture', ownerId: 167, mode: 'paused', onlineSince: null, onlineSeconds: null },
        h3Video: localStatus(code, true) })
      await act(async () => { await f.controller.poll() })
      const block = f.view.container.querySelector('[data-node-h3-preflight="passed"]')
      expect(block?.textContent).toContain('本机预检已通过')
      expect(block?.textContent).toContain('平台审核、当前设备双样单核验和接单授权仍需分别确认')
      expect(block?.querySelector('button,input')).toBeNull()
      expect(f.view.getByText('actual-worker-fixture')).toBeTruthy()
      expect(f.view.getByText('已暂停')).toBeTruthy()
      expect(f.view.container.querySelector('[data-node-phase="standby"]')).toBeTruthy()
      expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
    })

  it('does not leak unknown error details or stop node rendering, and accepts the next valid poll', async () => {
    const f = httpPanel({ ...onlineSnapshot(), h3Video: localStatus('H3_NEW_UNKNOWN_FAILURE') })
    await act(async () => { await f.controller.poll() })
    expect(f.view.container.querySelector('[data-node-h3-preflight="not-ready"]')?.textContent)
      .toContain('本机预检未通过，请检查本机配置和试片。')
    expect(f.view.container.textContent).not.toContain('H3_NEW_UNKNOWN_FAILURE')
    f.setPayload({ ...onlineSnapshot(), h3Video: localStatus('H3_FAILURE /private/author/model.bin', true) })
    await act(async () => { await f.controller.poll() })
    expect(f.view.container.querySelector('[data-node-h3-preflight]')).toBeNull()
    expect(f.view.container.textContent).not.toContain('/private/author')
    expect(f.view.getByText('已连接')).toBeTruthy()
    f.setPayload({ ...onlineSnapshot(), h3Video: localStatus('H3_REAL_SELF_TEST_VERIFIED', true) })
    await act(async () => { await f.controller.poll() })
    expect(f.view.container.querySelector('[data-node-h3-preflight="passed"]')?.textContent).toContain('本机预检已通过')
    expect(f.fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
})
