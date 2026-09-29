import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ReviewableExecutionCandidateStore } from '../src/reviewable-execution-candidates.ts'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { ComputeDraftStore } from '../src/store.ts'
import { ComputeService } from '../src/service.ts'
import { registerRoutes } from '../src/routes.ts'
import * as PluginDraftTools from '../src/plugin-draft-tools.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const schema = (name: string) => ({ type: 'object', properties: { [name]: { type: 'string' } },
  required: [name], additionalProperties: false })
const operation = { id: 'text.clean', title: 'Clean', description: 'Clean text',
  binding: { kind: 'tool', ref: 'tool:qianshou.string-map.v1' },
  inputSchema: schema('source'), outputSchema: schema('cleaned'),
  permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
  resources: { platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 4096,
    maxOutputBytes: 4096, maxRunMs: 1000 } }
const spec = { pluginId: 'creator.clean', version: '1.0.0', displayName: 'Clean text', operations: [operation] }
const claims = { 'text.clean': 'text.clean' }
const programs = { 'text.clean': { mappings: [{ from: 'source', to: 'cleaned', transform: 'trim' }] } }

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-reviewable-creator-'))
  roots.push(root)
  const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
  const draft = await drafts.save({ spec })
  const candidates = new ReviewableExecutionCandidateStore(join(root, 'candidates'))
  const plans = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 10, maxBytes: 131072 })
  const service = new ComputeService(null, plans, () => false, undefined, undefined, undefined, undefined,
    undefined, undefined, drafts, undefined, undefined, undefined, undefined, undefined, candidates)
  return { root, draft, drafts, candidates, service }
}

it('saves exact executable candidate bytes, reopens after restart and rejects disk tampering', async () => {
  const { root, draft, service } = await setup()
  try {
    const built = await service.buildReviewableExecutionCandidate({ draftId: draft.id,
      expectedUpdatedAt: draft.updatedAt, capabilityIds: claims, programs })
    expect(built).toMatchObject({ reviewed: false, installable: false, dispatchable: false,
      verificationScope: 'self-contained-declarative-program' })
    expect(built.manifest.operations[0]?.implementationSha256).toMatch(/^[a-f0-9]{64}$/u)
    const reopened = new ReviewableExecutionCandidateStore(join(root, 'candidates'))
    const exported = await reopened.export(built.packageSha256)
    expect(exported.contents).toContain('qianshou.string-map.v1')
    expect(exported.contents).not.toContain('Clean text')
    expect(exported).toMatchObject({ reviewed: false, installable: false, dispatchable: false })
    const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
    const context = { connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } } }, effect: (activate: () => () => void) => { activate() },
    inject: (services: readonly string[]) => {
      // This route-only carrier has no live Session or attachment providers.
      expect(services).toEqual(['agents', 'fileUploads', 'attachments'])
    } } as unknown as Context
    registerRoutes(context, service, 65536)
    expect(routes.has('/api/qianshou/compute/files/from-composer')).toBe(false)
    const endpoint = routes.get('/api/qianshou/compute/plugin-drafts/reviewable-execution/export')
    expect(endpoint).toBeDefined()
    const response = await endpoint!.fetch(new Request(`http://localhost/export?sha256=${built.packageSha256}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect((await response.json() as { contents: string }).contents).toBe(exported.contents)
    const unsafe = await endpoint!.fetch(new Request('http://localhost/export?sha256=../../private'))
    expect(unsafe.status).toBe(400)
    const trial = await service.tryReviewableExecutionCandidate(built.packageSha256,
      [{ operationId: 'text.clean', input: { source: '  Hi  ' } }])
    expect(trial.results).toEqual([{ operationId: 'text.clean', output: { cleaned: 'Hi' } }])
    await expect(service.tryReviewableExecutionCandidate(built.packageSha256,
      [{ operationId: 'text.clean', input: { source: 'Hi' }, extra: 'unsafe' }] as never))
      .rejects.toThrow('COMPUTE_REVIEWABLE_SAMPLE_INVALID')
    const path = join(root, 'candidates', `${built.packageSha256}.json`)
    const bytes = await readFile(path)
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]))
    await expect(reopened.export(built.packageSha256)).rejects.toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
    await expect(service.tryReviewableExecutionCandidate(built.packageSha256,
      [{ operationId: 'text.clean', input: { source: 'Hi' } }]))
      .rejects.toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  } finally { await service.close() }
})

it('blocks stale drafts, unsupported bindings and missing operation samples before claiming success', async () => {
  const { draft, drafts, service } = await setup()
  try {
    await expect(service.buildReviewableExecutionCandidate({ draftId: draft.id,
      expectedUpdatedAt: 'old', capabilityIds: claims, programs }))
      .rejects.toThrow('COMPUTE_PLUGIN_DRAFT_REVISION_STALE')
    await expect(service.buildReviewableExecutionCandidate({ draftId: draft.id,
      expectedUpdatedAt: draft.updatedAt, capabilityIds: {}, programs }))
      .rejects.toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
    const changed = await drafts.save({ id: draft.id, spec: { ...spec, operations: [
      { ...operation, binding: { kind: 'workflow', ref: 'flow:unknown' } },
    ] } })
    await expect(service.buildReviewableExecutionCandidate({ draftId: changed.id,
      expectedUpdatedAt: changed.updatedAt, capabilityIds: claims, programs }))
      .rejects.toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  } finally { await service.close() }
})

it('creator tool builds a private candidate and runs only after fresh owner approval', async () => {
  const { draft, service } = await setup()
  const ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt)
  const runtime = await ctx.plugin(ToolRuntime)
  ctx.provide('computeCore', service)
  const plugin = await ctx.plugin(PluginDraftTools)
  let outcome = 'rejected'
  let approvals = 0
  ctx.provide('approval' as never, { request: async (request: { reason: string }) => {
    approvals += 1
    expect(request.reason).toContain('样例摘要')
    expect(request.reason).not.toContain('private input')
    return outcome
  } } as never)
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal,
    callId: ToolCallId('reviewable-call'), name, arguments: args, agent: {} as never })
  const value = (result: Awaited<ReturnType<typeof call>>) => {
    const text = result.content.find(item => item.type === 'text')
    return text?.type === 'text' ? JSON.parse(text.text) as Record<string, unknown> : {}
  }
  try {
    const built = await call('plugin_reviewable_build', { id: draft.id,
      expectedUpdatedAt: draft.updatedAt, capabilityIds: claims, programs })
    expect(built.isError).not.toBe(true)
    const receipt = value(built)
    expect(receipt).toMatchObject({ pluginId: 'creator.clean', reviewed: false,
      installable: false, publishable: false, dispatchable: false })
    const packageSha256 = receipt.packageSha256 as string
    const sample = { packageSha256, samples: [{ operationId: 'text.clean', input: { source: '  private input  ' } }] }
    expect((await call('plugin_reviewable_try_sample', sample)).isError).toBe(true)
    expect(approvals).toBe(1)
    outcome = 'allowed-once'
    const tried = await call('plugin_reviewable_try_sample', sample)
    expect(tried.isError).not.toBe(true)
    expect(value(tried)).toMatchObject({ sampleExecuted: true, reviewed: false,
      installable: false, dispatchable: false,
      results: [{ operationId: 'text.clean', output: { cleaned: 'private input' } }] })
    expect(approvals).toBe(2)
    const invalid = await call('plugin_reviewable_try_sample', { packageSha256,
      samples: [{ operationId: 'unlisted', input: { source: 'x' } }] })
    expect(invalid.isError).toBe(true)
    expect(approvals).toBe(2)
  } finally { await plugin.dispose(); await runtime.dispose(); await prompt.dispose(); await service.close() }
})
