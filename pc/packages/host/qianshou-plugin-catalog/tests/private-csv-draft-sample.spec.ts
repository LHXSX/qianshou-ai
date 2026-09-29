import { readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as PluginDraftTools from '@deepseek-ai/dsh-compute-core/src/plugin-draft-tools.ts'
import { ComputeService } from '@deepseek-ai/dsh-compute-core/src/service.ts'
import { ComputeDraftStore } from '@deepseek-ai/dsh-compute-core/src/store.ts'
import { LocalPluginDraftStore } from '@deepseek-ai/dsh-compute-core/src/plugin-draft.ts'
import { PrivateOfflinePluginArtifactStore } from '@deepseek-ai/dsh-compute-core/src/private-offline-plugin-artifact-store.ts'
import { HostPluginSampleWorkbench } from '@deepseek-ai/dsh-compute-core/src/private-plugin-sample-workbench.ts'
import { offlinePluginSampleSha256, verifyOfflinePluginArtifact } from '@deepseek-ai/dsh-compute-core/src/offline-plugin-artifact.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from '@deepseek-ai/dsh-compute-core/src/plugin-draft.ts'
import { CSV_PROFILE_PRIVATE_SAMPLE_OPERATION, registerInstalledCsvDraftSample,
  registerInstalledCsvProfileSampleAdapter } from '../src/private-csv-draft-sample.ts'
import { CSV_SEED_IDENTITY, executeOfficialCsvProfile, installPrivateOfficialCsvSeed } from '../src/official-seed-csv.ts'

const seed = fileURLToPath(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
const signal = new AbortController().signal

function draft(): LocalPluginDraft {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.csv-trial', version: '1.0.0', displayName: 'CSV trial',
    operations: [CSV_PROFILE_PRIVATE_SAMPLE_OPERATION] })
  return { id: 'plugin_draft_00000000-0000-0000-0000-000000000222',
    createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(),
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
}

async function installedDir(): Promise<string> {
  const privateDir = await mkdtemp(join(tmpdir(), 'qianshou-csv-draft-sample-'))
  onTestFinished(async () => { await rm(privateDir, { recursive: true, force: true }) })
  await installPrivateOfficialCsvSeed({ sourceArchivePath: seed, privateDir, signal,
    approveOwner: async digest => digest === CSV_SEED_IDENTITY.packageSha256 })
  return privateDir
}

describe('generic private sample workbench with a real Host CSV adapter', () => {
  it('runs the installed CSV adapter through the generic owner-approved creator tool', async () => {
    const privateDir = await installedDir()
    const root = await mkdtemp(join(tmpdir(), 'qianshou-csv-tool-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
    const saved = await drafts.save({ spec: draft().spec })
    const planStore = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 10, maxBytes: 131072 })
    const service = new ComputeService(null, planStore, () => false,
      undefined, undefined, undefined, undefined, undefined, undefined, drafts,
      undefined, new PrivateOfflinePluginArtifactStore(join(await realpath(root), 'private-artifacts')))
    const unload = await registerInstalledCsvProfileSampleAdapter({
      workbench: { register: adapter => service.registerHostPluginSampleAdapter(adapter) }, privateDir, signal })
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    let approvals = 0
    ctx.provide('computeCore', service)
    ctx.provide('approval' as never, { request: async () => { approvals += 1; return 'allowed-once' } } as never)
    const tools = await ctx.plugin(PluginDraftTools)
    try {
      const result = await ctx.tools.execute({ name: 'plugin_draft_try_sample',
        arguments: { id: saved.id, expectedUpdatedAt: saved.updatedAt,
          samples: [{ operationId: 'csv.profile', input: { csv: '城市,人数\n上海,3\n广州,2' } }] },
        signal, callId: ToolCallId('csv-generic-sample'), agent: {} as never })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(approvals).toBe(1)
      const response = result.content.find(item => item.type === 'text')
      const raw = response?.type === 'text' ? response.text : ''
      expect(JSON.parse(raw)).toMatchObject({ pluginId: 'creator.csv-trial',
        state: 'private-sample-completed', installable: false, dispatchable: false,
        stored: { state: 'stored-private-uninstalled', installable: false },
        results: [{ operationId: 'csv.profile', output: { rowCount: 2, columnCount: 2 } }] })
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed).not.toHaveProperty('artifact')
      expect(parsed.stored).not.toHaveProperty('path')
    } finally {
      unload()
      await tools.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await service.close()
    }
  })

  it('runs the installed executor and hashes its actual output before producing a private candidate', async () => {
    const privateDir = await installedDir()
    const saved = draft()
    const workbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
    const unload = await registerInstalledCsvProfileSampleAdapter({ workbench, privateDir, signal })
    onTestFinished(unload)
    expect(workbench.listBindings()).toEqual([expect.objectContaining({ operationId: 'csv.profile',
      bindingKind: 'tool', state: 'registered-needs-sample', executionVerified: false })])
    const sampleInput = { csv: '城市,人数\n上海,3\n广州,2\n', sampleRows: 2 }
    const run = await workbench.runPrivateSamples(saved, [{ operationId: 'csv.profile', input: sampleInput }], signal)
    expect(run).toMatchObject({ format: 'qianshou.private-plugin-sample-run.v1',
      reviewVerified: false, installable: false, dispatchable: false,
      candidate: { state: 'private-candidate', executionVerified: false, installable: false,
        dispatchable: false }, artifact: { state: 'built-offline-uninstalled', executionVerified: false } })
    expect(run.samples).toEqual([expect.objectContaining({ operationId: 'csv.profile', sampleExecuted: true,
      scope: 'host-registered-in-process-callback', inputSha256: offlinePluginSampleSha256(sampleInput),
      outputSha256: offlinePluginSampleSha256(executeOfficialCsvProfile(sampleInput)) })])
    expect(run.results).toEqual([{ operationId: 'csv.profile', output: executeOfficialCsvProfile(sampleInput) }])
    expect(verifyOfflinePluginArtifact(run.artifact.bytes, run.artifact)).toMatchObject({
      verificationScope: 'data-only-archive-and-claimed-digests', installable: false, dispatchable: false })
  })

  it('rejects a missing installation and refuses to execute after the pinned package changes', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'qianshou-csv-draft-missing-'))
    onTestFinished(async () => { await rm(missing, { recursive: true, force: true }) })
    const saved = draft()
    const workbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
    await expect(registerInstalledCsvDraftSample({ workbench, draft: saved, privateDir: missing, signal }))
      .rejects.toThrow()
    expect(workbench.listBindings()).toEqual([])
    const privateDir = await installedDir()
    const unload = await registerInstalledCsvDraftSample({ workbench, draft: saved, privateDir, signal })
    onTestFinished(unload)
    const archive = join(privateDir, 'qianshou.csv-profile-1.0.0.qspkg')
    const bytes = await readFile(archive)
    await writeFile(archive, Buffer.concat([bytes, Buffer.from('tampered')]))
    await expect(workbench.runPrivateSamples(saved, [{ operationId: 'csv.profile',
      input: { csv: '城市\n上海' } }], signal)).rejects.toThrow('QIANSHOU_CSV_SEED_INVALID')
  })

  it('rejects an agent-authored schema masquerading as the installed Host adapter contract', async () => {
    const privateDir = await installedDir()
    const saved = draft()
    const claimed = parsePluginDraftSpec({ ...saved.spec, operations: [{
      ...CSV_PROFILE_PRIVATE_SAMPLE_OPERATION,
      outputSchema: { type: 'object', properties: { rowCount: { type: 'integer' } },
        required: ['rowCount'], additionalProperties: false },
    }] })
    const workbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
    await expect(registerInstalledCsvDraftSample({ workbench, draft: { ...saved, spec: claimed },
      privateDir, signal })).rejects.toThrow('QIANSHOU_CSV_DRAFT_SAMPLE_CONTRACT_INVALID')
    expect(workbench.listBindings()).toEqual([])
  })
})
