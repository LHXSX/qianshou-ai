/** Real Loader and AgentLoop proof of bounded automatic task routing, without credentials. */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { launchWebScaffold } from './scaffold.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

const PROVIDER = 'qianshou-auto-test'
const TOOL = 'inspect_auto_routing_fixture'
class RoutingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return ['baseline', 'review'].map(id => ({ provider: PROVIDER, id, name: id }))
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], reasoning: { efforts: [
      { id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' },
    ] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (options.sessionId === undefined) {
      yield* textResponse(JSON.stringify({ model: 'review', reasoningEffort: 'high', reason: 'The task asks for an independent compatibility review.' }))
      return
    }
    const actualCalls = this.calls.filter(call => call.sessionId !== undefined)
    if (actualCalls.length === 1) yield* toolCallResponse('auto-read', TOOL, {})
    else yield* textResponse('The fixture was inspected and the compatibility review is complete.')
  }
}

it('routes one actual task before execution, reuses the route through its tool continuation, and honors a manual override', async () => {
  const scaffold = await launchWebScaffold({ toolsMode: 'native' })
  try {
    const adapter = new RoutingAdapter()
    let executions = 0
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Automatic routing test provider')
    scaffold.ctx.effect(() => scaffold.ctx.tools.register(defineContentToolFixture({ name: TOOL,
      description: 'Inspect the isolated compatibility fixture.', parameters: {},
      execute: async () => { executions += 1; return [{ type: 'text', text: 'Verified fixture: the public field remains compatible.' }] },
    })), 'Automatic routing test read-only tool')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: 'baseline' })
    const id = SessionId('qianshou-auto-profile')
    await scaffold.ctx.sessionController.create({ sessionId: id, cwd: scaffold.workspaceCwd })
    await scaffold.ctx.sessionController.selectModel({ sessionId: id, provider: PROVIDER, model: 'baseline',
      routing: { model: 'auto', effort: 'auto', candidates: ['baseline', 'review'] } })
    await scaffold.ctx.sessionController.prompt({ sessionId: id, requestId: 'auto-first' as SessionRequestId, mode: 'queue',
      content: [{ type: 'text', text: 'Review the compatibility fixture and inspect it before concluding.' }] }, new AbortController().signal)
    const agent = scaffold.ctx.agents.get(id)
    if (agent === undefined) throw new Error('The shipped profile did not create the agent.')
    await agent.whenIdle()
    expect(adapter.calls.filter(call => call.sessionId === undefined)).toHaveLength(1)
    const actualRoutes = adapter.calls.filter(call => call.sessionId !== undefined)
      .map(call => [call.provider, call.model, call.reasoningEffort])
    expect(actualRoutes).toEqual([
      [PROVIDER, 'review', 'high'], [PROVIDER, 'review', 'high'],
    ])
    expect(executions).toBe(1)
    expect(agent.session.requestHeader()?.config).toMatchObject({ provider: PROVIDER, model: 'review', reasoningEffort: 'high' })
    const decision = agent.session.ownEvents().find(event => event.type === 'model/routing-decision')
    expect(decision?.data).toMatchObject({ status: 'selected', model: 'review' })
    expect(agent.session.ownEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    await scaffold.ctx.sessionController.selectModel({ sessionId: id, provider: PROVIDER, model: 'baseline', reasoningEffort: 'off' })
    await scaffold.ctx.sessionController.prompt({ sessionId: id, requestId: 'auto-manual' as SessionRequestId, mode: 'queue',
      content: [{ type: 'text', text: 'Summarize the completed check in one sentence.' }] }, new AbortController().signal)
    await agent.whenIdle()
    expect(adapter.calls.filter(call => call.sessionId === undefined)).toHaveLength(1)
    expect(adapter.calls.at(-1)).toMatchObject({ provider: PROVIDER, model: 'baseline', reasoningEffort: 'off' })
  } finally { await scaffold.close() }
})
