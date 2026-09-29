import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { ComfyPrivateTrialLedger } from '../src/comfy-private-trial-ledger.ts'
import { PrivateComfyTrialHost } from '../src/comfy-private-trial.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(kind: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(kind, 4, 'ascii')
  const data = Buffer.concat([header.subarray(4), body])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(data), 0)
  return Buffer.concat([header, body, checksum])
}
function png(width = 256, height = 256): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(height * (1 + width * 3))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false }
const graph = {
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'owner.gguf' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private template', clip: ['1', 0] } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'Qianshou' } },
}
const mapping = { prompt: { nodeId: '2', field: 'text' }, outputNodeId: '3' }
function spec() {
  return { pluginId: 'owner.sample', version: '1.0.0', displayName: '本机样例', operations: [
    { id: 'owner.sample.render', title: '出一张样例', description: '本机私有图',
      binding: { kind: 'workflow', ref: 'comfy:owner-sample' }, inputSchema: schema, outputSchema: schema,
      permissions: ['network.declared', 'gpu'], dataScope: 'task-inputs', networkOrigins: ['http://127.0.0.1:8188/'],
      dependencies: [], resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0,
        maxInputBytes: 1024, maxOutputBytes: 16 * 1024 * 1024, maxRunMs: 600000 } },
  ] }
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-private-comfy-'))
  roots.push(root)
  const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 1_000_000 })
  const draft = await drafts.save({ spec: spec() })
  await drafts.bindComfyAsset({ id: draft.id, expectedUpdatedAt: draft.updatedAt,
    operationId: 'owner.sample.render', workflow: graph, mapping })
  const ledger = new ComfyPrivateTrialLedger(join(root, 'trial-ledger.json'))
  const outputRoot = join(root, 'outputs')
  const request = { ownerId: 'owner-1', draftId: draft.id, operationId: 'owner.sample.render',
    idempotencyKey: 'owner-trial-1', port: 8188, prompt: 'one small cat', agent: {},
    signal: new AbortController().signal }
  return { root, drafts, ledger, outputRoot, request }
}

interface FakeComfyOptions {
  modelAvailable?: boolean
  submitUnknown?: boolean
  crossHistory?: boolean
  corruptPng?: boolean
  delayedHistory?: boolean
  failedHistory?: boolean
  unsafeFilename?: boolean
  redirectView?: boolean
  onHistory?: () => void
}
function fakeComfy(options: FakeComfyOptions = {}) {
  const calls: string[] = []
  let promptId = ''
  let submittedGraph: Record<string, { inputs: Record<string, unknown> }> | null = null
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname.startsWith('/object_info/')) {
      const name = url.pathname.split('/').at(-1) ?? ''
      if (name === 'UnetLoaderGGUF') return json({ [name]: { input: { required: {
        unet_name: [[options.modelAvailable === false ? 'other.gguf' : 'owner.gguf']],
      } } } })
      return json({ [name]: { input: { required: {} } } })
    }
    if (url.pathname === '/prompt' && init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON body')
      const body = JSON.parse(init.body) as { prompt_id: string; prompt: typeof graph }
      promptId = body.prompt_id
      submittedGraph = body.prompt
      if (options.submitUnknown) throw new Error('response lost after enqueue')
      return json({ prompt_id: promptId, number: 0, node_errors: {} })
    }
    if (url.pathname.startsWith('/history/')) {
      options.onHistory?.()
      if (options.delayedHistory) return json({})
      const key = options.crossHistory ? 'other-prompt-id' : promptId
      return json({ [key]: { status: { status_str: options.failedHistory ? 'error' : 'success' },
        outputs: { '3': { images: [{ filename: options.unsafeFilename ? '../other.png' : 'sample.png',
          subfolder: '', type: 'output' }] } } } })
    }
    if (url.pathname === '/view' && options.redirectView) return Response.redirect('https://example.invalid/somewhere')
    if (url.pathname === '/view') return new Response(new Uint8Array(options.corruptPng ? Buffer.from('not-png') : png()),
      { headers: { 'content-type': 'image/png' } })
    if (url.pathname.endsWith('/cancel')) return json({ cancelled: true })
    throw new Error(`Unexpected ${url.pathname}`)
  }
  return { fetcher, calls, get submittedGraph() { return submittedGraph }, get promptId() { return promptId } }
}

describe('Host-only private Comfy sample trial', () => {
  it('requires one owner decision then submits once, binds history output and saves verified private PNG', async () => {
    const state = await setup()
    const comfy = fakeComfy()
    const reasons: string[] = []
    const host = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
      approval: { request: async ({ reason }) => { reasons.push(reason); return 'allowed-once' } },
      workspaceRoot: join(state.root, 'work'), outputRoot: state.outputRoot, fetcher: comfy.fetcher,
      pollMs: 1, maxWaitMs: 30 })
    const receipt = await host.run(state.request)
    expect(receipt).toMatchObject({ status: 'completed', installable: false, dispatchable: false,
      result: { width: 256, height: 256 } })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(receipt.graphSha256)
    expect(reasons[0]).not.toContain('one small cat')
    expect(comfy.submittedGraph?.['2']?.inputs.text).toBe('one small cat')
    expect(comfy.submittedGraph?.['1']?.inputs.unet_name).toBe('owner.gguf')
    expect(comfy.submittedGraph?.['3']?.inputs.filename_prefix).toMatch(/^qs_trial_[a-f0-9]{12}$/u)
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    const output = await readFile(join(state.outputRoot, `${receipt.trialId}.png`))
    expect(createHash('sha256').update(output).digest('hex')).toBe(receipt.result.sha256)
    expect(await host.readImage(receipt.trialId, state.request.ownerId)).toEqual(output)
    await expect(host.readImage(receipt.trialId, 'another-owner')).rejects.toThrow('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE')
    await expect(host.readImage('../sample.png', state.request.ownerId)).rejects.toThrow('COMPUTE_COMFY_TRIAL_INVALID')
    expect((await stat(join(state.outputRoot, `${receipt.trialId}.png`))).mode & 0o777).toBe(0o600)
    expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('completed')
    await expect(host.run(state.request)).rejects.toThrow('COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED')
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    expect(reasons).toHaveLength(1)
    await state.drafts.close()
  })

  it('rejects missing approval or exact model before any POST or ledger reservation', async () => {
    const state = await setup()
    const comfy = fakeComfy()
    const denied = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'rejected' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher })
    await expect(denied.run(state.request)).rejects.toThrow('COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED')
    expect(await state.ledger.get(state.request.idempotencyKey)).toBeNull()
    const missing = fakeComfy({ modelAvailable: false })
    const blocked = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => { throw new Error('approval must not be asked') } },
      workspaceRoot: join(state.root, 'work'), outputRoot: state.outputRoot, fetcher: missing.fetcher })
    await expect(blocked.run(state.request)).rejects.toThrow('COMPUTE_COMFY_TRIAL_PREFLIGHT_FAILED')
    expect([...comfy.calls, ...missing.calls]).not.toContain('POST /prompt')
    await state.drafts.close()
  })

  it('records a lost POST result as unknown and never replays the same key or another job on its port', async () => {
    const state = await setup()
    const comfy = fakeComfy({ submitUnknown: true })
    const host = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher })
    await expect(host.run(state.request)).rejects.toThrow('COMPUTE_COMFY_BACKEND_UNAVAILABLE')
    expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('submission-unknown')
    await expect(host.run(state.request)).rejects.toThrow('COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED')
    await expect(host.run({ ...state.request, idempotencyKey: 'second-trial' })).rejects.toThrow('COMPUTE_COMFY_TRIAL_PORT_BUSY')
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    await state.drafts.close()
  })

  it('recovers a lost POST after a Host restart by reading only the exact prompt history and PNG', async () => {
    const state = await setup()
    const comfy = fakeComfy({ submitUnknown: true })
    const options = { drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher }
    await expect(new PrivateComfyTrialHost(options).run(state.request))
      .rejects.toThrow('COMPUTE_COMFY_BACKEND_UNAVAILABLE')
    const record = await state.ledger.get(state.request.idempotencyKey)
    expect(record).toMatchObject({ status: 'submission-unknown', outputNodeId: '3' })
    // A prior process may have written the verified image just before ledger completion.
    await mkdir(state.outputRoot, { recursive: true })
    await writeFile(join(state.outputRoot, `${record!.trialId}.png`), png(), { mode: 0o600 })
    const restarted = new PrivateComfyTrialHost(options)
    const result = await restarted.reconcile(record!.trialId, state.request.ownerId,
      new AbortController().signal)
    expect(result).toMatchObject({ status: 'completed', trialId: record!.trialId,
      result: { width: 256, height: 256 }, installable: false, dispatchable: false })
    expect(await restarted.readImage(record!.trialId, state.request.ownerId)).toEqual(png())
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    expect(comfy.calls.filter(call => call === `GET /history/${record!.promptId}`)).toHaveLength(1)
    expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('completed')
    await expect(restarted.run(state.request)).rejects.toThrow('COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED')
    await state.drafts.close()
  })

  it('keeps an unknown prompt blocked until exact history proves failure', async () => {
    const state = await setup()
    const comfy = fakeComfy({ submitUnknown: true, delayedHistory: true })
    const options = { drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher }
    await expect(new PrivateComfyTrialHost(options).run(state.request)).rejects.toThrow()
    const record = await state.ledger.get(state.request.idempotencyKey)
    const restarted = new PrivateComfyTrialHost(options)
    expect(await restarted.reconcile(record!.trialId, state.request.ownerId,
      new AbortController().signal)).toMatchObject({ status: 'pending' })
    await expect(restarted.run({ ...state.request, idempotencyKey: 'new-key' }))
      .rejects.toThrow('COMPUTE_COMFY_TRIAL_PORT_BUSY')
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    await state.drafts.close()
  })

  it('accepts only the same owner for reconciliation and closes a proven failed prompt', async () => {
    const state = await setup()
    const comfy = fakeComfy({ submitUnknown: true, failedHistory: true })
    const options = { drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher }
    await expect(new PrivateComfyTrialHost(options).run(state.request)).rejects.toThrow()
    const record = await state.ledger.get(state.request.idempotencyKey)
    const restarted = new PrivateComfyTrialHost(options)
    await expect(restarted.reconcile(record!.trialId, 'another-owner', new AbortController().signal))
      .rejects.toThrow('COMPUTE_COMFY_TRIAL_RESULT_UNAVAILABLE')
    expect(await restarted.reconcile(record!.trialId, state.request.ownerId,
      new AbortController().signal)).toMatchObject({ status: 'rejected', installable: false, dispatchable: false })
    expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('rejected')
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    expect(comfy.calls).not.toContain('GET /view')
    await state.drafts.close()
  })

  it('refuses cross-prompt history and corrupt PNG without producing a success receipt', async () => {
    for (const variant of [{ crossHistory: true }, { corruptPng: true }]) {
      const state = await setup()
      const comfy = fakeComfy(variant)
      const host = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
        approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
        outputRoot: state.outputRoot, fetcher: comfy.fetcher, pollMs: 1, maxWaitMs: 5 })
      await expect(host.run(state.request)).rejects.toThrow()
      const status = (await state.ledger.get(state.request.idempotencyKey))?.status
      expect(status).toBe('crossHistory' in variant ? 'cancel-uncertain' : 'rejected')
      expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
      if ('crossHistory' in variant) expect(comfy.calls).not.toContain('GET /view')
      await state.drafts.close()
    }
  })

  it('refuses path-bearing history references and redirects without reading another origin', async () => {
    for (const variant of [{ unsafeFilename: true }, { redirectView: true }]) {
      const state = await setup()
      const comfy = fakeComfy(variant)
      const host = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
        approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
        outputRoot: state.outputRoot, fetcher: comfy.fetcher })
      await expect(host.run(state.request)).rejects.toThrow('COMPUTE_COMFY_BACKEND_INVALID')
      expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
      expect(comfy.calls.every(call => !call.includes('/interrupt') && !call.includes('example.invalid'))).toBe(true)
      expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('rejected')
      await state.drafts.close()
    }
  })

  it('records owner cancellation after enqueue without a global interrupt or second POST', async () => {
    const state = await setup()
    const controller = new AbortController()
    const comfy = fakeComfy({ delayedHistory: true, onHistory: () => { controller.abort() } })
    const host = new PrivateComfyTrialHost({ drafts: state.drafts, ledger: state.ledger,
      approval: { request: async () => 'allowed-once' }, workspaceRoot: join(state.root, 'work'),
      outputRoot: state.outputRoot, fetcher: comfy.fetcher, pollMs: 1, maxWaitMs: 20,
      supportsIdScopedCancel: true })
    await expect(host.run({ ...state.request, signal: controller.signal })).rejects.toThrow()
    expect((await state.ledger.get(state.request.idempotencyKey))?.status).toBe('cancel-uncertain')
    expect(comfy.calls.filter(call => call === 'POST /prompt')).toHaveLength(1)
    expect(comfy.calls.filter(call => call.endsWith('/cancel'))).toHaveLength(1)
    expect(comfy.calls.every(call => !call.includes('/interrupt'))).toBe(true)
    await state.drafts.close()
  })
})
