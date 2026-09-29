import { describe, expect, it } from 'vitest'
import { ComputeJoinStore, createComputeFanOutPlan } from '../src/fanout/index.ts'

describe('compute fan-out foundation', () => {
  it('creates stable zero-based piece identities without scheduling work', () => {
    expect(createComputeFanOutPlan('task-7', 3)).toEqual({
      parentTaskId: 'task-7', arity: 3,
      pieces: [
        { pieceId: 'task-7:0', index: 0 },
        { pieceId: 'task-7:1', index: 1 },
        { pieceId: 'task-7:2', index: 2 },
      ],
    })
  })

  it('joins in plan order even when results arrive out of order', () => {
    const store = new ComputeJoinStore(createComputeFanOutPlan('p', 2))
    expect(store.add({ parentTaskId: 'p', pieceId: 'p:1', index: 1, output: 'b' })).toBeUndefined()
    expect(store.add({ parentTaskId: 'p', pieceId: 'p:0', index: 0, output: 'a' })?.map(x => x.output)).toEqual(['a', 'b'])
  })

  it('rejects duplicate, missing, and over-arity pieces', () => {
    const store = new ComputeJoinStore(createComputeFanOutPlan('p', 1))
    expect(() => store.join()).toThrow('COMPUTE_FANOUT_MISSING')
    store.add({ parentTaskId: 'p', pieceId: 'p:0', index: 0, output: true })
    expect(() => store.add({ parentTaskId: 'p', pieceId: 'p:0', index: 0, output: true })).toThrow('COMPUTE_FANOUT_DUPLICATE')
    expect(() => store.add({ parentTaskId: 'p', pieceId: 'p:1', index: 1, output: true })).toThrow('COMPUTE_FANOUT_PIECE_INVALID')
  })
})
