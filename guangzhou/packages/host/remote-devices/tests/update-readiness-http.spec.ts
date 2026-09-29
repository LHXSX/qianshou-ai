/** Real loopback HTTP exercises Connection's cookie fence and the production maintenance routes. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import { DeviceCoordinator } from '../src/coordinator.ts'
import { registerUpdateReadiness } from '../src/update-readiness.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

describe('authenticated update routes', () => {
  it('requires cookie auth for every operation, rejects malformed requests, blocks jobs and releases on plugin unload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-update-http-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await web
    cleanup.push(() => web.dispose())
    const agents = ctx.plugin(AgentRegistry); await agents
    cleanup.push(() => agents.dispose())
    const jobs = ctx.plugin(LocalJobRegistry); await jobs
    cleanup.push(() => jobs.dispose())
    ctx.jobs.attachController('update-http-test')
    const connection = ctx.plugin(Connection); await connection
    cleanup.push(() => connection.dispose())
    const coordinator = await DeviceCoordinator.open(join(root, 'devices.json'))
    cleanup.push(() => coordinator.close())
    const plugin = ctx.plugin({ inject: ['connection', 'agents', 'jobs'], apply: (inner: Context) => { registerUpdateReadiness(inner, coordinator) } }); await plugin
    cleanup.push(() => plugin.dispose())
    ctx.webServer.register({ kind: 'exact', path: '/', handler: (request, response) => {
      if (!ctx.connection.authorizeIndex(request, response)) return
      response.writeHead(200); response.end('authenticated')
    } })
    const origin = `http://127.0.0.1:${ctx.webServer.port}`
    const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeDefined()
    const request = (suffix: string, body?: unknown, authorized = true) => fetch(`${origin}/api/qianshou/update-${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authorized ? { cookie: cookie! } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const suffix of ['readiness', 'prepare', 'commit', 'cancel']) {
      expect((await request(suffix, suffix === 'readiness' ? undefined : {}, false)).status).toBe(401)
    }
    const readiness = await request('readiness')
    expect(readiness.headers.get('cache-control')).toContain('no-store')
    expect(await readiness.json()).toMatchObject({ ready: true, busy: { agents: 0, jobs: 0, remoteJobs: 0, admissions: 0 } })
    expect((await request('prepare', [])).status).toBe(400)
    expect((await request('commit', {})).status).toBe(400)
    const prepared = await request('prepare', {})
    expect(prepared.status).toBe(201)
    const lease = await prepared.json() as { leaseId: string; expiresAt: number }
    const done = Promise.withResolvers<{ status: 'completed'; output: string }>()
    let started = 0
    const start = () => ctx.jobs.start({ kind: 'bash', label: 'local fixture', run: () => {
      started++
      return { done: done.promise, cancel: () => {} }
    } })
    expect(start).toThrow('本次输入未提交')
    expect(started).toBe(0)
    expect((await request('commit', { leaseId: lease.leaseId })).status).toBe(200)
    expect((await request('prepare', {})).status).toBe(409)
    await plugin.dispose()
    expect((await request('readiness')).status).toBe(404)
    expect(start).not.toThrow()
    expect(started).toBe(1)
    done.resolve({ status: 'completed', output: 'ok' })
    await expect.poll(() => ctx.jobs.activeCount).toBe(0)
  })
})
