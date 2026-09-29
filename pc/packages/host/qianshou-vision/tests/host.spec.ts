/** The Remote surface reports status and requests grants without mounting, routing or granting anything. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import QianshouVision from '../src/index.ts'
import { fixture, PROBE, PROVIDER } from './support.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const GRANTED = { structuredContent: { accessibility: true, screen_recording: true } }

describe('vision status reads', () => {
  it('stamps this Host platform and the time of the read', async () => {
    const before = Date.now()
    const f = await fixture({}, contexts)
    const snapshot = await f.vision.state()
    expect(snapshot.platform).toBe(process.platform)
    expect(snapshot.checkedAt).toBeGreaterThanOrEqual(before)
    expect(snapshot.checkedAt).toBeLessThanOrEqual(Date.now())
  })

  it('keeps the three facts independent: granted desktop, unusable route', async () => {
    const f = await fixture({ behavior: { value: GRANTED }, route: null }, contexts)
    const snapshot = await f.vision.state()
    expect(snapshot.permissions.state).toBe('granted')
    expect(snapshot.route.reason).toBe('no-default-model')
    expect(snapshot.driver.state).toBe('registered')
  })

  it('keeps the three facts independent: image route, no driver', async () => {
    const f = await fixture({ driver: 'absent', answer: { modalities: ['text', 'image'] } }, contexts)
    const snapshot = await f.vision.state()
    expect(snapshot.route.acceptsImage).toBe(true)
    expect(snapshot.driver.state).toBe('absent')
    expect(snapshot.permissions.reason).toBe('no-provider')
  })

  it('changes nothing it reads, across repeated reads and a request', async () => {
    const f = await fixture({ behavior: { value: GRANTED } }, contexts)
    const route = f.ctx.settings.get('agent-default-model')
    await f.vision.state()
    await f.vision.state()
    await f.vision.requestPermissions()
    expect(f.ctx.settings.get('agent-default-model')).toEqual(route)
    expect(f.ctx.computerUse.providerName).toBe(PROVIDER)
    expect(f.ctx.tools.schemas().map(schema => schema.name)).toEqual([PROBE])
  })

  it('requests grants without a provider by re-reading status only', async () => {
    const f = await fixture({ driver: 'absent' }, contexts)
    const snapshot = await f.vision.requestPermissions()
    expect(snapshot.permissions).toEqual({ state: 'unknown', accessibility: null, screenRecording: null, reason: 'no-provider' })
    expect(f.ctx.get('computerUse')).toBeUndefined()
    expect(f.calls).toEqual([])
  })
})

describe('read deadline', () => {
  it('defaults to fifteen seconds and rejects a deadline outside the accepted range', () => {
    expect(QianshouVision.Config({}).probeTimeoutMs).toBe(15000)
    expect(QianshouVision.Config({ probeTimeoutMs: 2000 }).probeTimeoutMs).toBe(2000)
    expect(() => QianshouVision.Config({ probeTimeoutMs: 999 })).toThrow()
    expect(() => QianshouVision.Config({ probeTimeoutMs: 120001 })).toThrow()
    expect(() => QianshouVision.Config({ probeTimeoutMs: 1500.5 })).toThrow()
  })

  it('ends a probe that never answers and still reports the other two facts', async () => {
    const f = await fixture({ behavior: { hangs: true }, answer: { modalities: ['image'] }, config: { probeTimeoutMs: 1000 } }, contexts)
    const snapshot = await f.vision.state()
    expect(snapshot.permissions.reason).toBe('probe-failed')
    expect(snapshot.driver.state).toBe('registered')
    expect(snapshot.route.acceptsImage).toBe(true)
  })

  it('ends a pending probe when the plugin is disposed while the components stay mounted', async () => {
    const f = await fixture({ behavior: { hangs: true }, config: { probeTimeoutMs: 120000 } }, contexts)
    const pending = f.vision.state()
    await expect.poll(() => f.calls.length).toBe(1)
    await f.fiber.dispose()
    expect((await pending).permissions.reason).toBe('probe-failed')
    expect(f.ctx.computerUse.providerName).toBe(PROVIDER)
  })
})
