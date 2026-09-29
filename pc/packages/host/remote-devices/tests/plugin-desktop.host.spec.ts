/** Electron desktop has no webServer; the coordinator must still provide remoteDevices. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import { apply, inject, name } from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

describe('remote-devices on desktop', () => {
  it('inject does not wait for webServer', () => {
    expect([...inject]).toEqual(['connection', 'agents', 'jobs'])
  })

  it('provides remoteDevices when webServer is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-remote-desktop-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    cleanup.push(async () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    })
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    const agents = ctx.plugin(AgentRegistry); await agents
    cleanup.push(() => agents.dispose())
    const jobs = ctx.plugin(LocalJobRegistry); await jobs
    cleanup.push(() => jobs.dispose())
    const connection = ctx.plugin(Connection); await connection
    cleanup.push(() => connection.dispose())
    const plugin = ctx.plugin({ name, inject, apply }); await plugin
    cleanup.push(() => plugin.dispose())
    expect(ctx.remoteDevices.devices()).toEqual([])
  })
})
