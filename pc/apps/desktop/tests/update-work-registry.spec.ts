import { Context } from '@deepseek-ai/cordis'
import { WorkAdmission, updateWorkOf, UpdateWorkRegistry } from '../../../packages/core/agent/src/index.ts'
import { installDesktopUpdateTaskControl } from '../../desktop-host/src/update-tasks.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { ImageTrialHost } from '../../../packages/host/compute-core/src/image-trial.ts'

describe('external work installation protection', () => {
  it('closes every producer before inspecting and leaves original reads available', async () => {
    const registry = new UpdateWorkRegistry(); const gates: boolean[] = []
    registry.register({ setLocked: (value) => { gates[0] = value }, inspect: () => { expect(gates).toEqual([true, true]); return 'idle' } })
    registry.register({ setLocked: (value) => { gates[1] = value }, inspect: () => 'idle' })
    expect(await registry.control('lock')).toBe(false)
    await registry.control('unlock'); expect(gates).toEqual([false, false])
  })
  it.each(['busy', 'unknown'] as const)('refuses %s original work without stopping or replaying it', async (state) => {
    const registry = new UpdateWorkRegistry(); const stopped = vi.fn(); let locked = false
    registry.register({ setLocked: (value) => { locked = value }, inspect: () => state })
    await expect(registry.control('lock')).rejects.toThrow(state === 'busy' ? 'DESKTOP_UPDATE_WORK_BUSY' : 'DESKTOP_UPDATE_WORK_UNKNOWN')
    expect(locked).toBe(true); expect(stopped).not.toHaveBeenCalled()
    await registry.control('unlock'); expect(locked).toBe(false)
  })
  it('refuses a registration or unlock race while an original inspection awaits', async () => {
    for (const mutate of ['register', 'unlock']) {
      const registry = new UpdateWorkRegistry(); const observed = Promise.withResolvers<'idle'>()
      registry.register({ setLocked: () => {}, inspect: () => observed.promise })
      const pending = registry.control('lock')
      if (mutate === 'register') registry.register({ setLocked: () => {}, inspect: () => 'idle' })
      else await registry.control('unlock')
      observed.resolve('idle'); await expect(pending).rejects.toThrow('DESKTOP_UPDATE_WORK_CHANGED')
    }
  })
  it('maps a private reader failure to a finite unknown code', async () => {
    const registry = new UpdateWorkRegistry()
    registry.register({ setLocked: () => {}, inspect: () => { throw new Error('/private/path?token=fixture') } })
    await expect(registry.control('lock')).rejects.toThrow(/^DESKTOP_UPDATE_WORK_UNKNOWN$/u)
  })
  it('locks actual agent/job admission while keeping GET polling and delivery admitted', async () => {
    const ctx = new Context(); const agentAdmission = new WorkAdmission(); const jobAdmission = new WorkAdmission()
    ctx.provide('agents', { list: () => [], admission: agentAdmission } as unknown as Context['agents'])
    ctx.provide('jobs', { list: () => [], admission: jobAdmission } as unknown as Context['jobs'])
    const inspect = installDesktopUpdateTaskControl(ctx)
    const request = async (method: string) => {
      const incoming = Readable.from([]) as unknown as IncomingMessage; incoming.method = method
      const response = { writeHead: vi.fn(), end: vi.fn() }; const next = vi.fn(async () => {})
      await ctx.waterfall('connection/request', incoming, response as unknown as ServerResponse, next)
      return { response, next }
    }
    try {
      expect(await inspect('lock')).toBe(false)
      expect(() => agentAdmission.acquire()).toThrow('DESKTOP_UPDATE_IN_PROGRESS')
      expect(() => jobAdmission.acquire()).toThrow('DESKTOP_UPDATE_IN_PROGRESS')
      expect((await request('GET')).next).toHaveBeenCalledOnce()
      expect((await request('POST')).response.writeHead).toHaveBeenCalledWith(503)
      await inspect('unlock'); agentAdmission.acquire()(); jobAdmission.acquire()()
    } finally { await ctx.fiber.dispose() }
  })
  it('protects a real detached image HTTP operation, with one upstream POST and no history replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qianshou-update-image-'))
    const entered = Promise.withResolvers<undefined>(); const finish = Promise.withResolvers<undefined>(); let posts = 0
    const server = createServer((request, response) => { request.resume(); posts++; entered.resolve(undefined)
      void finish.promise.then(() => { response.writeHead(503); response.end() }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener unavailable')
    process.env.QIANSHOU_UPDATE_FIXTURE_TOKEN = 'fixture-only'
    const host = new ImageTrialHost({ gatewayOrigin: 'http://127.0.0.1:' + address.port,
      tokenEnv: 'QIANSHOU_UPDATE_FIXTURE_TOKEN', timeoutMs: 360000 }, directory, { maxRecords: 10, maxStoreBytes: 65536 })
    const registry = updateWorkOf({})
    registry.register({ setLocked: value => host.setUpdateLocked(value), inspect: () => host.updateState() })
    const input = { id: '66557788-1234-4234-8234-123456789012', sessionId: 'fixture-session', prompt: 'fixture only', size: 'landscape' }
    try {
      await host.submit(input, () => true); await entered.promise
      expect(await registry.control('inspect')).toBe(true)
      await expect(registry.control('lock')).rejects.toThrow('DESKTOP_UPDATE_WORK_BUSY')
      await expect(host.submit({ ...input, id: '66557788-1234-4234-8234-123456789013' }, () => true))
        .rejects.toThrow('IMAGE_TRIAL_UPDATE_IN_PROGRESS')
      expect((await host.job(input.id, input.sessionId)).status).toBe('running'); expect(posts).toBe(1)
      finish.resolve(undefined); await host.close(); expect(await host.updateState()).toBe('idle'); expect(posts).toBe(1)
    } finally { finish.resolve(undefined); await host.close(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      delete process.env.QIANSHOU_UPDATE_FIXTURE_TOKEN; await rm(directory, { recursive: true, force: true }) }
  })
})
