// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ComfyTrialRow, privateComfyReceipt, zh } from '../src/client/ComfyTrialRow.tsx'

type Props = Parameters<typeof ComfyTrialRow>[0]
const t: Props['t'] = makeTranslate(zh, commonZh)
const trialId = '12345678-1234-4123-8123-123456789abc'
const sha = 'a'.repeat(64)
const receipt = { trialId, status: 'completed', graphSha256: sha,
  result: { sha256: sha, bytes: 3, width: 256, height: 256 }, installable: false, dispatchable: false }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function block(value: unknown = receipt, isError = false): ToolResultNode {
  return { kind: 'tool-result', seq: 3, time: 3_000, callId: 'trial-call',
    call: { name: 'plugin_draft_try_comfy_sample', argsRaw: JSON.stringify({
      id: 'plugin_draft_private', operationId: 'owner.draw', prompt: 'my private family portrait',
    }) }, callTime: 2_000, content: [{ type: 'text', text: JSON.stringify(value) }],
    isError, subCalls: [] }
}

function props(result: Props['block']): Props {
  return { callId: result.callId, toolName: 'plugin_draft_try_comfy_sample', block: result,
    openFile: vi.fn(), t } as unknown as Props
}

describe('private Comfy trial conversation card', () => {
  it('shows a verified receipt and loads only its authenticated local image without showing the prompt', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    }))
    vi.stubGlobal('fetch', fetcher)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-trial') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const view = render(<ComfyTrialRow {...props(block())} />)
    expect(view.container.textContent).toContain('样例已生成并通过本机校验')
    expect(view.container.textContent).toContain('256 × 256')
    expect(view.container.textContent).not.toContain('my private family portrait')
    await waitFor(() => { expect(screen.getByAltText('本机生成的 PNG 样例').getAttribute('src')).toBe('blob:private-trial') })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/comfy-trials/image?id=${trialId}`),
      expect.objectContaining({ credentials: 'same-origin', redirect: 'manual' }))
  })

  it('explains denial and uncertain failures without fetching or rendering private arguments', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const refused = block('COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED', true)
    refused.error = { name: 'ComputeError', code: 'COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED' }
    const denied = render(<ComfyTrialRow {...props(refused)} />)
    expect(denied.container.textContent).toContain('机主没有批准，本次未提交')
    expect(denied.container.textContent).not.toContain('my private family portrait')
    denied.unmount()
    const unknown = block('COMPUTE_COMFY_BACKEND_UNAVAILABLE', true)
    unknown.error = { name: 'ComputeError', code: 'COMPUTE_COMFY_BACKEND_UNAVAILABLE' }
    render(<ComfyTrialRow {...props(unknown)} />)
    expect(screen.getByText('运行状态不确定，请先核对本次作业，暂勿重试。')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses a forged result that claims a public capability', () => {
    expect(privateComfyReceipt(block({ ...receipt, dispatchable: true }))).toBeNull()
    expect(privateComfyReceipt(block({ ...receipt, result: { ...receipt.result, bytes: 20_000_000 } }))).toBeNull()
  })
})
