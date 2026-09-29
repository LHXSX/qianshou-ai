/** Real production Loader with explicit fictional HTTP responses, not an installed legal model. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LegalRuntime from '../src/legal-document-plugin.ts'
import { ComputeExecutorRegistry } from '../src/executor.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
describe('native legal runtime production Loader', () => {
  it.each(['disabled', 'missing-model', 'digest-mismatch', 'ready'] as const)('loads %s without granting market dispatch', async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'legal-loader-fictional-')); roots.push(root)
    const path = join(root, 'cordis.yml'), registry = new ComputeExecutorRegistry()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (target) => {
      const url = new URL(target instanceof Request ? target.url : target)
      expect(url.origin).toBe('http://127.0.0.1:11434')
      calls.push(url.pathname)
      return Response.json(url.pathname === '/api/tags'
        ? { models: [{ name: 'fictional:latest', digest: (state === 'digest-mismatch' ? 'b' : 'a').repeat(64) }] }
        : { message: { content: 'QS_LEGAL_READY' } })
    }))
    const fixtureName = 'legal-loader-fictional-compute', packageName = '@deepseek-ai/dsh-compute-core/legal-document-plugin'
    const modules = new Map<string, unknown>([[fixtureName, { apply(ctx: Context) { ctx.provide('computeCore', { executors: registry } as never) } }],
      [packageName, LegalRuntime]])
    await writeFile(path, `- name: '${fixtureName}'\n- name: '${packageName}'\n  config: ${JSON.stringify({
      enabled: state !== 'disabled', providerId: 'fictional-provider', model: state === 'missing-model' ? '' : 'fictional:latest',
      modelSha256: 'a'.repeat(64), ollamaOrigin: 'http://127.0.0.1:11434', timeoutMs: 1000,
      maxContextChars: 40000, inputStorageHostname: 'storage.example.test',
    })}\n`)
    const ctx = await boot('legal-loader-fictional', path, undefined, (preparing) => {
      const internal = preparing.loader.internal
      if (internal === undefined) throw new Error('Native legal Loader fixture requires the real Node module loader')
      const shared = { loadCache: internal.loadCache, register: internal.register.bind(internal), load: internal.load.bind(internal),
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import ${specifier}`)
          return modules.get(specifier)
        } }
      preparing.loader.internal = internal.version === 'v2'
        ? { ...shared, version: 'v2', getOrCreateModuleJob: internal.getOrCreateModuleJob.bind(internal),
          resolveSync: internal.resolveSync.bind(internal) }
        : { ...shared, version: 'v1', getModuleJobForImport: internal.getModuleJobForImport.bind(internal),
          resolve: internal.resolve.bind(internal), resolveSync: internal.resolveSync.bind(internal) }
    })
    contexts.push(ctx)
    expect(ctx.qianshouLegalDocumentRuntime.state()).toEqual({
      localExecution: state === 'digest-mismatch' || state === 'missing-model' ? 'unavailable' : state,
      marketDispatch: 'not-registered',
    })
    if (state === 'ready') {
      expect(registry.list()).toEqual([{ capabilityId: 'legal.doc.bundle', version: '1.0.0' }])
      expect(calls).toEqual(['/api/tags', '/api/chat'])
    } else {
      expect(registry.list()).toEqual([])
      expect(calls).toEqual(state === 'digest-mismatch' ? ['/api/tags'] : [])
    }
    await ctx.fiber.dispose(); contexts.pop()
    expect(registry.list()).toEqual([])
  })
})
