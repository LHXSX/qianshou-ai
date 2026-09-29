// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketTaskCall } from '../src/client/MarketTaskCall.tsx'
import type { MarketTaskTransport } from '../src/client/market-task-transport.ts'

afterEach(cleanup)

function remote(): MarketTaskTransport {
  return {
    taskTypes: vi.fn().mockResolvedValue([{ taskType: 'video_thumbnail', acceptedInputKinds: ['multi_file'],
      requiredParams: [], canQuoteInline: false, canQuoteFiles: true }]),
    uploadInputFile: vi.fn(), createPlan: vi.fn(), quotePlan: vi.fn(), confirmAndPublish: vi.fn(),
    findWorkload: vi.fn(), readWorkload: vi.fn(), readResult: vi.fn(), readAcceptance: vi.fn(), decideAcceptance: vi.fn(),
  }
}

it.each(['check_frame_00050.png', 'video-batch.zip'])('explains incompatible %s before uploading or quoting', async filename => {
  const transport = remote()
  render(<MarketTaskCall capability={{ taskType: 'video_thumbnail', name: '视频抽帧', category: 'video' }} transport={transport} />)
  const input = await screen.findByLabelText('上传任务材料')
  expect(screen.getByText(/图片不能用于视频抽帧/u).textContent).toContain('ZIP 请先解压')
  fireEvent.change(input, { target: { files: [new File(['fixture'], filename)] } })
  expect(transport.uploadInputFile).not.toHaveBeenCalled()
  expect(transport.createPlan).not.toHaveBeenCalled()
  expect(transport.confirmAndPublish).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true)
})

it('preserves a previously uploaded wrong material for removal while preventing a paid task', async () => {
  const transport = remote()
  render(<MarketTaskCall capability={{ taskType: 'video_thumbnail', name: '视频抽帧', category: 'video' }} transport={transport}
    continuation={{ planId: null, workloadId: null, submission: 'idle', draft: { goal: '测试', input: {}, params: {},
      files: [{ filename: 'check_frame_00050.png', bytes: 7, sha256: 'a'.repeat(64), contentType: 'image/png',
        objectKey: `v8/account-167/developer/${'a'.repeat(32)}/input/check_frame_00050.png` }] } }} />)
  await screen.findByRole('alert')
  await waitFor(() => { expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true) })
  expect(screen.getByText('check_frame_00050.png')).toBeTruthy()
  expect(screen.getByRole('button', { name: '移除' })).toHaveProperty('disabled', false)
  expect(transport.createPlan).not.toHaveBeenCalled()
  expect(transport.confirmAndPublish).not.toHaveBeenCalled()
})
