/** Opt-in production Loader binding for the explicit native-node legal provider. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './service.ts'
import { createLegalDocumentExecutor } from './legal-document-bundle.ts'
import { LEGAL_DOCUMENT_NODE_CONTRACT } from './legal-document-contract.ts'
import { createLocalLegalDocumentProvider, type LocalLegalProviderConfig } from './legal-document-local-provider.ts'
import type { LegalDocumentProvider } from './legal-document-bundle.ts'
import { ComputeError } from './errors.ts'
import { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from './local-task-runner.ts'
import { bindLegalDocumentAssignment, createLegalUploadedInputSource, type LegalDocumentAdmission, type LegalInputGrantProvider } from './legal-document-task-binding.ts'

export interface LegalAssignedTaskRequest<T> extends Omit<ComputeLocalTaskRequest<T>, 'source'> {
  grants: LegalInputGrantProvider
}

/**
 * Installed local legal-provider entry; readiness does not register market dispatch.
 */
export interface LegalDocumentRuntime {
  /**
   * Read local execution readiness without inferring market availability.
   * @returns Local provider readiness and the separate, unregistered market-dispatch status.
   */
  state(): { localExecution: 'disabled' | 'checking' | 'ready' | 'unavailable'; marketDispatch: 'not-registered' }
  contract: typeof LEGAL_DOCUMENT_NODE_CONTRACT
  /**
   * Installed Host port: requires admitted lease metadata and its authenticated grant provider.
   * @param admission - Authenticated lease and assignment metadata bound to this legal task.
   * @param request - The task request, authenticated file grants, cancellation, and result handling.
   * @returns The admitted task result; unavailable providers or invalid assignments reject.
   */
  runAssignedTask<T>(admission: LegalDocumentAdmission, request: LegalAssignedTaskRequest<T>): Promise<T>
}
declare module '@deepseek-ai/cordis' {
  interface Context { qianshouLegalDocumentRuntime: LegalDocumentRuntime }
}
export interface Config extends LocalLegalProviderConfig {
  enabled: boolean
  inputStorageHostname: string
}
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false), providerId: z.string().default('local-legal'),
  ollamaOrigin: z.string().default('http://127.0.0.1:11434'), model: z.string().default(''),
  modelSha256: z.string().default(''), timeoutMs: z.number().step(1).min(1000).max(300000).default(120000),
  maxContextChars: z.number().step(1).min(1000).max(200000).default(40000),
  inputStorageHostname: z.string().default(''),
  pdfTextExecutable: z.string(), pdfTextExecutableSha256: z.string(),
})
export const name = 'qianshou-legal-document-runtime'
export const inject = ['computeCore']

/** Register the exact executor only after actual model identity and execution health agree. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let localExecution: ReturnType<LegalDocumentRuntime['state']>['localExecution'] = config.enabled ? 'checking' : 'disabled'
  const runner = new ComputeLocalTaskRunner(ctx.computeCore.executors)
  ctx.provide('qianshouLegalDocumentRuntime', { contract: LEGAL_DOCUMENT_NODE_CONTRACT,
    state: () => ({ localExecution, marketDispatch: 'not-registered' }),
    async runAssignedTask<T>(admission: LegalDocumentAdmission, request: LegalAssignedTaskRequest<T>): Promise<T> {
      if (localExecution !== 'ready') throw new ComputeError('COMPUTE_LEGAL_PROVIDER_UNAVAILABLE', 409)
      const bound = bindLegalDocumentAssignment(admission)
      const source = createLegalUploadedInputSource(admission, config.inputStorageHostname, request.grants)
      return runner.run(bound.task, { ...request, source })
    } })
  if (!config.enabled) return
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'legal documents: provider lifetime')
  let provider: LegalDocumentProvider | undefined
  let ready = false
  try { provider = createLocalLegalDocumentProvider(config); ready = (await provider.preflight(lifetime.signal)).ready }
  catch { /* Unavailable local model/extraction configuration never grants an executor or intake. */ }
  lifetime.signal.throwIfAborted()
  if (!ready || provider === undefined) { localExecution = 'unavailable'; return }
  ctx.effect(() => ctx.computeCore.executors.register(createLegalDocumentExecutor(provider)),
    'legal documents: exact installed local executor')
  ctx.effect(() => async () => { localExecution = 'unavailable'; await runner.close() },
    'legal documents: drain task attempts before removing executor')
  localExecution = 'ready'
}
