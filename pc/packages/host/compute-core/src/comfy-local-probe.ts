/** Read-only, bounded observation of an owner-local ComfyUI service. */
import { ComputeError } from './errors.ts'

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,95}$/u
const MODEL_FOLDERS = ['checkpoints', 'diffusion_models', 'vae', 'text_encoders', 'loras'] as const
const MAX_RESPONSE_BYTES = 128 * 1024
const REQUEST_TIMEOUT_MS = 3_000

export interface ComfyLocalObservation {
  readonly endpoint: string
  readonly observedAt: string
  readonly version: string | null
  readonly devices: readonly { readonly type: string; readonly vramTotalBytes: number | null }[]
  readonly modelCounts: Readonly<Record<string, number>>
  readonly classChecks: readonly { readonly classType: string; readonly available: boolean }[]
  readonly verification: 'service-observed'
  readonly runnable: false
  readonly installable: false
  readonly dispatchable: false
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_PROBE_INVALID', 400) }
function unavailable(): ComputeError { return new ComputeError('COMPUTE_COMFY_UNAVAILABLE', 503) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** No arbitrary URL, host, credentials, proxy target or workflow submission is accepted. */
export function parseComfyProbeRequest(value: unknown): { port: number; classTypes: string[] } {
  const item = record(value)
  if (item === null || Object.keys(item).some(key => key !== 'port' && key !== 'classTypes')) throw invalid()
  const port = item.port === undefined ? 8188 : item.port
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw invalid()
  const rawClasses = item.classTypes === undefined ? [] : item.classTypes
  if (!Array.isArray(rawClasses) || rawClasses.length > 32
    || rawClasses.some(name => typeof name !== 'string' || !CLASS_NAME.test(name))
    || new Set(rawClasses).size !== rawClasses.length) throw invalid()
  return { port, classTypes: rawClasses as string[] }
}

async function readJson(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
  } catch { throw unavailable() }
  if (!response.ok || response.status >= 300 || !response.headers.get('content-type')?.toLowerCase().includes('json')) throw unavailable()
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw unavailable()
  if (!response.body) throw unavailable()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw unavailable()
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) }
  catch { throw unavailable() }
}

/** Read one validated class through the same bounded, no-redirect loopback reader as the service probe. */
export async function readLocalComfyClassInfo(port: number, classType: string,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const request = parseComfyProbeRequest({ port, classTypes: [classType] })
  signal.throwIfAborted()
  return readJson(`http://127.0.0.1:${request.port}/object_info/${request.classTypes[0]}`, signal, fetcher)
}

/**
 * Observe version, GPU capacity, counts of common model files and availability of owner-named
 * node classes. Never return ComfyUI's raw system stats: it can contain launch arguments.
 */
export async function probeLocalComfy(value: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ComfyLocalObservation> {
  const { port, classTypes } = parseComfyProbeRequest(value)
  signal.throwIfAborted()
  const endpoint = `http://127.0.0.1:${port}`
  const stats = record(await readJson(`${endpoint}/system_stats`, signal, fetcher))
  if (stats === null) throw unavailable()
  const system = record(stats.system)
  const version = typeof system?.comfyui_version === 'string' && system.comfyui_version.length <= 40
    ? system.comfyui_version : null
  const devices = Array.isArray(stats.devices) ? stats.devices.slice(0, 8).map((raw) => {
    const device = record(raw)
    const type = typeof device?.type === 'string' && /^[A-Za-z0-9_-]{1,30}$/u.test(device.type) ? device.type : 'unknown'
    const total = device?.vram_total
    return { type, vramTotalBytes: typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null }
  }) : []
  const modelCounts: Record<string, number> = {}
  const folders = await readJson(`${endpoint}/models`, signal, fetcher)
  if (!Array.isArray(folders) || folders.some(folder => typeof folder !== 'string')) throw unavailable()
  for (const folder of MODEL_FOLDERS) {
    if (!folders.includes(folder)) continue
    const modelNames = await readJson(`${endpoint}/models/${folder}`, signal, fetcher)
    if (!Array.isArray(modelNames) || modelNames.some(name => typeof name !== 'string')) throw unavailable()
    modelCounts[folder] = modelNames.length
  }
  const classChecks: Array<{ classType: string; available: boolean }> = []
  for (const classType of classTypes) {
    const info = record(await readLocalComfyClassInfo(port, classType, signal, fetcher))
    if (info === null) throw unavailable()
    classChecks.push({ classType, available: Object.hasOwn(info, classType) })
  }
  return { endpoint, observedAt: new Date().toISOString(), version, devices, modelCounts, classChecks,
    verification: 'service-observed', runnable: false, installable: false, dispatchable: false }
}
