import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as PluginDraftTools from '../src/plugin-draft-tools.ts'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { pluginDraftPlanManifest } from '../src/plugin-draft-preview.ts'
import { HostPluginSampleWorkbench } from '../src/private-plugin-sample-workbench.ts'
import { PrivateOfflinePluginArtifactStore } from '../src/private-offline-plugin-artifact-store.ts'
import { PrivatePluginActivationLedger } from '../src/private-plugin-activation-ledger.ts'
import { PrivatePluginInvocationLedger } from '../src/private-plugin-invocation-ledger.ts'
import { PrivatePluginActivationHost } from '../src/private-plugin-activation.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(run: (input: unknown, signal: AbortSignal) => unknown = input => input) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-private-activation-'))
  roots.push(root)
  const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
  const spec = { pluginId: 'owner.echo', version: '1.0.0', displayName: '私有回声', operations: [{
    id: 'echo.text', title: 'Echo', description: 'Echo one short text.',
    binding: { kind: 'tool', ref: 'host:echo' },
    inputSchema: { type: 'object', properties: { value: { type: 'string' } },
      required: ['value'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } },
      required: ['value'], additionalProperties: false },
    permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
    resources: { platforms: [process.platform], architectures: [process.arch],
      minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 4096,
      maxOutputBytes: 4096, maxRunMs: 1000 },
  }] }
  const draft = await drafts.save({ spec })
  const plan = pluginDraftPlanManifest(draft).operations[0]!
  const workbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
  const contract = { adapterId: 'host.echo', adapterVersion: '1.0.0', operationId: 'echo.text',
    bindingKind: 'tool' as const, bindingRef: 'host:echo', inputSchemaSha256: plan.inputSchemaSha256,
    outputSchemaSha256: plan.outputSchemaSha256, permissions: draft.spec.operations[0]!.permissions,
    dataScope: draft.spec.operations[0]!.dataScope,
    networkOrigins: draft.spec.operations[0]!.networkOrigins,
    dependencies: draft.spec.operations[0]!.dependencies,
    resources: draft.spec.operations[0]!.resources, assets: [], validUntilMs: Date.now() + 3_600_000 }
  const dispose = workbench.register({ contract, run })
  const sample = await workbench.runPrivateSamples(draft,
    [{ operationId: 'echo.text', input: { value: 'sample' } }], new AbortController().signal)
  const artifacts = new PrivateOfflinePluginArtifactStore(join(root, 'artifacts'))
  await artifacts.persist(sample.artifact)
  const ledger = new PrivatePluginActivationLedger(join(root, 'activation.json'))
  const invocations = new PrivatePluginInvocationLedger(join(root, 'invocations.json'))
  const approval = { request: vi.fn(async (_request: { readonly toolName: string; readonly reason: string }) => 'allowed-once') }
  const host = new PrivatePluginActivationHost({ drafts, artifacts, workbench, ledger, invocations, approval })
  const hashes = { packageSha256: sample.artifact.packageSha256,
    candidateSha256: sample.artifact.candidateSha256 }
  const authority = { agent: { id: 'owner-session' }, callId: 'call-1', signal: new AbortController().signal }
  return { root, drafts, draft, spec, contract, workbench, artifacts, ledger, invocations, approval, host,
    hashes, authority, dispose }
}

describe('private plugin activation', () => {
  it('prepares a redacted declaration only from a current private install and explicit operation claim', async () => {
    const value = await setup()
    const input = { draftId: value.draft.id, expectedUpdatedAt: value.draft.updatedAt,
      ...value.hashes, capabilityIds: { 'echo.text': 'owner.echo' }, signal: value.authority.signal }
    await expect(value.host.prepareSubmission(input))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_NOT_INSTALLED' })
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    const prepared = await value.host.prepareSubmission(input)
    expect(prepared.preview).toMatchObject({ state: 'built-offline-unsubmitted', uploaded: false,
      reviewed: false, publishable: false, dispatchable: false, sourceDraftId: value.draft.id,
      sourceDraftUpdatedAt: value.draft.updatedAt, packageBytes: prepared.archive.length,
      sourcePrivatePackageSha256: value.hashes.packageSha256,
      sourceCandidateSha256: value.hashes.candidateSha256,
      manifest: { format: 'qianshou.declaration.v1', pluginId: 'owner.echo',
        operations: [{ capabilityId: 'owner.echo', operationId: 'echo.text', executorKind: 'tool' }] } })
    expect(JSON.stringify(prepared.preview)).not.toContain('sample')
    expect(JSON.stringify(prepared.preview)).not.toContain(value.root)
    expect(prepared.archive.toString('utf8')).not.toContain('"value":"sample"')
    expect(prepared.archive.toString('utf8')).not.toContain('host:echo')
    expect(Buffer.isBuffer(prepared.archive)).toBe(true)
    await expect(value.host.prepareSubmission({ ...input, capabilityIds: { 'wrong.operation': 'owner.echo' } }))
      .rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_DECLARATION_INVALID' })
    await expect(value.host.prepareSubmission({ ...input, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_DRAFT_STALE' })
    await value.host.uninstall(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    await expect(value.host.prepareSubmission(input))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_NOT_INSTALLED' })
    value.dispose()
    await value.host.close()
  })

  it('refuses declaration preparation when the saved draft, adapter or private sample archive changes', async () => {
    const value = await setup()
    const input = { draftId: value.draft.id, expectedUpdatedAt: value.draft.updatedAt,
      ...value.hashes, capabilityIds: { 'echo.text': 'owner.echo' }, signal: value.authority.signal }
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    value.dispose()
    await expect(value.host.prepareSubmission(input))
      .rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE' })
    const disposeAgain = value.workbench.register({ contract: value.contract, run: item => item })
    await value.drafts.save({ id: value.draft.id, spec: value.spec })
    await expect(value.host.prepareSubmission(input))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_DRAFT_STALE' })
    disposeAgain()
    await value.host.close()

    const altered = await setup()
    const second = { draftId: altered.draft.id, expectedUpdatedAt: altered.draft.updatedAt,
      ...altered.hashes, capabilityIds: { 'echo.text': 'owner.echo' }, signal: altered.authority.signal }
    await altered.host.activate(altered.hashes.packageSha256, altered.hashes.candidateSha256, altered.authority)
    await writeFile(join(altered.root, 'artifacts', `artifact-${altered.hashes.packageSha256}.zip`), 'changed')
    await expect(altered.host.prepareSubmission(second))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    altered.dispose()
    await altered.host.close()
  })

  it('exposes the private read through a real Host Loader composition', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-private-loader-'))
    roots.push(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'private-compute-fixture'",
      "- name: '@deepseek-ai/dsh-compute-core/plugin-draft-tools'",
      '',
    ].join('\n'))
    const summary = { pluginId: 'owner.echo', displayName: '私有回声', version: '1.0.0',
      packageSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
      state: 'active-private', scope: 'private-local', dispatchable: false, publishable: false }
    const fixture = { name: 'private-compute-fixture', apply(ctx: Context) {
      ctx.provide('computeCore', { listPrivatePluginActivations: async () => [summary] } as never)
    } }
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['private-compute-fixture', fixture],
      ['@deepseek-ai/dsh-compute-core/plugin-draft-tools', PluginDraftTools],
    ])
    const ctx = await boot('private-plugin-read', configPath, undefined, (preparing) => {
      preparing.loader.internal = { version: 'v2', async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      } } as unknown as NonNullable<typeof preparing.loader.internal>
    })
    try {
      const result = await ctx.tools.execute({ name: 'plugin_private_list', arguments: {},
        callId: ToolCallId('list-private'), signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      const block = result.content.find(item => item.type === 'text')
      expect(block?.type === 'text' ? block.text : '').toContain('"displayName":"私有回声"')
      expect(ctx.tools.get('plugin_private_activate')).toBeDefined()
      expect(ctx.tools.get('plugin_private_run')).toBeDefined()
      expect(ctx.tools.get('plugin_private_uninstall')).toBeDefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('persists an exact private install, rechecks after restart, runs in conversation and uninstalls', async () => {
    const value = await setup()
    expect(await value.host.list()).toEqual([])
    const installed = await value.host.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority)
    expect(installed).toMatchObject({ displayName: '私有回声', state: 'active-private',
      scope: 'private-local', dispatchable: false, publishable: false,
      operations: [{ operationId: 'echo.text', adapterId: 'host.echo', adapterVersion: '1.0.0' }] })
    expect(value.approval.request.mock.calls[0]?.[0]?.toolName).toBe('plugin_private_activate')
    expect(value.approval.request.mock.calls[0]?.[0]?.reason).toContain(value.hashes.packageSha256)
    const result = await value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'conversation' }, value.authority)
    expect(result).toMatchObject({ state: 'completed-private',
      output: { value: 'conversation' }, dispatchable: false })
    const restartedWorkbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
    const restartedRun = vi.fn((input: unknown) => input)
    const unload = restartedWorkbench.register({ contract: value.contract, run: restartedRun })
    const restarted = new PrivatePluginActivationHost({ drafts: value.drafts,
      artifacts: value.artifacts, workbench: restartedWorkbench,
      ledger: new PrivatePluginActivationLedger(join(value.root, 'activation.json')),
      invocations: new PrivatePluginInvocationLedger(join(value.root, 'invocations.json')),
      approval: value.approval })
    expect(await restarted.list()).toMatchObject([{ state: 'active-private',
      packageSha256: value.hashes.packageSha256 }])
    expect(await restarted.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'conversation' }, value.authority))
      .toMatchObject({ output: { value: 'conversation' }, replayed: true })
    expect(restartedRun).not.toHaveBeenCalled()
    expect(await restarted.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'conversation' },
      { ...value.authority, callId: 'intentional-second-call' }))
      .toMatchObject({ output: { value: 'conversation' }, replayed: false })
    expect(restartedRun).toHaveBeenCalledTimes(1)
    expect(await restarted.uninstall(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority)).toMatchObject({ state: 'uninstalled-private' })
    expect(await value.host.list()).toEqual([])
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'after' }, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_NOT_INSTALLED' })
    unload()
    value.dispose()
    await restarted.close()
    await value.host.close()
  })

  it('denies missing owner approval, stale drafts, missing adapters and removed archives', async () => {
    const value = await setup()
    const noApproval = new PrivatePluginActivationHost({ drafts: value.drafts, artifacts: value.artifacts,
      workbench: value.workbench, ledger: value.ledger, invocations: value.invocations })
    await expect(noApproval.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED' })
    expect(await value.ledger.list()).toEqual([])
    value.approval.request.mockResolvedValueOnce('denied')
    await expect(value.host.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED' })
    value.dispose()
    await expect(value.host.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE' })
    const disposeAgain = value.workbench.register({ contract: value.contract, run: input => input })
    await value.drafts.save({ id: value.draft.id, spec: value.spec })
    await expect(value.host.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_DRAFT_STALE' })
    disposeAgain()
    await noApproval.close()
    await value.host.close()
  })

  it('marks a saved install unavailable when its adapter or archive disappears', async () => {
    const value = await setup()
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    value.dispose()
    expect(await value.host.list()).toMatchObject([{ state: 'unavailable-private' }])
    const disposeAgain = value.workbench.register({ contract: value.contract, run: input => input })
    expect(await value.host.list()).toMatchObject([{ state: 'active-private' }])
    await value.artifacts.remove(value.hashes.packageSha256, value.hashes.candidateSha256)
    expect(await value.host.list()).toMatchObject([{ state: 'unavailable-private' }])
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'no-archive' }, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_NOT_FOUND' })
    disposeAgain()
    await value.host.close()
  })

  it('checks input before approval and rejects denied calls or invalid Host output', async () => {
    let calls = 0
    const value = await setup((input) => {
      calls += 1
      return calls === 1 ? input : { value: 42 }
    })
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    const approvals = value.approval.request.mock.calls.length
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 42 }, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_INPUT_SCHEMA_INVALID' })
    expect(value.approval.request).toHaveBeenCalledTimes(approvals)
    value.approval.request.mockResolvedValueOnce('denied')
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'denied' }, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED' })
    expect(calls).toBe(1)
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'bad-output' }, value.authority))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_OUTPUT_SCHEMA_INVALID' })
    expect(calls).toBe(2)
    value.dispose()
    await value.host.close()
  })

  it('keeps an uncertain callback attempt blocked after failure', async () => {
    let calls = 0
    const value = await setup((input) => {
      calls += 1
      if (calls === 1) return input
      throw new Error('HOST_CALLBACK_LOST_RESULT')
    })
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'possibly-executed' }, value.authority))
      .rejects.toThrow('HOST_CALLBACK_LOST_RESULT')
    await expect(value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'another-input' },
      { ...value.authority, callId: 'fresh-call' }))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_INVOCATION_UNCERTAIN' })
    expect(calls).toBe(2)
    value.dispose()
    await value.host.close()
  })

  it('waits for an in-flight callback before uninstall commits', async () => {
    let finish!: (value: unknown) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    let calls = 0
    const value = await setup((input) => {
      calls += 1
      if (calls === 1) return input
      started()
      return new Promise((resolve) => { finish = resolve })
    })
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    const running = value.host.run(value.hashes.packageSha256, value.hashes.candidateSha256,
      'echo.text', { value: 'slow' }, value.authority)
    await began
    await expect(value.workbench.runPrivateSamples(value.draft,
      [{ operationId: 'echo.text', input: { value: 'another-sample' } }], value.authority.signal))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_ADAPTER_BUSY' })
    const uninstalling = value.host.uninstall(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await value.ledger.find(value.hashes.packageSha256, value.hashes.candidateSha256))
      .toMatchObject({ pluginId: 'owner.echo' })
    finish({ value: 'slow' })
    await expect(running).resolves.toMatchObject({ state: 'completed-private' })
    await expect(uninstalling).resolves.toMatchObject({ state: 'uninstalled-private' })
    value.dispose()
    await value.host.close()
  })

  it('serializes a repeated activation with uninstall for the same archive', async () => {
    const value = await setup()
    await value.host.activate(value.hashes.packageSha256, value.hashes.candidateSha256, value.authority)
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const began = new Promise<void>((resolve) => { entered = resolve })
    const ledger = value.ledger as unknown as {
      activate: PrivatePluginActivationLedger['activate']
    }
    const original = ledger.activate.bind(value.ledger)
    ledger.activate = async (record) => { entered(); await held; return original(record) }
    const activating = value.host.activate(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority)
    await began
    const uninstalling = value.host.uninstall(value.hashes.packageSha256,
      value.hashes.candidateSha256, value.authority)
    await new Promise(resolve => setTimeout(resolve, 40))
    await expect(value.ledger.find(value.hashes.packageSha256, value.hashes.candidateSha256))
      .resolves.toMatchObject({ pluginId: 'owner.echo' })
    release()
    await expect(activating).resolves.toMatchObject({ state: 'active-private' })
    await expect(uninstalling).resolves.toMatchObject({ state: 'uninstalled-private' })
    expect(await value.host.list()).toEqual([])
    ledger.activate = original
    value.dispose()
    await value.host.close()
  })
})
