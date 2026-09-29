/** Read-only comparison of owner-supplied ComfyUI API graph selectors with local node options. */
import { ComputeError } from './errors.ts'
import { parseComfyProbeRequest, readLocalComfyClassInfo } from './comfy-local-probe.ts'
import { inspectComfyApiWorkflow } from './comfy-workflow-inspection.ts'

const MAX_CLASS_REQUESTS = 32
const TOTAL_TIMEOUT_MS = 12_000
type Check = boolean | 'unknown'

export interface ComfyWorkflowPreflight {
  readonly sha256: string
  readonly nodeCount: number
  readonly nodes: readonly {
    readonly nodeId: string
    readonly classType: string
    readonly available: Check
    readonly modelFields: readonly { readonly field: string; readonly selectable: Check }[]
  }[]
  readonly runnable: false
  readonly installable: false
  readonly dispatchable: false
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** An absent or malformed selector is unknown; an actual option list permits exact comparison. */
function selectable(info: Record<string, unknown>, field: string, value: unknown): Check {
  const input = record(info.input)
  for (const group of ['required', 'optional'] as const) {
    const fields = record(input?.[group])
    const descriptor = fields?.[field]
    if (descriptor === undefined) continue
    if (!Array.isArray(descriptor) || !Array.isArray(descriptor[0])
      || descriptor[0].some(option => typeof option !== 'string')) return 'unknown'
    return descriptor[0].includes(value)
  }
  return 'unknown'
}

/**
 * Compare direct model selectors in a validated owner graph with local ComfyUI options. Each
 * distinct node class is read once from loopback; no graph execution or selector value is emitted.
 * @param value - Owner-provided API-format graph and optional owner-provided local TCP port.
 * @param signal - Cancellation from the current tool call.
 * @param fetcher - GET implementation, replaceable by a deterministic test transport.
 * @returns Graph digest and per-node/class/selector availability, never an execution claim.
 */
export async function preflightLocalComfyWorkflow(value: { workflow: unknown; port?: number },
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ComfyWorkflowPreflight> {
  const inspection = inspectComfyApiWorkflow(value.workflow)
  const { port } = parseComfyProbeRequest({ ...(value.port === undefined ? {} : { port: value.port }) })
  if (inspection.classTypes.length > MAX_CLASS_REQUESTS) {
    throw new ComputeError('COMPUTE_COMFY_PREFLIGHT_TOO_MANY_CLASSES', 400)
  }
  signal.throwIfAborted()
  const graph = value.workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  const classInfo = new Map<string, Record<string, unknown> | null>()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)])
  for (const classType of inspection.classTypes) {
    if (deadline.aborted) {
      classInfo.set(classType, null)
      continue
    }
    try { classInfo.set(classType, record(await readLocalComfyClassInfo(port, classType, deadline, fetcher))) }
    catch { classInfo.set(classType, null) }
  }
  signal.throwIfAborted()
  const nodes = Object.keys(graph).sort((a, b) => Number(a) - Number(b)).map((nodeId) => {
    const node = graph[nodeId]
    if (node === undefined) throw new ComputeError('COMPUTE_COMFY_WORKFLOW_INVALID', 400)
    const response = classInfo.get(node.class_type) ?? null
    const info = response === null ? null : record(response[node.class_type])
    const available: Check = response === null ? 'unknown' : Object.hasOwn(response, node.class_type)
      ? info === null ? 'unknown' : true : false
    const modelFields = inspection.modelFields.filter(item => item.nodeId === nodeId).map(item => ({
      field: item.field,
      selectable: info === null ? 'unknown' as const : selectable(info, item.field, node.inputs[item.field]),
    }))
    return { nodeId, classType: node.class_type, available, modelFields }
  })
  return { sha256: inspection.sha256, nodeCount: inspection.nodeCount, nodes,
    runnable: false, installable: false, dispatchable: false }
}
