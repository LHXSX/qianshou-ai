import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeError } from '../src/errors.ts'
import { ComputeResultCache, resultOutputDigest } from '../src/result-cache.ts'
import { ComputeService } from '../src/service.ts'
import type { ComputeDraftStore } from '../src/store.ts'
import type { QianshouCoreClient } from '../src/core-client.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const TRANSCODE = [{ capability: 'media.transcode', input: { kind: 'inline', value: 'clip' } }] as const
const EXTRACT = [{ capability: 'doc.pdf.extract', input: { kind: 'inline', value: 'pdf' } }] as const
const GENERATE = [{ capability: 'llm.generate.local', input: { kind: 'inline', value: 'hello' } }] as const

async function openService() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-cache-'))
  roots.push(root)
  const results = new ComputeResultCache({ directory: join(root, 'cache'), maxEntries: 8, maxBytes: 64_000 })
  const getIdentity = vi.fn()
  const createDeveloperTask = vi.fn()
  const service = new ComputeService(
    { getIdentity, createDeveloperTask, close: async () => {} } as unknown as QianshouCoreClient,
    { close: async () => {} } as unknown as ComputeDraftStore,
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    results,
  )
  return { service, getIdentity, createDeveloperTask }
}

describe('compute result cache', () => {
  it('hits a deterministic processing result with a matching output digest and never calls the core', async () => {
    const { service, getIdentity, createDeveloperTask } = await openService()
    const stored = await service.storeResultCache({
      status: 'ok',
      steps: TRANSCODE,
      impls: ['ffmpeg'],
      output: { text: 'same-bytes' },
    })
    expect(stored.outputDigest).toBe(resultOutputDigest({ text: 'same-bytes' }))
    const hit = await service.lookupResultCache({ steps: TRANSCODE, impls: ['ffmpeg'] })
    expect(hit?.digest).toBe(stored.digest)
    expect(hit?.outputDigest).toBe(stored.outputDigest)
    expect(hit?.output).toEqual({ text: 'same-bytes' })
    expect(getIdentity).not.toHaveBeenCalled()
    expect(createDeveloperTask).not.toHaveBeenCalled()
    await service.clearResultCache()
    await expect(service.lookupResultCache({ steps: TRANSCODE, impls: ['ffmpeg'] })).resolves.toBeNull()
    await service.close()
  })

  it('disables cache for random generation and does not treat a later store as a template', async () => {
    const { service } = await openService()
    await expect(service.storeResultCache({
      status: 'ok',
      steps: GENERATE,
      impls: ['local_llm'],
      output: { text: 'once' },
    })).rejects.toMatchObject({ code: 'COMPUTE_CACHE_RANDOM' })
    await expect(service.lookupResultCache({ steps: GENERATE, impls: ['local_llm'] })).resolves.toBeNull()
    await expect(service.storeResultCache({
      status: 'ok',
      steps: [...TRANSCODE, ...GENERATE],
      impls: ['ffmpeg', 'local_llm'],
      output: { text: 'mixed' },
    })).rejects.toMatchObject({ code: 'COMPUTE_CACHE_RANDOM' })
    await expect(service.storeResultCache({
      status: 'partial',
      steps: TRANSCODE,
      impls: ['ffmpeg'],
      output: { text: 'half' },
    })).rejects.toMatchObject({ code: 'COMPUTE_CACHE_PARTIAL' })
    await service.close()
  })

  it('misses a different implementation and refuses an unknown impl id', async () => {
    const { service } = await openService()
    const stored = await service.storeResultCache({
      status: 'ok',
      steps: EXTRACT,
      impls: ['pymupdf'],
      output: { text: 'pages' },
    })
    await expect(service.lookupResultCache({ steps: EXTRACT, impls: ['pdfplumber'] })).resolves.toBeNull()
    const again = await service.lookupResultCache({ steps: EXTRACT, impls: ['pymupdf'] })
    expect(again?.outputDigest).toBe(stored.outputDigest)
    await expect(service.storeResultCache({
      status: 'ok',
      steps: EXTRACT,
      impls: ['not-a-registry-impl'],
      output: { text: 'nope' },
    })).rejects.toBeInstanceOf(ComputeError)
    await service.close()
  })
})
