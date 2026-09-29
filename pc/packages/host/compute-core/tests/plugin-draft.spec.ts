import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeError } from '../src/errors.ts'
import { LocalPluginDraftStore, parsePluginDraftSpec } from '../src/plugin-draft.ts'
import { previewPluginDraft } from '../src/plugin-draft-preview.ts'
import { registerRoutes } from '../src/routes.ts'
import type { ComputeService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function schema(properties: Record<string, unknown> = { prompt: { type: 'string' } }): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

function spec(): Record<string, unknown> {
  const resources = { platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    minTotalMemoryBytes: 8_000_000_000, minFreeDiskBytes: 1_000_000_000, minVramBytes: 4_000_000_000,
    maxInputBytes: 10_000_000, maxOutputBytes: 100_000_000, maxRunMs: 60_000 }
  return {
    pluginId: 'maker.studio', version: '1.0.0', displayName: '我的创作工具', operations: [
      { id: 'maker.studio.image', title: '画图', description: '调用机主自己的模型生成图片',
        binding: { kind: 'local-model', ref: 'ollama:private-model' },
        inputSchema: schema({ prompt: { type: 'string' }, size: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false } }),
        outputSchema: schema({ images: { type: 'array', items: { type: 'string' } } }),
        permissions: ['model.local', 'gpu'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
      { id: 'maker.studio.subtitle', title: '字幕', description: '本机工作流给视频加字幕',
        binding: { kind: 'workflow', ref: 'flow:subtitle-v1' }, inputSchema: schema({ video: { type: 'string' } }),
        outputSchema: schema({ subtitle: { type: 'string' } }), permissions: ['workspace.read', 'network.declared'],
        dataScope: 'workspace', networkOrigins: ['https://example.test/'], dependencies: [{ id: 'ffmpeg', version: '>=6.0.0' }],
        resources: { ...resources, minVramBytes: 0 } },
    ],
  }
}

describe('private plugin builder recipes', () => {
  it('accepts multiple freely named operations with bounded I/O schemas and declared local bindings', () => {
    const parsed = parsePluginDraftSpec(spec())
    expect(parsed.operations.map(item => item.id)).toEqual(['maker.studio.image', 'maker.studio.subtitle'])
    expect(parsed.operations[1]?.binding).toEqual({ kind: 'workflow', ref: 'flow:subtitle-v1' })
    expect(parsed.operations[0]?.outputSchema).toMatchObject({ type: 'object', properties: { images: { type: 'array' } } })
  })

  it('can describe a logical local tool without claiming that the tool is installed or executable', async () => {
    const base = spec()
    const source = (base.operations as Record<string, unknown>[])[1]!
    const tool = { ...source, id: 'maker.studio.csv-profile', title: 'CSV 体检',
      binding: { kind: 'tool', ref: 'builtin:csv-profile' },
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: { ...(source.resources as object), minVramBytes: 0 } }
    const parsed = parsePluginDraftSpec({ ...base, operations: [tool] })
    expect(parsed.operations[0]?.binding).toEqual({ kind: 'tool', ref: 'builtin:csv-profile' })
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-tool-draft-'))
    roots.push(root)
    const store = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 2, maxBytes: 131072 })
    const saved = await store.save({ spec: { ...base, operations: [tool] } })
    const plan = await store.preview(saved.id)
    expect(saved).toMatchObject({ state: 'private-draft', installable: false, dispatchable: false })
    expect(plan).toMatchObject({ manifest: { installable: false, dispatchable: false,
      operations: [{ bindingKind: 'tool' }] }, checks: [{ binding: 'unverified' }] })
    expect(plan.contents).not.toContain('builtin:csv-profile')
  })

  it('rejects executable fields, credential-like bindings, remote schema references and inconsistent permissions', () => {
    const base = spec()
    const operations = base.operations as Record<string, unknown>[]
    for (const replacement of [
      { ...operations[0], command: 'curl https://example.test' },
      { ...operations[0], binding: { kind: 'local-model', ref: '/Users/me/private/model' } },
      { ...operations[0], binding: { kind: 'local-model', ref: 'C:/Users/me/private/model' } },
      { ...operations[0], binding: { kind: 'local-model', ref: 'https://server/model?token=x' } },
      { ...operations[0], inputSchema: { type: 'object', properties: { prompt: { $ref: 'https://example.test/schema' } }, required: ['prompt'], additionalProperties: false } },
      { ...operations[0], permissions: ['gpu'] },
      { ...operations[0], resources: { ...(operations[0]?.resources as object), minVramBytes: 4_000_000_000 }, permissions: ['model.local'] },
      { ...operations[0], dataScope: 'workspace' },
    ]) {
      expect(() => parsePluginDraftSpec({ ...base, operations: [replacement, operations[1]] })).toThrow(ComputeError)
    }
    expect(() => parsePluginDraftSpec({ ...base, operations: [operations[0], operations[0]] })).toThrow(ComputeError)
    expect(() => parsePluginDraftSpec({ ...base, priceMinor: 1 })).toThrow(ComputeError)
  })

  it('saves private drafts atomically, updates one id and exports data without runnable authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-draft-'))
    roots.push(root)
    const path = join(root, 'private', 'plugin-drafts.json')
    const store = new LocalPluginDraftStore({ path, maxDrafts: 2, maxBytes: 131072 })
    const saved = await store.save({ spec: spec() })
    expect(saved).toMatchObject({ state: 'private-draft', installable: false, dispatchable: false,
      readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' } })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const exported = await store.export(saved.id)
    expect(exported.fileName).toBe('maker.studio-1.0.0.plugin-draft.json')
    const body = JSON.parse(exported.contents) as Record<string, unknown>
    expect(body).toMatchObject({ format: 'qianshou.plugin-draft.v1', state: 'private-draft', installable: false, dispatchable: false })
    expect(exported.contents).not.toContain('pluginDigest')
    expect(exported.contents).not.toContain('signature')
    expect(exported.contents).not.toContain('public')
    const preview = await store.preview(saved.id)
    expect(preview).toMatchObject({ state: 'pending', manifest: { installable: false, dispatchable: false } })
    expect(preview.checks[0]).toMatchObject({ operationId: 'maker.studio.image', binding: 'unverified', gpuMemory: 'not-probed' })
    expect(JSON.parse(preview.contents)).toEqual(preview.manifest)
    expect(preview.manifestSha256).toBe(createHash('sha256').update(preview.contents.trim()).digest('hex'))
    expect(preview.contents).not.toContain('ollama:private-model')
    expect(preview.contents).not.toContain('https://example.test/')
    expect(preview.contents).not.toContain('调用机主自己的模型生成图片')
    const changed = await store.save({ id: saved.id, spec: { ...spec(), displayName: '新名字' } })
    expect(changed.id).toBe(saved.id)
    expect(changed.createdAt).toBe(saved.createdAt)
    expect((await store.list())).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toContain('新名字')
    await store.close()
    await expect(store.save({ spec: spec() })).rejects.toThrow('COMPUTE_CLOSED')
  })

  it('produces a deterministic data-only plan and distinguishes mismatch from unverified checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-preview-'))
    roots.push(root)
    const store = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 3, maxBytes: 131072 })
    const original = spec()
    const first = await store.save({ spec: original })
    const reversed = { ...original, operations: [...(original.operations as unknown[])].reverse() }
    const second = await store.save({ spec: reversed })
    const firstPlan = await store.preview(first.id)
    const secondPlan = await store.preview(second.id)
    expect(firstPlan.contents).toBe(secondPlan.contents)
    expect(firstPlan.manifestSha256).toBe(secondPlan.manifestSha256)
    const changedOperation = { ...(original.operations as Record<string, unknown>[])[0],
      inputSchema: schema({ prompt: { type: 'integer' } }) }
    const changed = await store.save({ spec: { ...original,
      operations: [changedOperation, (original.operations as unknown[])[1]] } })
    expect((await store.preview(changed.id)).manifestSha256).not.toBe(firstPlan.manifestSha256)
    expect(firstPlan.contents).not.toContain(first.id)
    expect(firstPlan.contents).not.toContain(first.createdAt)
    const blocked = previewPluginDraft(first, {
      platform: 'linux', architecture: 'ia32', totalMemoryBytes: 1_000_000_000, freeDiskBytes: 1000,
    })
    expect(blocked.state).toBe('blocked')
    expect(blocked.checks[0]).toMatchObject({ platform: 'mismatched', architecture: 'mismatched',
      memory: 'mismatched', disk: 'mismatched', gpuMemory: 'not-probed', state: 'blocked' })
    const unmeasured = previewPluginDraft(first, {
      platform: 'darwin', architecture: 'arm64', totalMemoryBytes: 16_000_000_000, freeDiskBytes: null,
    })
    expect(unmeasured.state).toBe('pending')
    expect(unmeasured.checks[0]).toMatchObject({ platform: 'matched', architecture: 'matched',
      disk: 'not-probed', gpuMemory: 'not-probed', binding: 'unverified' })
    await expect(store.preview('../../drafts.json')).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_INVALID')
    await store.close()
  })

  it('fails closed on tampering or capacity and does not overwrite the existing private file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-draft-'))
    roots.push(root)
    const path = join(root, 'drafts.json')
    const store = new LocalPluginDraftStore({ path, maxDrafts: 1, maxBytes: 131072 })
    await store.save({ spec: spec() })
    await expect(store.save({ spec: spec() })).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_CAPACITY')
    const raw = await readFile(path, 'utf8')
    const document = JSON.parse(raw) as { drafts: Array<Record<string, unknown>> }
    document.drafts[0]!.installable = true
    const tampered = JSON.stringify(document)
    await writeFile(path, tampered)
    await expect(store.list()).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_STORE_INVALID')
    await expect(store.save({ spec: spec() })).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_STORE_INVALID')
    expect(await readFile(path, 'utf8')).toBe(tampered)
    await store.close()
  })

  it('registers owner-carrier save/list/export routes with no install or publish operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-route-'))
    roots.push(root)
    const store = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 2, maxBytes: 131072 })
    const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
    const context = { connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route); return () => { routes.delete(route.path) }
    } } }, effect: (activate: () => () => void) => { activate() },
    inject: (services: readonly string[]) => {
      // This route-only carrier has no live Session or attachment providers.
      expect(services).toEqual(['agents', 'fileUploads', 'attachments'])
    } } as unknown as Context
    const service = {
      localPluginDrafts: () => store.list(), saveLocalPluginDraft: (value: unknown) => store.save(value),
      exportLocalPluginDraft: (id: unknown) => store.export(id),
      previewLocalPluginDraft: (id: unknown) => store.preview(id),
      recentLocalPluginComfyTrials: async () => [{ trialId: 'trial-1', status: 'submission-unknown',
        updatedAt: '2026-09-24T00:00:00.000Z' }],
      reconcileLocalPluginComfyTrial: async (id: string) => {
        if (id !== 'trial-1') throw new ComputeError('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE', 404)
        return { trialId: id, status: 'pending', installable: false, dispatchable: false }
      },
      readLocalPluginComfyTrialImage: async (id: string) => {
        if (id !== 'trial-1') throw new ComputeError('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE', 404)
        return Buffer.from('verified-by-host')
      },
    } as unknown as ComputeService
    registerRoutes(context, service, 65536)
    expect(routes.has('/api/qianshou/compute/files/from-composer')).toBe(false)
    const endpoint = routes.get('/api/qianshou/compute/plugin-drafts')
    const exportEndpoint = routes.get('/api/qianshou/compute/plugin-drafts/export')
    const previewEndpoint = routes.get('/api/qianshou/compute/plugin-drafts/preview')
    const sampleImageEndpoint = routes.get('/api/qianshou/compute/plugin-drafts/comfy-trials/image')
    const trialsEndpoint = routes.get('/api/qianshou/compute/plugin-drafts/comfy-trials')
    const reconcileEndpoint = routes.get('/api/qianshou/compute/plugin-drafts/comfy-trials/reconcile')
    expect(endpoint).toBeDefined()
    expect(exportEndpoint).toBeDefined()
    expect(previewEndpoint).toBeDefined()
    expect(sampleImageEndpoint).toBeDefined()
    expect(trialsEndpoint).toBeDefined()
    expect(reconcileEndpoint).toBeDefined()
    expect([...routes.keys()]).not.toContain('/api/qianshou/compute/plugin-drafts/publish')
    const saved = await endpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: spec() }),
    }))
    expect(saved.status).toBe(200)
    const draft = await saved.json() as { id: string; state: string }
    expect(draft.state).toBe('private-draft')
    const listed = await endpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts'))
    expect((await listed.json() as unknown[])).toHaveLength(1)
    const exported = await exportEndpoint!.fetch(new Request(`http://localhost/api/qianshou/compute/plugin-drafts/export?id=${draft.id}`))
    expect((await exported.json() as { contents: string }).contents).toContain('qianshou.plugin-draft.v1')
    const preview = await previewEndpoint!.fetch(new Request(`http://localhost/api/qianshou/compute/plugin-drafts/preview?id=${draft.id}`))
    expect(preview.status).toBe(200)
    const body = await preview.json() as { manifest: Record<string, unknown>; checks: Array<Record<string, unknown>>; state: string }
    expect(body).toMatchObject({ manifest: { format: 'qianshou.plugin-package-plan.v1', installable: false }, state: 'pending' })
    expect(body.checks[0]).toMatchObject({ binding: 'unverified' })
    const unsafe = await previewEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/preview?id=..%2F..%2Fprivate'))
    expect(unsafe.status).toBe(400)
    const sample = await sampleImageEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials/image?id=trial-1'))
    expect(sample.status).toBe(200)
    expect(sample.headers.get('content-type')).toBe('image/png')
    expect(sample.headers.get('cache-control')).toBe('private, no-store')
    expect(await sample.text()).toBe('verified-by-host')
    const other = await sampleImageEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials/image?id=other'))
    expect(other.status).toBe(404)
    const ambiguous = await sampleImageEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials/image?id=trial-1&path=/tmp'))
    expect(ambiguous.status).toBe(400)
    const trials = await trialsEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials'))
    expect(await trials.json()).toEqual([{ trialId: 'trial-1', status: 'submission-unknown',
      updatedAt: '2026-09-24T00:00:00.000Z' }])
    const reconcile = await reconcileEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials/reconcile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'trial-1' }),
    }))
    expect(await reconcile.json()).toMatchObject({ status: 'pending', installable: false, dispatchable: false })
    const injected = await reconcileEndpoint!.fetch(new Request('http://localhost/api/qianshou/compute/plugin-drafts/comfy-trials/reconcile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'trial-1', path: '/tmp' }),
    }))
    expect(injected.status).toBe(400)
    await store.close()
  })
})
