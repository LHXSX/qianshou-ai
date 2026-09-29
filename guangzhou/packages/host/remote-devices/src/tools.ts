/** Per-preset remote task tools use the real coordinator and retain companion-side approval. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JOB_KINDS, textField } from './protocol.ts'
import type {} from './service.ts'

export const name = 'qianshou-remote-device-tools'
export const inject = ['tools', 'remoteDevices']

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Register only in an explicitly selected preset scope; Host availability grants no model tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'remote_device_list',
    description: 'List actual paired remote devices, connectivity, and locally approved workspace IDs. Call before remote work. No device means the user must pair one in the device UI. Never invent a connection or request credentials.',
    parameters: {}, output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) { exec.signal.throwIfAborted(); return JSON.stringify({ devices: ctx.remoteDevices.devices() }) },
    presentCall: () => ({ card: 'generic', title: '列出协作设备', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'remote_task_submit',
    description: 'Submit a task to a real connected device and approved workspace returned by remote_device_list. The task is queued for explicit approval on that device; accepted does NOT mean executed. Use command for shell/tests (local-user permissions, not an OS sandbox), read/write/list for relative workspace paths, or desktop to ask the device to open installed RustDesk. Pairing and credentials remain user UI actions. Read completion with remote_task_status; do not resubmit the same job while approval is pending.',
    parameters: {
      device_id: { type: 'string', required: true },
      workspace_id: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: [...JOB_KINDS] },
      command: { type: 'string', description: 'Complete shell command, required only for command tasks.' },
      path: { type: 'string', description: 'Relative path within the approved workspace, required for read/write/list.' },
      content: { type: 'string', description: 'Complete UTF-8 file content, required for write.' },
    }, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const payload = { ...(args.command !== undefined ? { command: args.command } : {}), ...(args.path !== undefined ? { path: args.path } : {}), ...(args.content !== undefined ? { content: args.content } : {}) }
      const job = await ctx.remoteDevices.submit({ deviceId: args.device_id, workspaceId: args.workspace_id, kind: args.kind, payload })
      return JSON.stringify({ jobId: job.id, deviceId: job.deviceId, status: job.status, requiresLocalApproval: true })
    },
    presentCall: args => ({ card: 'generic', title: '提交远程任务 · 等待对端确认', kind: 'execute', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'remote_task_status',
    description: 'Read a remote task status and a bounded page of its JSON output/result/error. Awaiting-approval is pending local human action, not completion. Terminal states are completed, failed, rejected, cancelled, or interrupted. Use nextOffset to retrieve another result page. Avoid rapid polling; continue independent local work between status checks.',
    parameters: { job_id: { type: 'string', required: true }, offset: { type: 'integer', description: 'Zero-based character offset in serialized receipt; default 0.' }, limit: { type: 'integer', description: 'Characters in the receipt page; default 12000, maximum 50000.' } }, output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const job = ctx.remoteDevices.task(textField(args.job_id, 100))
      if (!job) throw new Error('JOB_NOT_FOUND')
      const offset = args.offset ?? 0
      const limit = args.limit ?? 12_000
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) throw new Error('INVALID_RESULT_PAGE')
      const receipt = JSON.stringify({ output: job.output, result: job.result, error: job.error })
      const end = Math.min(receipt.length, offset + limit)
      return JSON.stringify({ jobId: job.id, status: job.status, updatedAt: job.updatedAt, cancelRequested: job.cancelRequested ?? false, offset, nextOffset: end < receipt.length ? end : null, totalChars: receipt.length, receiptJson: receipt.slice(offset, end) })
    },
    presentCall: args => ({ card: 'generic', title: '读取远程任务结果', kind: 'read', rawInput: args.job_id }),
  }))
  ctx.tools.register(defineTool({
    name: 'remote_task_cancel',
    description: 'Request cancellation of a pending or running remote task. Accepted means the request was recorded; verify cancelled/interrupted/other terminal status with remote_task_status. Does not revoke or delete the device.',
    parameters: { job_id: { type: 'string', required: true } }, output,
    async execute(args, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await ctx.remoteDevices.cancel(textField(args.job_id, 100))) },
    presentCall: args => ({ card: 'generic', title: '取消远程任务', kind: 'execute', rawInput: args.job_id }),
  }))
}
