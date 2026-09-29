/** Read-only local inventory and existing adapter observations, independent of paid qualification. */
import { discoverLocalMedia, localMediaOrigin, type LocalMediaDiscovery } from './local-media-discovery.ts'
import type { SharingLocalState, SharingMode } from './sharing-types.ts'
import { sharingObject } from './sharing-protocol.ts'
import { sharingResponseBytes } from './sharing-runtime.ts'
import { localListeningPorts } from './local-service-ports.ts'

/** Deployment-selected local services; empty origins disable their read-only observation. */
export interface SharingLocalOptions {
  readonly comfyOrigin: string
  readonly imageOrigin: string
  readonly videoOrigin: string
  readonly timeoutMs: number
  /** Also inspect bounded local TCP listeners; empty per-mode origins still disable that mode. */
  readonly autoDiscover?: boolean
  readonly preferredComfyOrigin?: string | undefined
  readonly preferredImageOrigin?: string | undefined
  readonly preferredVideoOrigin?: string | undefined
}
/** Private selected source for a fixed workflow; origins never leave Host status. */
export interface SharingLocalObservation {
  readonly states: Readonly<Record<SharingMode, SharingLocalState>>
  readonly comfyOrigin: string | null
  readonly imageOrigin: string | null
  readonly videoOrigin: string | null
}
/** Unobserved local state never means a model is absent.
 * @returns Empty, redacted observation.
 */
export function initialSharingLocal(): SharingLocalState {
  return { inventory: 'unknown', modelCount: null, runtime: 'unknown', adapter: null,
    adoption: 'unmatched', checkedAt: null }
}
async function metadata(origin: string, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(localMediaOrigin(origin) + path, { method: 'GET', redirect: 'error', credentials: 'omit',
    cache: 'no-store', signal, headers: { Accept: 'application/json' } })
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403
    ? 'LOCAL_AUTH_REQUIRED' : 'LOCAL_UNAVAILABLE') }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel(); throw new Error('LOCAL_UNSUPPORTED')
  }
  const bytes = await sharingResponseBytes(response, 65536)
  try { return sharingObject(JSON.parse(bytes.toString('utf8')) as unknown) }
  catch { throw new Error('LOCAL_UNSUPPORTED') }
}
function failedRuntime(error: unknown): SharingLocalState['runtime'] {
  return error instanceof Error && error.message === 'LOCAL_AUTH_REQUIRED' ? 'authentication_required'
    : error instanceof Error && error.message === 'LOCAL_UNSUPPORTED' ? 'unsupported' : 'unavailable'
}
// This is the existing research adapter's fixed model set, not a commercial catalog entry.
const QWEN_FILES = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors',
  text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' } as const
const QWEN_CLASSES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'EmptyLatentImage',
  'KSampler', 'VAEDecode', 'SaveImage'] as const
async function image(imageOrigin: string, comfyOrigin: string, inventory: LocalMediaDiscovery | null,
  base: SharingLocalState, signal: AbortSignal): Promise<SharingLocalState> {
  if (!imageOrigin) return base
  try {
    const health = await metadata(imageOrigin, '/healthz', signal)
    if (health.status !== 'ok' || health.model !== 'qwen-image-2.1-int8-convrot' || health.comfy_reachable !== true
      || typeof health.busy !== 'boolean') return { ...base, runtime: 'unsupported' }
    const modelsPresent = inventory !== null && Object.entries(QWEN_FILES).every(([group, name]) => inventory.models.some(
      file => file.group === group && file.name === name))
    if (!modelsPresent) return { ...base, runtime: 'unsupported', adapter: 'qianshou_image', adoption: 'verification_required' }
    for (const name of QWEN_CLASSES) {
      const classes = await metadata(comfyOrigin, '/object_info/' + name, signal)
      let info: Record<string, unknown>
      try { info = sharingObject(classes[name]); sharingObject(info.input) }
      catch { throw new Error('LOCAL_UNSUPPORTED') }
      if (!Array.isArray(info.output)) return { ...base, runtime: 'unsupported', adoption: 'verification_required' }
    }
    return { ...base, runtime: 'ready', adapter: 'qianshou_image', adoption: 'verification_required' }
  } catch (error) {
    return { ...base, runtime: failedRuntime(error) }
  }
}
async function video(videoOrigin: string, base: SharingLocalState, signal: AbortSignal): Promise<SharingLocalState> {
  if (!videoOrigin) return base
  try {
    // Generic workflow catalogs do not implement the immutable formal runtime ABI.
    const catalog = await metadata(videoOrigin, '/v1/workflows', signal)
    return { ...base, runtime: 'unsupported', adoption: Array.isArray(catalog.workflows)
      ? 'verification_required' : 'unmatched' }
  } catch (error) {
    return { ...base, runtime: failedRuntime(error) }
  }
}
const QWEN_GROUPS = Object.entries(QWEN_FILES)
function qwenFilesPresent(inventory: LocalMediaDiscovery): boolean {
  return QWEN_GROUPS.every(([group, name]) => inventory.models.some(file => file.group === group && file.name === name))
}
function candidateOrigins(configured: string, preferred: string | undefined, ports: readonly number[]): string[] {
  if (!configured) return []
  return [...new Set([...(preferred ? [localMediaOrigin(preferred)] : []), configured,
    ...ports.map(port => 'http://127.0.0.1:' + port)])]
}
async function limited<T>(items: readonly string[], action: (item: string) => Promise<T>): Promise<T[]> {
  const result = new Array<T>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await action(items[index]!) }
  }))
  return result
}
/** Discover a current local workflow source, keeping candidate ports and filenames in Host.
 * @param options - Deployment-selected defaults and optional bounded listener discovery.
 * @param signal - Owner/lifecycle cancellation.
 * @param listPorts - Native listener source; injected only by isolated tests.
 * @returns Redacted mode observations and the Comfy source used for a verified fixed workflow.
 */
export async function discoverSharingLocal(options: SharingLocalOptions, signal: AbortSignal,
  listPorts: (signal: AbortSignal) => Promise<readonly number[]> = localListeningPorts): Promise<SharingLocalObservation> {
  for (const origin of [options.comfyOrigin, options.imageOrigin, options.videoOrigin]) if (origin) localMediaOrigin(origin)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
  const ports = options.autoDiscover ? await listPorts(deadline).catch(() => []) : []
  const comfyOrigins = candidateOrigins(options.comfyOrigin, options.preferredComfyOrigin, ports)
  const inventories = await limited(comfyOrigins, async origin => {
    try {
      if (origin !== options.comfyOrigin) {
        const stats = await metadata(origin, '/system_stats', AbortSignal.any([deadline, AbortSignal.timeout(700)]))
        if (!Array.isArray(stats.devices)) return null
      }
      return { origin, inventory: await discoverLocalMedia(origin, { timeoutMs: options.timeoutMs, signal: deadline }) }
    } catch { return null }
  })
  const detected = inventories.filter((value): value is NonNullable<typeof value> => value !== null)
  const selected = detected.find(value => qwenFilesPresent(value.inventory)) ?? detected[0] ?? null
  const inventory = selected?.inventory ?? null
  const modelCount = detected.length === 0 ? null : new Set(detected.flatMap(value => value.inventory.models.map(
    model => model.group + '\0' + model.name))).size
  const base: SharingLocalState = { ...initialSharingLocal(), inventory: modelCount === null
    ? options.comfyOrigin ? 'unavailable' : 'unknown' : modelCount === 0 ? 'empty' : 'detected',
  modelCount, adapter: inventory === null ? null : 'comfyui' }
  const comfyOrigin = selected?.origin ?? options.comfyOrigin
  const imageOrigins = candidateOrigins(options.imageOrigin, options.preferredImageOrigin, ports)
  const imageStates = await limited(imageOrigins, origin => image(origin, comfyOrigin, inventory, base, deadline))
  const imageIndex = imageStates.findIndex(state => state.runtime === 'ready')
  const imageRow = imageStates[imageIndex >= 0 ? imageIndex : 0] ?? base
  const videoOrigins = candidateOrigins(options.videoOrigin, options.preferredVideoOrigin, ports)
  const videoStates = await limited(videoOrigins, origin => video(origin, base, deadline))
  const videoIndex = videoStates.findIndex(state => state.runtime === 'unsupported' && state.adoption === 'verification_required')
  const videoRow = videoStates[videoIndex >= 0 ? videoIndex : 0] ?? base
  const checkedAt = Math.floor(Date.now() / 1000)
  return { comfyOrigin: selected?.origin ?? null, imageOrigin: imageIndex >= 0 ? imageOrigins[imageIndex]! : null,
    videoOrigin: videoIndex >= 0 ? videoOrigins[videoIndex]! : null,
    states: { image: { ...imageRow, checkedAt }, video: { ...videoRow, checkedAt } } }
}
/** Observe local files and APIs without downloading, restarting, writing or publishing supply.
 * @param options - Validated loopback service configuration and bounded whole-read deadline.
 * @param signal - Owner/lifecycle cancellation.
 * @returns Exactly two redacted observations; filenames and API addresses remain in this Host.
 */
export async function observeSharingLocal(options: SharingLocalOptions,
  signal: AbortSignal): Promise<Readonly<Record<SharingMode, SharingLocalState>>> {
  return (await discoverSharingLocal(options, signal)).states
}
