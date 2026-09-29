/** Candidate native-node contract; this does not alter an already approved QuickJS publication. */
import type { PluginDraftSpec } from './plugin-draft.ts'
import { LEGAL_DOCUMENT_CAPABILITY, LEGAL_DOCUMENT_COUNT, LEGAL_DOCUMENT_TASK, LEGAL_DOCUMENT_VERSION } from './legal-document-bundle.ts'

export const LEGAL_DOCUMENT_NODE_CONTRACT = Object.freeze({
  schema: 'qianshou.native-document-task.v1', taskType: LEGAL_DOCUMENT_TASK,
  capabilityId: LEGAL_DOCUMENT_CAPABILITY, capabilityVersion: LEGAL_DOCUMENT_VERSION,
  inputKinds: ['multi_file'], defaultInputKind: 'multi_file', outputKind: 'artifact_ref',
  formSchemaVersion: 'qianshou.task-input-form.v1', documentCount: LEGAL_DOCUMENT_COUNT,
  maxInputFiles: 15, maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
  paramsSchema: { type: 'object', additionalProperties: false,
    required: ['instructions', 'document_plan', 'input_manifest'], properties: {
      instructions: { type: 'string', title: '本次案件材料分析与文书要求', minLength: 1, maxLength: 8000 },
      document_plan: { type: 'string', title: '15 份文书交付清单', minLength: 1, maxLength: 8000 },
      input_manifest: { type: 'string', title: '已完成上传的材料引用', minLength: 1, maxLength: 8000 },
    } },
  resultManifestSchema: 'qianshou.legal-document-bundle.v1',
  verification: { inputBytes: 'node-size-and-sha256', outputBytes: 'independent-file-verifier-required',
    content: 'buyer-and-lawyer-review-required' },
  runtime: 'native-node-provider', dispatchable: false,
})

/** Build an authoring recipe bound to an explicit node provider identity, never model-generated code. */
export function legalDocumentDraftTemplate(providerId: string, displayName: string): PluginDraftSpec {
  if (!/^[a-z][a-z0-9._-]{1,63}$/u.test(providerId)) throw new Error('COMPUTE_LEGAL_PROVIDER_INVALID')
  return { pluginId: 'qianshou.legal-document-bundle', version: LEGAL_DOCUMENT_VERSION, displayName,
    operations: [{ id: 'legal.doc.bundle', title: displayName,
      description: '读取任务授权附件，按明确的15项交付计划生成Word文书和可核验清单；不替代律师复核。',
      binding: { kind: 'local-model', ref: `legal-documents:${providerId}` },
      inputSchema: { type: 'object', properties: { instructions: { type: 'string' },
        documents: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, purpose: { type: 'string' },
        }, required: ['id', 'title', 'purpose'], additionalProperties: false } },
      }, required: ['instructions', 'documents'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { artifactRef: { type: 'string' },
        manifestSha256: { type: 'string' }, documentCount: { type: 'integer' } },
      required: ['artifactRef', 'manifestSha256', 'documentCount'], additionalProperties: false },
      permissions: ['workspace.read', 'workspace.write', 'model.local'], dataScope: 'task-inputs', networkOrigins: [],
      dependencies: [{ id: 'qianshou-native-legal-documents', version: LEGAL_DOCUMENT_VERSION }],
      resources: { platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'],
        minTotalMemoryBytes: 0, minFreeDiskBytes: 64 * 1024 * 1024,
        maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxRunMs: 60 * 60 * 1000 },
    }] }
}
