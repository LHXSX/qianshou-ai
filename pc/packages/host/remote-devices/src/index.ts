/** Qianshou paired-device routes; browser auth remains owned by Connection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeviceCoordinator } from './coordinator.ts'
import { registerUpdateReadiness } from './update-readiness.ts'
import { registerCompanionDownloads } from './downloads.ts'
import { DEVICE_PATH, record, textField } from './protocol.ts'
import type {} from './service.ts'
export type { RemoteDevicesService } from './service.ts'

export const name = 'qianshou-remote-devices'
export const inject = ['connection', 'agents', 'jobs']

/** Register the controller's authenticated HTTP routes and native peer-only upgrade. */
export async function apply(ctx: Context): Promise<void> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  registerCompanionDownloads(ctx, join(home, 'qianshou', 'companion-downloads'))
  const coordinator = await DeviceCoordinator.open(join(home, 'qianshou', 'devices.json'))
  registerUpdateReadiness(ctx, coordinator)
  ctx.provide('remoteDevices', {
    devices: () => coordinator.snapshot().devices,
    submit: value => coordinator.submit(value),
    task: id => coordinator.snapshot().jobs.find(job => job.id === id),
    cancel: id => coordinator.cancel(id),
  })
  const response = (value: unknown, status = 200): Response => Response.json(value, {
    status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  })
  const routes: Array<{ path: string; method: 'GET' | 'POST'; handle: (request: Request) => unknown | Promise<unknown> }> = [
    { path: '/api/qianshou/devices', method: 'GET', handle: () => coordinator.snapshot() },
    { path: '/api/qianshou/pairings', method: 'POST', handle: () => coordinator.pairing() },
    { path: '/api/qianshou/jobs', method: 'POST', handle: async request => coordinator.submit(await request.json()) },
    { path: '/api/qianshou/job-cancel', method: 'POST', handle: async request => coordinator.cancel(textField(record(await request.json()).jobId, 100)) },
    { path: '/api/qianshou/device-revoke', method: 'POST', handle: async request => coordinator.revoke(textField(record(await request.json()).deviceId, 100)) },
  ]
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: route.path, methods: [route.method], requestBody: 'buffered',
    fetch: async request => {
      try { return response(await route.handle(request)) }
      catch (error) { return response({ error: error instanceof Error ? error.message : 'DEVICE_REQUEST_FAILED' }, 400) }
    },
  }), route.path)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.registerUpgrade({ path: DEVICE_PATH, handler: (request, socket, head) => coordinator.upgrade(request, socket, head) }), 'qianshou: device socket')
  })
  ctx.effect(() => () => coordinator.close(), 'qianshou: dispose devices')
}
