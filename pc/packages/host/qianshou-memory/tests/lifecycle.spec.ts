/** Dispose must await and close a delayed real SQLite open before another owner can start. */
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import QianshouMemory from '../src/index.ts'
import { MemoryStore } from '../src/store.ts'
import { parseInput } from '../src/validation.ts'

it('awaits a delayed open during disposal, closes the acquired SQLite handle and allows a new owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-memory-lifecycle-'))
  const path = join(dir, 'vault.sqlite')
  const store = await MemoryStore.open(path, 100000)
  const close = vi.spyOn(store, 'close')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const opened = Promise.withResolvers<MemoryStore>()
  const spy = vi.spyOn(MemoryStore, 'open').mockImplementationOnce(() => { started.resolve(); return opened.promise })
  const ctx = new Context(); ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined } as never)
  const fiber = ctx.plugin(QianshouMemory, { path, capacityBytes: 100000, expiryIntervalMs: 60000 })
  try {
    await started.promise
    let finished = false
    const disposing = fiber.dispose().then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(finished).toBe(false)
    opened.resolve(store); await disposing
    expect(close).toHaveBeenCalledOnce()
    spy.mockRestore()
    await ctx.plugin(QianshouMemory, { path, capacityBytes: 100000, expiryIntervalMs: 60000 })
    const record = await ctx.qianshouMemory.save(parseInput({ title: 'new owner', content: 'retained', kind: 'knowledge', scope: 'device' }))
    expect((await ctx.qianshouMemory.read(record.id)).entry.content).toBe('retained')
  } finally {
    spy.mockRestore(); close.mockRestore(); store.close(); await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true })
  }
})

it('includes title, source and evidence in retained-text capacity before any write', async () => {
  const store = await MemoryStore.open(':memory:', 1024)
  try {
    const input = parseInput({ title: 't'.repeat(160), content: 'x', source: 's'.repeat(2000), evidence: 'e'.repeat(4000), kind: 'knowledge', scope: 'device' })
    expect(() => store.save(input, null)).toThrow('capacity')
    expect(store.list({}).total).toBe(0)
    expect(store.identity().revision).toBe(1)
  } finally { store.close() }
})
