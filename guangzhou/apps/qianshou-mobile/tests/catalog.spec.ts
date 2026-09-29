import { describe, expect, it } from 'vitest'
import { nextBatch } from '../src/catalog.ts'
import { tabForMenu, taskMatches } from '../src/data.ts'

describe('qianshou-mobile catalog', () => {
  it('wraps suggestion batches', () => {
    expect(nextBatch(0, 2)).toBe(1)
    expect(nextBatch(1, 2)).toBe(0)
    expect(nextBatch(-1, 2)).toBe(0)
  })

  it('maps drawer rows onto bottom tabs', () => {
    expect(tabForMenu('chat')).toBe('chat')
    expect(tabForMenu('square')).toBe('agents')
    expect(tabForMenu('tasks')).toBe('tasks')
    expect(tabForMenu('vip')).toBe('me')
    expect(tabForMenu('unknown')).toBe('chat')
  })

  it('filters task cards by status chip', () => {
    expect(taskMatches('all', 'failed')).toBe(true)
    expect(taskMatches('running', 'running')).toBe(true)
    expect(taskMatches('done', 'running')).toBe(false)
    expect(taskMatches('failed', 'failed')).toBe(true)
  })
})
