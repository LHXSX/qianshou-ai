/** One concrete adapter for the generic private plugin sample workbench.
 *
 * Its contract is a Host-owned constant, never copied from an agent-authored
 * draft. Its only executable is the already installed, exact CSV seed.
 */
import { pluginDraftPlanManifest, parsePluginDraftSpec,
  type HostPluginSampleWorkbench, type LocalPluginDraft } from '@deepseek-ai/dsh-compute-core'
import { CSV_SEED_IDENTITY, runPrivateOfficialCsvSeed,
  verifyPrivateOfficialCsvSeedInstallation } from './official-seed-csv.ts'

const REVIEWED_SPEC = parsePluginDraftSpec({ pluginId: 'qianshou.csv-profile.private-sample',
  version: '1.0.0', displayName: 'CSV private sample', operations: [{
    id: CSV_SEED_IDENTITY.operationId, title: 'Profile CSV', description: 'Inspect supplied CSV text.',
    binding: { kind: 'tool', ref: 'csv-profile:host-adapter' },
    inputSchema: { type: 'object', properties: { csv: { type: 'string' },
      sampleRows: { type: 'integer' } }, required: ['csv'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      rowCount: { type: 'integer' }, columnCount: { type: 'integer' }, delimiter: { type: 'string' },
      columns: { type: 'array', items: { type: 'object', properties: {
        index: { type: 'integer' }, name: { type: 'string' }, nonEmptyCount: { type: 'integer' },
        emptyCount: { type: 'integer' }, kind: { type: 'string' },
      }, required: ['index', 'name', 'nonEmptyCount', 'emptyCount', 'kind'], additionalProperties: false } },
      sampleRows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    }, required: ['rowCount', 'columnCount', 'delimiter', 'columns', 'sampleRows'], additionalProperties: false },
    permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
    resources: { platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64', 'ia32', 'arm'],
      minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 4096,
      maxOutputBytes: 16_384, maxRunMs: 10_000 },
  }] })

/** Public declaration for a private draft, not executable authority or a market listing. */
export const CSV_PROFILE_PRIVATE_SAMPLE_OPERATION = REVIEWED_SPEC.operations[0]!

const PLAN_DRAFT: LocalPluginDraft = { id: 'plugin_draft_00000000-0000-0000-0000-000000000000',
  createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
  state: 'private-draft', installable: false, dispatchable: false,
  readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec: REVIEWED_SPEC }
const REVIEWED_PLAN = pluginDraftPlanManifest(PLAN_DRAFT).operations[0]!

/** Register only after verifying this owner's private installation; every run re-verifies it. */
export async function registerInstalledCsvProfileSampleAdapter(input: {
  readonly workbench: Pick<HostPluginSampleWorkbench, 'register'>
  readonly privateDir: string
  readonly signal: AbortSignal
}): Promise<() => void> {
  input.signal.throwIfAborted()
  await verifyPrivateOfficialCsvSeedInstallation(input.privateDir, input.signal)
  input.signal.throwIfAborted()
  const operation = CSV_PROFILE_PRIVATE_SAMPLE_OPERATION
  return input.workbench.register({
    contract: { adapterId: CSV_SEED_IDENTITY.executorId,
      adapterVersion: CSV_SEED_IDENTITY.version, operationId: operation.id,
      bindingKind: operation.binding.kind, bindingRef: operation.binding.ref,
      inputSchemaSha256: REVIEWED_PLAN.inputSchemaSha256,
      outputSchemaSha256: REVIEWED_PLAN.outputSchemaSha256,
      permissions: operation.permissions, dataScope: operation.dataScope,
      networkOrigins: operation.networkOrigins, dependencies: operation.dependencies,
      resources: operation.resources,
      assets: [{ id: CSV_SEED_IDENTITY.releaseId, bytes: CSV_SEED_IDENTITY.packageBytes,
        sha256: CSV_SEED_IDENTITY.packageSha256 }],
      validUntilMs: Date.now() + 30 * 60 * 1000 },
    run: (sample, signal) => runPrivateOfficialCsvSeed(input.privateDir, sample, signal),
  })
}

/** Compatibility helper for callers that already hold a saved draft. */
export async function registerInstalledCsvDraftSample(input: {
  readonly workbench: Pick<HostPluginSampleWorkbench, 'register'>
  readonly draft: LocalPluginDraft
  readonly privateDir: string
  readonly signal: AbortSignal
}): Promise<() => void> {
  const spec = parsePluginDraftSpec(input.draft.spec)
  const operation = spec.operations.find(item => item.id === CSV_SEED_IDENTITY.operationId)
  const plan = pluginDraftPlanManifest(input.draft).operations.find(item => item.id === CSV_SEED_IDENTITY.operationId)
  if (operation === undefined || plan === undefined
    || operation.binding.kind !== CSV_PROFILE_PRIVATE_SAMPLE_OPERATION.binding.kind
    || operation.binding.ref !== CSV_PROFILE_PRIVATE_SAMPLE_OPERATION.binding.ref
    || plan.inputSchemaSha256 !== REVIEWED_PLAN.inputSchemaSha256
    || plan.outputSchemaSha256 !== REVIEWED_PLAN.outputSchemaSha256
    || JSON.stringify(operation.resources) !== JSON.stringify(CSV_PROFILE_PRIVATE_SAMPLE_OPERATION.resources)
    || JSON.stringify(operation.permissions) !== JSON.stringify(CSV_PROFILE_PRIVATE_SAMPLE_OPERATION.permissions)
    || operation.dataScope !== CSV_PROFILE_PRIVATE_SAMPLE_OPERATION.dataScope
    || operation.networkOrigins.length !== 0 || operation.dependencies.length !== 0) {
    throw new Error('QIANSHOU_CSV_DRAFT_SAMPLE_CONTRACT_INVALID')
  }
  return registerInstalledCsvProfileSampleAdapter(input)
}
