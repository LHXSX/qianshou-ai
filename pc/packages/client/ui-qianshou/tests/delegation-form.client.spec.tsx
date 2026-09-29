// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DelegationForm, type DelegationFormProps } from '../src/client/DelegationForm.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(dispatch = vi.fn<(parent: string, text: string) => Promise<void>>().mockResolvedValue(undefined)) {
  const props = { parent: 'ceo-parent', dispatch, t: makeTranslate(zh) } as unknown as DelegationFormProps
  return { dispatch, ...render(<DelegationForm {...props} />) }
}

describe('CEO delegation configuration', () => {
  it('queues the selected one-shot role and objective in the actual parent request', async () => {
    const view = fixture()
    expect(view.getByRole('button', { name: '交给 CEO 派发' })).toHaveProperty('disabled', true)
    fireEvent.change(view.getByLabelText('运行方式'), { target: { value: 'one-shot' } })
    fireEvent.change(view.getByLabelText('专业角色'), { target: { value: 'roleTesting' } })
    fireEvent.change(view.getByLabelText('任务目标与验收要求'), { target: { value: '读取验收文件，不能修改。' } })
    fireEvent.click(view.getByRole('button', { name: '交给 CEO 派发' }))
    await waitFor(() => { expect(view.getByRole('status').textContent).toContain('请求已送达') })
    expect(view.dispatch).toHaveBeenCalledTimes(1)
    const [parent, request] = view.dispatch.mock.calls[0]!
    expect(parent).toBe('ceo-parent')
    expect(request).toContain('专业角色：测试专家')
    expect(request).toContain('run_in_background=false')
    expect(request).toContain('读取验收文件，不能修改。')
    expect(request).not.toContain('run_in_background=true')
    expect(view.getByLabelText('任务目标与验收要求')).toHaveProperty('value', '')
  })

  it('preserves custom role and task after a refused continuous request', async () => {
    const view = fixture(vi.fn<(parent: string, text: string) => Promise<void>>().mockRejectedValue(new Error('parent unavailable')))
    fireEvent.change(view.getByLabelText('运行方式'), { target: { value: 'continuable' } })
    fireEvent.change(view.getByLabelText('专业角色'), { target: { value: 'custom' } })
    fireEvent.change(view.getByLabelText('角色名称与特长'), { target: { value: '协议兼容验证专员' } })
    fireEvent.change(view.getByLabelText('任务目标与验收要求'), { target: { value: '完成第一轮后等待我补充。' } })
    fireEvent.click(view.getByRole('button', { name: '交给 CEO 派发' }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('未提交成功') })
    const request = view.dispatch.mock.calls[0]![1]
    expect(request).toContain('协议兼容验证专员')
    expect(request).toContain('run_in_background=true')
    expect(request).toContain('send_message')
    expect(view.getByLabelText('任务目标与验收要求')).toHaveProperty('value', '完成第一轮后等待我补充。')
    expect(view.getByRole('button', { name: '交给 CEO 派发' })).toHaveProperty('disabled', false)
  })
})
