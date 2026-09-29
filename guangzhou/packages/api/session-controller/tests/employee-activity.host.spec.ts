import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { applyEmployeeActivity, employeeActivityProjection } from '../src/employee-activity-projection.ts'

describe('employee activity projection', () => {
  it('replays parallel tools without retaining secret arguments or reasoning', () => {
    const session = Session.create(SessionId('employee-facts'))
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('a'), name: 'read_file', arguments: '{"secret":"not-for-monitor"}' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('b'), name: 'run_tests', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('a'), content: [{ type: 'text', text: 'private result' }], isError: false }) }, { surfaceOp: 'append' })
    const state = session.snapshotEvents().reduce(applyEmployeeActivity, employeeActivityProjection.init())
    expect(state.phase).toBe('tools')
    expect(state.tools).toEqual({ b: 'run_tests' })
    expect(JSON.stringify(state)).not.toContain('not-for-monitor')
    expect(JSON.stringify(state)).not.toContain('private result')
  })
  it('clears tool activity on turn completion and resets on a new task', () => {
    const session = Session.create(SessionId('employee-complete'))
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('a'), name: 'read_file', arguments: '{}' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } })
    const ended = session.snapshotEvents().reduce(applyEmployeeActivity, employeeActivityProjection.init())
    expect(ended.phase).toBe('error')
    expect(ended.tools).toEqual({})
    session.append('turn/start', { turn: 2 })
    const restarted = session.snapshotEvents().reduce(applyEmployeeActivity, employeeActivityProjection.init())
    expect(restarted.phase).toBe('thinking')
  })
})
