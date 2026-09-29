// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalSkillTrial, type LocalTrialDefinition } from '../src/client/LocalSkillTrial.tsx'
import { zh } from '../src/client/local-skill-locales.ts'

const digest = `sha256:${'a'.repeat(64)}`
const form: LocalTrialDefinition = { schema: 'qianshou.local-skill-trial.v1', taskType: 'example_v1',
  artifactDigest: digest, supportsLocalTrial: true, unavailableReason: null,
  inputSchemaJson: JSON.stringify({ type: 'string', maxLength: 16384, contentSchema: {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string', title: '文字内容', minLength: 1, maxLength: 8 } },
  } }) }
const labels: Readonly<Record<string, string>> = { ...zh }
const t = (key: keyof typeof zh): string => labels[key]!
const load = async () => form
const result = { taskType: form.taskType, artifactDigest: digest, outputJson: '{"count":3}', elapsedMs: 1 }
afterEach(cleanup)

it('offers ordinary text by default and serializes it with the exact displayed source digest', async () => {
  const run = vi.fn(async () => result)
  render(<LocalSkillTrial source="user-dsh" name="example" load={load} run={run} t={t} />)
  expect(run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  const input = await screen.findByLabelText('文字内容')
  expect(screen.queryByLabelText(zh.trialInput)).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.trialRun }).disabled).toBe(true)
  fireEvent.change(input, { target: { value: '千手🙂' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(run).toHaveBeenCalledExactlyOnceWith('user-dsh', 'example', '{"text":"千手🙂"}', digest)
  expect(screen.getByText(zh.trialPassed)).toBeTruthy()
})

it('keeps machine JSON behind an explicit developer option and passes it unmodified to Host validation', async () => {
  const run = vi.fn(async () => { throw new Error('schema refused unknown field') })
  render(<LocalSkillTrial source="user-dsh" name="example" load={load} run={run} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('文字内容'), { target: { value: '保留' } })
  fireEvent.click(screen.getByRole('button', { name: zh.trialAdvanced }))
  const input = screen.getByLabelText(zh.trialInput) as HTMLTextAreaElement
  expect(input.value).toBe('{"text":"保留"}')
  fireEvent.change(input, { target: { value: '{"text":"保留","unexpected":true}' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(run).toHaveBeenCalledExactlyOnceWith('user-dsh', 'example', '{"text":"保留","unexpected":true}', digest)
  expect(screen.getByRole('alert').textContent).toBe(zh.trialFailed)
  expect(input.value).toBe('{"text":"保留","unexpected":true}')
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
})

it('creates nested list and numeric controls from a different real schema without a skill-specific channel', async () => {
  const structured = { ...form, inputSchemaJson: JSON.stringify({ type: 'string', maxLength: 16384,
    contentSchema: { type: 'object', additionalProperties: false, required: ['items'], properties: {
      items: { type: 'array', title: '项目', minItems: 1, maxItems: 3, items: {
        type: 'object', additionalProperties: false, required: ['name', 'quantity'], properties: {
          name: { type: 'string', title: '项目名称', minLength: 1, maxLength: 80 },
          quantity: { type: 'integer', title: '数量', minimum: 1, maximum: 10 },
        },
      } },
    } },
  }) }
  const run = vi.fn(async () => result)
  render(<LocalSkillTrial source="user-dsh" name="another-example" load={async () => structured} run={run} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('项目名称'), { target: { value: '文稿' } })
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2.5' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.trialRun }).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(run).toHaveBeenCalledExactlyOnceWith('user-dsh', 'another-example', '{"items":[{"name":"文稿","quantity":2}]}', digest)
})

it.each([
  ['missing', { ...form, inputSchemaJson: null }, 'trialFormMissing'],
  ['file', { ...form, supportsLocalTrial: false, unavailableReason: 'file-trial-unavailable' }, 'trialFilesUnavailable'],
  ['unsupported', { ...form, inputSchemaJson: JSON.stringify({ type: 'string', maxLength: 100, contentSchema: { type: 'object', $ref: '#/unknown' } }) }, 'trialFormMissing'],
] as const)('shows the real %s contract gap with repair guidance instead of asking the user to write JSON', async (_kind, definition, label) => {
  const run = vi.fn(async () => result)
  const prepare = vi.fn()
  render(<LocalSkillTrial source="user-dsh" name="example" load={async () => definition} run={run} prepare={prepare} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  expect(await screen.findByText(zh[label])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.trialRun })).toBeNull()
  expect(screen.queryByLabelText(zh.trialInput)).toBeNull()
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.trialPrepareContract }))
  expect(prepare).toHaveBeenCalledOnce()
  expect(run).not.toHaveBeenCalled()
})

it('does not present a stale source receipt as a successful local trial', async () => {
  const run = vi.fn(async () => ({ ...result, artifactDigest: `sha256:${'b'.repeat(64)}` }))
  render(<LocalSkillTrial source="user-dsh" name="example" load={load} run={run} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.trialStart }))
  fireEvent.change(await screen.findByLabelText('文字内容'), { target: { value: 'test' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.trialRun })) })
  expect(screen.getByRole('alert').textContent).toBe(zh.trialFailed)
  expect(screen.queryByText(zh.trialPassed)).toBeNull()
})
