import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmRuntime, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { installTaskRoutingHistory, resolveTaskRouting, validateModelRouting, validateRoutingCandidates } from '../src/auto-routing.ts'
import type { ModelSelection } from '../src/model-selection.ts'

const task = createUserMessage({ content: [{ type: 'text', text: 'Review this protocol migration for compatibility and report verified risks.' }], source: { kind: 'user' } })
const selection: ModelSelection = { provider: 'owned', model: 'baseline', routing: { model: 'auto', effort: 'auto', candidates: ['baseline', 'vision'] } }
function harness(output: unknown = { model: 'vision', reasoningEffort: 'high', reason: 'Cross-version compatibility needs careful reasoning.' }) {
  const session = Session.create(SessionId('routing-test'))
  const calls: GenerateOptions[] = []
  const models: LlmResolvedModelInfo[] = [
    { provider: 'owned', id: 'baseline', name: 'Baseline', inputModalities: ['text'], reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } },
    { provider: 'owned', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } },
  ]
  const llm = { listModels: vi.fn(async () => models),
    resolveModelInfo: vi.fn(async (_provider: string, id: string) => models.find(model => model.id === id)),
    resolveCallConfig: vi.fn(async (config: LlmCallConfig) => config),
    stream: vi.fn(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> { calls.push(options)
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }),
  } as unknown as LlmRuntime
  const run = (pick = selection, messages = [task], id = 'task-1') => resolveTaskRouting(llm, session, id, pick, messages, new AbortController().signal, 20000)
  return { session, models, llm, calls, run }
}

describe('semantic task routing', () => {
  it('uses the authorized provider once, records exact bounded input and usage, then reuses the decision', async () => {
    const h = harness()
    expect(await h.run()).toEqual({ provider: 'owned', model: 'vision', reasoningEffort: 'high' })
    await h.run()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ provider: 'owned', model: 'baseline', tools: [], maxTokens: 1024, reasoningEffort: 'low' })
    const events = h.session.ownEvents()
    expect(events.map(event => event.type)).toEqual(['model/routing-start', 'model/routing-decision'])
    const requestText = h.calls[0]!.messages[0]!.content[0]!
    if (requestText.type !== 'text') throw new Error('Expected the logged routing text.')
    expect(events[0]?.data).toMatchObject({ input: requestText.text })
    await expect(JSON.stringify(JSON.parse(requestText.text), null, 2) + '\n').toMatchFileSnapshot('./expected/auto-routing.prompt.expected.json')
    expect(events[1]?.data).toMatchObject({ status: 'selected', usage: { inputTokens: 100, outputTokens: 30 } })
    expect(h.session.deriveMessages()).toEqual([])
  })

  it('makes no auxiliary call in fixed mode', async () => {
    const h = harness()
    expect(await h.run({ provider: 'owned', model: 'baseline' })).toEqual({ provider: 'owned', model: 'baseline' })
    expect(h.calls).toHaveLength(0)
  })

  it('keeps the manual model while choosing its advertised effort', async () => {
    const h = harness({ model: 'baseline', reasoningEffort: 'low', reason: 'Routine edit fits low effort.' })
    expect(await h.run({ ...selection, routing: { model: 'manual', effort: 'auto', candidates: [] } })).toMatchObject({ model: 'baseline', reasoningEffort: 'low' })
    const input = h.calls[0]!.messages[0]!.content[0]!
    if (input.type !== 'text') throw new Error('Expected routing text.')
    expect(JSON.parse(input.text) as unknown).toMatchObject({ candidates: [{ model: 'baseline' }] })
  })

  it('filters incompatible models before interpreting a manually locked effort', async () => {
    const h = harness({ model: 'vision', reasoningEffort: 'low', reason: 'The only authorized compatible route.' })
    expect(await h.run({ ...selection, reasoningEffort: ReasoningEffortId('high'), routing: { ...selection.routing!, effort: 'manual' } })).toMatchObject({ model: 'vision', reasoningEffort: 'high' })
    const input = h.calls[0]!.messages[0]!.content[0]!
    if (input.type !== 'text') throw new Error('Expected routing text.')
    expect(JSON.parse(input.text) as unknown).toMatchObject({ candidates: [{ model: 'vision' }] })
  })

  it('keeps image capability required by retained history even for a text follow-up', async () => {
    const h = harness()
    h.session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } as never], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await h.run()
    const start = h.session.ownEvents().find(event => event.type === 'model/routing-start')!
    if (start.type !== 'model/routing-start') throw new Error('expected routing request')
    expect(JSON.parse(start.data.input)).toMatchObject({ needsImage: true, candidates: [{ model: 'vision' }] })
  })

  it.each([
    { model: 'other-provider-model', reasoningEffort: 'high', reason: 'Not allowed' },
    { model: 'vision', reasoningEffort: 'invented', reason: 'Not supported' },
    { model: 'vision', reasoningEffort: 'high', reason: '' },
  ])('records and replays malformed decisions without a second paid attempt', async (output) => {
    const h = harness(output)
    await expect(h.run()).rejects.toThrow()
    await expect(h.run()).rejects.toThrow()
    expect(h.calls).toHaveLength(1)
    expect(h.session.ownEvents().at(-1)?.data).toMatchObject({ status: 'failed' })
  })

  it('restores a committed result without reclassification after a cold replay', async () => {
    const h = harness()
    const expected = await h.run()
    const restored = Session.create(SessionId('restored'), [...h.session.ownEvents()])
    installTaskRoutingHistory(restored, () => ({ 'task-1': { ...expected, status: 'selected', reason: 'Restored committed decision.' } }))
    expect(await resolveTaskRouting(h.llm, restored, 'task-1', selection, [task], new AbortController().signal, 20000)).toEqual(expected)
    expect(h.calls).toHaveLength(1)
  })

  it('rejects candidates outside the selected provider directory', async () => {
    const h = harness()
    await expect(validateRoutingCandidates(h.llm, { ...selection, routing: { model: 'auto', effort: 'auto', candidates: ['unconfigured'] } })).rejects.toThrow('advertised')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects duplicate and excessive authorization sets', () => {
    expect(() =>{  validateModelRouting({ model: 'auto', effort: 'auto', candidates: ['same', 'same'] }) }).toThrow()
    expect(() =>{  validateModelRouting({ model: 'auto', effort: 'auto', candidates: Array.from({ length: 65 }, (_, i) => String(i)) }) }).toThrow()
  })
})

it('fails visibly when the router spends its output budget on reasoning without JSON', async () => {
  const h = harness()
  vi.spyOn(h.llm, 'stream').mockImplementation(async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'Evaluating the task.' }
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 1024 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })
  await expect(h.run()).rejects.toThrow('max-tokens')
  expect(h.session.ownEvents().at(-1)?.data).toMatchObject({ status: 'failed', usage: { inputTokens: 50, outputTokens: 1024 } })
})

it('enforces a total UTF-8 input bound before paying for the auxiliary call', async () => {
  const h = harness()
  h.models[0]!.reasoning = { efforts: Array.from({ length: 300 }, (_, i) => ({ id: ReasoningEffortId(String(i)), name: 'x'.repeat(100), description: '元'.repeat(300) })) }
  await expect(h.run()).rejects.toThrow('64 KiB')
  expect(h.calls).toHaveLength(0)
  expect(h.session.ownEvents().at(-1)?.data).toMatchObject({ status: 'failed' })
})

it('cancels the auxiliary request without executing or switching to another provider', async () => {
  const h = harness()
  const abort = new AbortController()
  vi.spyOn(h.llm, 'stream').mockImplementation(async function* (options) {
    abort.abort(new Error('User cancelled'))
    options.signal?.throwIfAborted()
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await expect(resolveTaskRouting(h.llm, h.session, 'cancel', selection, [task], abort.signal, 20000)).rejects.toThrow('User cancelled')
  expect(h.session.ownEvents().at(-1)?.data).toMatchObject({ status: 'failed', provider: 'owned' })
})
