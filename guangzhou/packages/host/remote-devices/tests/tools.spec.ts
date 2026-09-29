/** Exercise the actual tool registry; transport/executor ownership is covered by duplex.spec.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as RemoteTools from '../src/tools.ts'
import type { DeviceId, JobId, RemoteJob, WorkspaceId } from '../src/protocol.ts'

let ctx: Context
let stop: () => Promise<void>
let job: RemoteJob
const submit = vi.fn<(value: unknown) => Promise<RemoteJob>>()
const cancel = vi.fn<(id: string) => Promise<{ accepted: true }>>()
beforeEach(async () => {
  ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt)
  const runtime = await ctx.plugin(ToolRuntime)
  stop = async () => { await runtime.dispose(); await prompt.dispose() }
  job = { id: 'job' as JobId, deviceId: 'device' as DeviceId, workspaceId: 'workspace' as WorkspaceId, kind: 'list', payload: { path: '.' }, status: 'awaiting-approval', output: '', createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z' }
  submit.mockReset().mockImplementation(async () => job)
  cancel.mockReset().mockResolvedValue({ accepted: true })
  ctx.provide('remoteDevices', { devices: () => [], submit, task: (id: string) => id === job.id ? structuredClone(job) : undefined, cancel })
})
afterEach(async () => { await stop() })
const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('call'), name, arguments: args })
async function parsed(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await call(name, args)
  expect(result.isError).not.toBe(true)
  const content = result.content.find(block => block.type === 'text')
  if (content?.type !== 'text') throw new Error('MISSING_TOOL_TEXT')
  return JSON.parse(content.text) as Record<string, unknown>
}

describe('scoped remote-device tools', () => {
  it('requires explicit tool-plugin registration and exposes no pairing or credential capability', async () => {
    expect(ctx.tools.get('remote_device_list')).toBeUndefined()
    const plugin = await ctx.plugin(RemoteTools)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('remote_')).map(tool => tool.name)).toEqual(['remote_device_list', 'remote_task_submit', 'remote_task_status', 'remote_task_cancel'])
    expect(await parsed('remote_device_list', {})).toEqual({ devices: [] })
    expect(ctx.tools.get('remote_device_pair')).toBeUndefined()
    await plugin.dispose()
    expect(ctx.tools.get('remote_device_list')).toBeUndefined()
  })
  it('submits real IDs and reports pending approval rather than completion', async () => {
    await ctx.plugin(RemoteTools)
    expect(await parsed('remote_task_submit', { device_id: 'device', workspace_id: 'workspace', kind: 'write', path: 'result.txt', content: 'contents' })).toMatchObject({ jobId: 'job', status: 'awaiting-approval', requiresLocalApproval: true })
    expect(submit).toHaveBeenCalledWith({ deviceId: 'device', workspaceId: 'workspace', kind: 'write', payload: { path: 'result.txt', content: 'contents' } })
  })
  it('pages output and preserves cancellation as a request', async () => {
    await ctx.plugin(RemoteTools)
    job.status = 'completed'; job.output = 'x'.repeat(400)
    const first = await parsed('remote_task_status', { job_id: 'job', limit: 80 })
    expect(first).toMatchObject({ jobId: 'job', status: 'completed', offset: 0, nextOffset: 80 })
    const second = await parsed('remote_task_status', { job_id: 'job', offset: 80, limit: 80 })
    expect(second).toMatchObject({ offset: 80, nextOffset: 160 })
    expect(await parsed('remote_task_cancel', { job_id: 'job' })).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith('job')
    expect((await call('remote_task_status', { job_id: 'missing' })).isError).toBe(true)
    expect((await call('remote_task_status', { job_id: 'job', offset: -1 })).isError).toBe(true)
  })
})
