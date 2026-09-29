// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { SkillActionsRow, skillActionsFromToolResult } from '../src/client/SkillActionsRow.tsx'
import { zh } from '../src/client/local-skill-locales.ts'

const labels: Readonly<Record<string, string>> = { ...zh }
const translate = (key: string): string => {
  const label = labels[key]
  if (label === undefined) throw new Error(`Missing test locale: ${key}`)
  return label
}

afterEach(cleanup)
const artifactDigest = `sha256:${'b'.repeat(64)}`
const definition = { schema: 'qianshou.local-skill-trial.v1' as const, taskType: 'custom_v1', artifactDigest,
  supportsLocalTrial: true, unavailableReason: null, inputSchemaJson: JSON.stringify({ type: 'string', maxLength: 16384,
    contentSchema: { type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', title: '文字内容', minLength: 1, maxLength: 8000 } } } }) }
const load = async () => definition
const meta = { protocol: 'qianshou.skill-actions.v1', state: 'saved', source: 'user-dsh', name: 'qs-test-demo',
  displayName: '测试示例', skillSha256: 'a'.repeat(64), portableTrial: true }
const block = (value: unknown, isError = false) => ({ kind: 'tool-result', isError, meta: value }) as ToolCallViewProps['block']

it('requires a settled Host file hash or execution digest; prose and failed results have no author actions', () => {
  expect(skillActionsFromToolResult(block(meta))).toMatchObject({ state: 'saved', name: 'qs-test-demo' })
  for (const value of [null, { ...meta, protocol: 'ordinary-prose' }, { ...meta, skillSha256: '' },
    { ...meta, state: 'approved' }, { ...meta, name: '../outside' }, { ...meta, source: 'profile' }]) {
    expect(skillActionsFromToolResult(block(value))).toBeNull()
  }
  expect(skillActionsFromToolResult(block(meta, true))).toBeNull()
  expect(skillActionsFromToolResult({ kind: 'tool-use', meta } as unknown as ToolCallViewProps['block'])).toBeNull()
})

it('runs only after explicit local input confirmation and routes publication to the exact saved source', async () => {
  const run = vi.fn(async () => ({ outputJson: '{"count":3}', artifactDigest: `sha256:${'b'.repeat(64)}`, taskType: 'custom_v1', elapsedMs: 5 }))
  const manage = vi.fn(() => true)
  const view = render(<SkillActionsRow block={block(meta)} run={run} load={load} manage={manage} t={translate} />)
  expect(run).not.toHaveBeenCalled()
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
  expect(screen.queryByText(zh.publishStatusApproved)).toBeNull()
  expect(view.container.textContent).toMatchSnapshot()
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('文字内容'), { target: { value: '千手🙂' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(run).toHaveBeenCalledExactlyOnceWith('user-dsh', 'qs-test-demo', '{"text":"千手🙂"}', artifactDigest)
  expect(screen.getByText(zh.trialPassed)).toBeTruthy()
  expect(screen.getByText('{"count":3}')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.publishOrder }))
  expect(manage).toHaveBeenCalledExactlyOnceWith({ source: 'user-dsh', name: 'qs-test-demo' })
})

it('keeps the input after a failed trial and never creates a success or approval receipt', async () => {
  const run = vi.fn(async () => { throw new Error('invalid-source') })
  render(<SkillActionsRow block={block(meta)} run={run} load={load} manage={() => true} t={translate} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('文字内容'), { target: { value: '保留' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(screen.getByRole('alert').textContent).toBe(zh.trialFailed)
  const input = screen.getByLabelText('文字内容')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('trial text field is unavailable')
  expect(input.value).toBe('保留')
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
})

it('withdraws the old local result when a different saved skill replaces the card', async () => {
  const run = vi.fn(async () => ({ outputJson: '{"old":true}', artifactDigest: `sha256:${'b'.repeat(64)}`, taskType: 'custom_v1', elapsedMs: 2 }))
  const manage = () => true
  const view = render(<SkillActionsRow block={block(meta)} run={run} load={load} manage={manage} t={translate} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('文字内容'), { target: { value: 'hello' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(screen.getByText('{"old":true}')).toBeTruthy()
  view.rerender(<SkillActionsRow block={block({ ...meta, name: 'different-skill' })} run={run} load={load} manage={manage} t={translate} />)
  expect(screen.queryByText('{"old":true}')).toBeNull()
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
})
