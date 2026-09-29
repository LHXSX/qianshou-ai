/** Official media metadata admitted from Shanghai; media bytes stay outside this protocol. */
import { ComputeError } from './errors.ts'

export interface FormalMediaInput {
  capability: 'image' | 'video'
  mode: 'text_to_image' | 'image_to_image' | 'image_edit' | 'text_to_video' | 'image_to_video' | 'first_last_frame'
  prompt: string
  negative_prompt: string
  quality: 'fast' | 'standard' | 'clear' | 'hd'
  orientation: 'square' | 'landscape' | 'portrait'
  seconds: number | null
  assets: Array<{ asset_id: string; sha256: string; role: 'reference' | 'first_frame' | 'last_frame' }>
  profile_id: string
  profile_version: number
}
export interface FormalMediaProfile {
  profile_id: string
  profile_version: number
  capability: FormalMediaInput['capability']
  mode: FormalMediaInput['mode']
  quality: FormalMediaInput['quality']
  orientation: FormalMediaInput['orientation']
  width: number
  height: number
  steps: number
  fps: number | null
  allowed_seconds: number[]
  input_roles: Array<FormalMediaInput['assets'][number]['role']>
  max_assets: number
  model_id: string
  model_sha256: string
  workflow_id: string
  workflow_sha256: string
  validation_receipt_sha256: string
  min_vram_mb: number
  min_memory_mb: number
  timeout_s: number
  price_version: number
  price_unit: 'image' | 'second'
  unit_price_yuan: string
  min_charge_yuan: string
  enabled: boolean
}
export interface FormalMediaDirectory {
  billing_status: 'ready' | 'unavailable'
  profiles: FormalMediaProfile[]
}
export interface FormalMediaSpec {
  task_type: 'image_generate' | 'video_generate'
  input_kind: 'params_only'
  media_input: FormalMediaInput
}
export const FORMAL_MEDIA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const digest = /^[a-f0-9]{64}$/u
const modes = ['text_to_image', 'image_to_image', 'image_edit', 'text_to_video', 'image_to_video', 'first_last_frame']
const qualities = ['fast', 'standard', 'clear', 'hd']
const orientations = ['square', 'landscape', 'portrait']
const roles = ['reference', 'first_frame', 'last_frame']
const expectedRoles: Record<FormalMediaInput['mode'], string[]> = {
  text_to_image: [], text_to_video: [], image_to_image: ['reference'], image_edit: ['reference'],
  image_to_video: ['first_frame'], first_last_frame: ['first_frame', 'last_frame'],
}
/** Parse a wire object without accepting arrays or null. */
export function formalMediaObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
  return value as Record<string, unknown>
}
function integer(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high
}
function string(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.isWellFormed()
}
function choice(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}
function money(value: unknown, positive: boolean): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/u.test(value)
    && (!positive || /[1-9]/u.test(value))
}
/** Parse the closed ten-field input; clients cannot supply execution parameters or tariffs. */
export function parseFormalMediaInput(value: unknown): FormalMediaInput {
  const row = formalMediaObject(value)
  if (Object.keys(row).sort().join(',') !== 'assets,capability,mode,negative_prompt,orientation,profile_id,profile_version,prompt,quality,seconds'
    || !choice(row.capability, ['image', 'video']) || !choice(row.mode, modes)
    || !choice(row.quality, qualities) || !choice(row.orientation, orientations)
    || !string(row.prompt, 8192) || !row.prompt.trim() || Buffer.byteLength(row.prompt) > 8192
    || !string(row.negative_prompt, 8192) || Buffer.byteLength(row.negative_prompt) > 8192
    || typeof row.profile_id !== 'string' || !/^[a-z][a-z0-9_.-]{2,99}$/u.test(row.profile_id)
    || !integer(row.profile_version, 1, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(row.assets) || row.assets.length > 8
    || (row.capability === 'video' ? !integer(row.seconds, 1, 120) : row.seconds !== null)
    || (row.capability === 'video') !== (String(row.mode).includes('video') || row.mode === 'first_last_frame')) {
    throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
  }
  const assets = row.assets.map((value) => {
    const asset = formalMediaObject(value)
    if (Object.keys(asset).sort().join(',') !== 'asset_id,role,sha256'
      || typeof asset.asset_id !== 'string' || !id.test(asset.asset_id)
      || typeof asset.sha256 !== 'string' || !digest.test(asset.sha256) || !choice(asset.role, roles)) {
      throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
    }
    return { asset_id: asset.asset_id, sha256: asset.sha256, role: asset.role as FormalMediaInput['assets'][number]['role'] }
  })
  const mode = row.mode as FormalMediaInput['mode']
  const observedRoles = [...new Set(assets.map(asset => asset.role))].sort()
  if (new Set(assets.map(asset => asset.asset_id)).size !== assets.length
    || observedRoles.join(',') !== expectedRoles[mode].join(',')
    || (mode === 'image_to_video' && assets.length !== 1) || (mode === 'first_last_frame' && assets.length !== 2)) {
    throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
  }
  return { capability: row.capability as FormalMediaInput['capability'], mode, prompt: row.prompt,
    negative_prompt: row.negative_prompt, quality: row.quality as FormalMediaInput['quality'],
    orientation: row.orientation as FormalMediaInput['orientation'], seconds: row.seconds as number | null,
    assets, profile_id: row.profile_id, profile_version: row.profile_version }
}
/** Admit bounded official profiles without deriving a price or quality from their names. */
export function parseFormalMediaDirectory(value: unknown): FormalMediaDirectory {
  const root = formalMediaObject(value)
  if (root.ok !== true || !choice(root.billing_status, ['ready', 'unavailable'])
    || !Array.isArray(root.profiles) || root.profiles.length > 500) throw new ComputeError('CORE_INVALID_RESPONSE', 502)
  const profiles = root.profiles.map((value) => {
    const p = formalMediaObject(value)
    const video = p.capability === 'video'
    if (Object.keys(p).sort().join(',') !== 'allowed_seconds,capability,enabled,fps,height,input_roles,max_assets,min_charge_yuan,min_memory_mb,min_vram_mb,mode,model_id,model_sha256,orientation,price_unit,price_version,profile_id,profile_version,quality,steps,timeout_s,unit_price_yuan,validation_receipt_sha256,width,workflow_id,workflow_sha256'
      || typeof p.profile_id !== 'string' || !/^[a-z][a-z0-9_.-]{2,99}$/u.test(p.profile_id)
      || !integer(p.profile_version, 1, Number.MAX_SAFE_INTEGER) || !choice(p.capability, ['image', 'video'])
      || !choice(p.mode, modes) || !choice(p.quality, qualities) || !choice(p.orientation, orientations)
      || video !== (String(p.mode).includes('video') || p.mode === 'first_last_frame')
      || !integer(p.width, 64, 4096) || !integer(p.height, 64, 4096) || !integer(p.steps, 1, 200)
      || (video ? !integer(p.fps, 1, 120) : p.fps !== null)
      || !Array.isArray(p.allowed_seconds) || p.allowed_seconds.length > 120
      || p.allowed_seconds.some(s => !integer(s, 1, 120)) || new Set(p.allowed_seconds).size !== p.allowed_seconds.length
      || (video ? p.allowed_seconds.length === 0 : p.allowed_seconds.length !== 0)
      || !Array.isArray(p.input_roles) || p.input_roles.some(r => !choice(r, roles))
      || [...p.input_roles as string[]].sort().join(',') !== expectedRoles[p.mode as FormalMediaInput['mode']].join(',')
      || !integer(p.max_assets, p.input_roles.length, 8) || (p.input_roles.length === 0 && p.max_assets !== 0)
      || !string(p.model_id, 128) || p.model_id.length < 1 || !string(p.workflow_id, 128) || p.workflow_id.length < 1
      || ![p.model_sha256, p.workflow_sha256, p.validation_receipt_sha256].every(d => typeof d === 'string' && digest.test(d))
      || !integer(p.min_vram_mb, 1024, 65536) || !integer(p.min_memory_mb, 1024, 524288)
      || !integer(p.timeout_s, 30, 3600) || !integer(p.price_version, 1, Number.MAX_SAFE_INTEGER)
      || p.price_unit !== (video ? 'second' : 'image') || !money(p.unit_price_yuan, true) || !money(p.min_charge_yuan, false)
      || typeof p.enabled !== 'boolean' || (p.orientation === 'square' && p.width !== p.height)
      || (p.orientation === 'landscape' && p.width <= p.height) || (p.orientation === 'portrait' && p.width >= p.height)) {
      throw new ComputeError('CORE_INVALID_RESPONSE', 502)
    }
    return { ...p, allowed_seconds: [...p.allowed_seconds as number[]],
      input_roles: [...p.input_roles as string[]] } as unknown as FormalMediaProfile
  })
  if (new Set(profiles.map(p => `${p.profile_id}:${p.profile_version}`)).size !== profiles.length) throw new ComputeError('CORE_INVALID_RESPONSE', 502)
  return { billing_status: root.billing_status as FormalMediaDirectory['billing_status'], profiles }
}
/** Select only the exact enabled combination supplied by the official directory. */
export function formalMediaSpec(input: FormalMediaInput, directory: FormalMediaDirectory): FormalMediaSpec {
  if (directory.billing_status !== 'ready') throw new ComputeError('COMPUTE_MEDIA_QUOTE_UNAVAILABLE', 503)
  const p = directory.profiles.find(p => p.enabled && p.profile_id === input.profile_id && p.profile_version === input.profile_version)
  if (p === undefined || ['capability', 'mode', 'quality', 'orientation'].some(key => p[key as keyof FormalMediaProfile] !== input[key as keyof FormalMediaInput])
    || input.assets.length > p.max_assets || input.assets.some(asset => !p.input_roles.includes(asset.role))
    || (input.seconds !== null && !p.allowed_seconds.includes(input.seconds))) throw new ComputeError('COMPUTE_MEDIA_PROFILE_CHANGED', 409)
  return { task_type: input.capability === 'image' ? 'image_generate' : 'video_generate', input_kind: 'params_only', media_input: input }
}
