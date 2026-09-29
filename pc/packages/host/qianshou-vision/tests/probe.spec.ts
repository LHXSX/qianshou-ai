/** Each vision fact is read from the component that owns it and never inferred from the others. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { permissionsOf } from '../src/probe.ts'
import { fixture, PROBE, PROVIDER } from './support.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('driver assembly fact', () => {
  it('reports an absent service, a service without a provider, and a registered provider distinctly', async () => {
    const absent = await fixture({ driver: 'absent' }, contexts)
    expect((await absent.vision.state()).driver).toEqual({ state: 'absent', provider: null, probeTool: null })
    const service = await fixture({ driver: 'service' }, contexts)
    expect((await service.vision.state()).driver).toEqual({ state: 'service-only', provider: null, probeTool: null })
    const registered = await fixture({}, contexts)
    expect((await registered.vision.state()).driver).toEqual({ state: 'registered', provider: PROVIDER, probeTool: PROBE })
  })

  it('names no probe tool when the registered provider publishes none, and never guesses from other tools', async () => {
    const other = await fixture({ probe: 'cua_driver_native__click' }, contexts)
    const driver = (await other.vision.state()).driver
    expect(driver).toEqual({ state: 'registered', provider: PROVIDER, probeTool: null })
  })

  it.each([
    ['cua_driver_native__check_permissions', 'the native provider prefix'],
    ['mcp__cua-driver-mcp__check_permissions', 'the MCP provider prefix'],
    ['check_permissions', 'an unprefixed provider tool'],
  ])('accepts %s (%s)', async (name) => {
    const f = await fixture({ probe: name }, contexts)
    expect((await f.vision.state()).driver.probeTool).toBe(name)
  })

  it.each(['check_permissions_v2', 'recheck_permissions_now', 'permissions_check'])('rejects %s', async (name) => {
    const f = await fixture({ probe: name }, contexts)
    expect((await f.vision.state()).driver.probeTool).toBeNull()
  })

  it('reports the service without a provider after the registration is released', async () => {
    const f = await fixture({ driver: 'service' }, contexts)
    const release = f.ctx.computerUse.register(PROVIDER)
    expect((await f.vision.state()).driver.state).toBe('registered')
    await release()
    expect((await f.vision.state()).driver).toEqual({ state: 'service-only', provider: null, probeTool: null })
  })
})

describe('permission probe decoding', () => {
  it.each([
    [{ structuredContent: { accessibility: true, screen_recording: true } }, { accessibility: true, screenRecording: true }],
    [{ structuredContent: { accessibility: false, screen_recording: true } }, { accessibility: false, screenRecording: true }],
    [{ structuredContent: { accessibility: true, screen_recording: false, extra: 'ignored' } }, { accessibility: true, screenRecording: false }],
  ])('reads both grants from %j', (value, expected) => {
    expect(permissionsOf(value)).toEqual(expected)
  })

  it.each([
    ['no structured content', { content: [{ type: 'text', text: 'Desktop permissions granted.' }] }],
    ['structured content that is an array', { structuredContent: [{ accessibility: true, screen_recording: true }] }],
    ['a missing grant', { structuredContent: { accessibility: true } }],
    ['a non-boolean grant', { structuredContent: { accessibility: 'yes', screen_recording: true } }],
    ['a null grant', { structuredContent: { accessibility: null, screen_recording: false } }],
    ['a top-level array', [{ structuredContent: { accessibility: true, screen_recording: true } }]],
    ['null', null],
    ['a string', 'granted'],
  ])('refuses to read %s', (_label, value) => {
    expect(permissionsOf(value)).toBeUndefined()
  })
})

describe('permission fact', () => {
  it('reports granted only when both grants are true', async () => {
    const f = await fixture({ behavior: { value: { structuredContent: { accessibility: true, screen_recording: true } } } }, contexts)
    expect((await f.vision.state()).permissions)
      .toEqual({ state: 'granted', accessibility: true, screenRecording: true, reason: null })
  })

  it.each([
    [true, false],
    [false, true],
    [false, false],
  ])('reports missing for accessibility=%s screenRecording=%s', async (accessibility, screenRecording) => {
    const f = await fixture({ behavior: { value: { structuredContent: { accessibility, screen_recording: screenRecording } } } }, contexts)
    expect((await f.vision.state()).permissions)
      .toEqual({ state: 'missing', accessibility, screenRecording, reason: null })
  })

  it.each([
    ['absent', 'no-provider'],
    ['service', 'no-provider'],
  ] as const)('reports %s driver as unknown/%s without calling any tool', async (driver, reason) => {
    const f = await fixture({ driver }, contexts)
    expect((await f.vision.state()).permissions)
      .toEqual({ state: 'unknown', accessibility: null, screenRecording: null, reason })
    expect(f.calls).toEqual([])
  })

  it('reports no-probe-tool when the provider publishes no probe', async () => {
    const f = await fixture({ probe: null }, contexts)
    expect((await f.vision.state()).permissions.reason).toBe('no-probe-tool')
    expect(f.calls).toEqual([])
  })

  it('reports probe-failed when the probe itself fails', async () => {
    const f = await fixture({ behavior: { throws: 'driver not installed' } }, contexts)
    expect((await f.vision.state()).permissions)
      .toEqual({ state: 'unknown', accessibility: null, screenRecording: null, reason: 'probe-failed' })
    expect(f.calls).toHaveLength(1)
  })

  it('reports unrecognized-result when the probe answers without the two booleans', async () => {
    const f = await fixture({ behavior: { value: { content: [{ type: 'text', text: 'granted' }] } } }, contexts)
    expect((await f.vision.state()).permissions.reason).toBe('unrecognized-result')
  })

  it('reads status without prompting and stages a request that never adds direct capture', async () => {
    const granted = { structuredContent: { accessibility: true, screen_recording: true } }
    const f = await fixture({ behavior: { value: granted } }, contexts)
    await f.vision.state()
    await f.vision.requestPermissions()
    expect(f.calls).toEqual([
      { prompt: false, probeDirectCapture: undefined },
      { prompt: true, probeDirectCapture: false },
    ])
  })
})

describe('model route fact', () => {
  it('reports image acceptance from the modalities the adapter discloses', async () => {
    const f = await fixture({ answer: { modalities: ['text', 'image'] } }, contexts)
    expect((await f.vision.state()).route).toEqual({
      provider: 'route-provider', model: 'route-model', inputModalities: ['text', 'image'], acceptsImage: true, reason: null,
    })
  })

  it('reports a text-only route as not accepting images, with no reason', async () => {
    const f = await fixture({ answer: { modalities: ['text'] } }, contexts)
    expect((await f.vision.state()).route)
      .toMatchObject({ inputModalities: ['text'], acceptsImage: false, reason: null })
  })

  it('reports no-default-model without naming a route', async () => {
    const f = await fixture({ route: null }, contexts)
    expect((await f.vision.state()).route).toEqual({
      provider: null, model: null, inputModalities: null, acceptsImage: null, reason: 'no-default-model',
    })
  })

  it('keeps the route identity while reporting it unresolvable', async () => {
    const f = await fixture({ answer: { throws: 'unknown model' } }, contexts)
    expect((await f.vision.state()).route).toEqual({
      provider: 'route-provider', model: 'route-model', inputModalities: null, acceptsImage: null, reason: 'unresolvable',
    })
  })

  it('reports an unregistered provider as unresolvable', async () => {
    const f = await fixture({ registered: [] }, contexts)
    expect((await f.vision.state()).route).toMatchObject({ provider: 'route-provider', reason: 'unresolvable' })
  })

  it('separates undisclosed modalities from an empty disclosure', async () => {
    const undisclosed = await fixture({ answer: { undisclosed: true } }, contexts)
    expect((await undisclosed.vision.state()).route)
      .toMatchObject({ inputModalities: null, acceptsImage: null, reason: 'modalities-undisclosed' })
    const empty = await fixture({ answer: { modalities: [] } }, contexts)
    expect((await empty.vision.state()).route)
      .toMatchObject({ inputModalities: [], acceptsImage: false, reason: null })
  })
})
