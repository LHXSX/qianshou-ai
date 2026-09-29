/** Guangzhou's durable connection directory and task inbox; Shanghai owns orders and settlement. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, constants, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isIP } from 'node:net'
import { inspectResearchPng } from './media-research-png.ts'
import { parseResearchLease, researchExact, researchUuid, researchTerminal, RESEARCH_EXECUTION_TTL_MS, type ResearchTaskRow, type ResearchMediaLease, type ResearchNodeExecution } from './media-research-contract.ts'
import { canonicalMediaJson, verifyMediaDispatchAuthorization, type MediaResultPayload } from './media-result-contract.ts'

/** Errors safe to return to the authenticated Host without exposing credentials. */
export class MediaNodeError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status }
}

/** One self-reported profile. Official independent verification remains Shanghai's responsibility. */
export interface MediaNodeCapability {
  profile_id: string; profile_version: number; model_sha256: string
  workflow_sha256: string; validation_receipt_sha256: string
}

/** The Host saves deviceToken before registration, making a lost registration response retryable. */
export interface MediaNodeRegistration {
  deviceId: string; deviceToken: string; adapterVersion: string; capabilityRevision: string
  capabilities: readonly MediaNodeCapability[]; maxConcurrency: number
}

/** Shanghai-issued task metadata, never a local model invocation or media byte payload. */
export interface MediaNodeDispatch {
  deviceId: string; taskId: string; attemptId: string; leaseEpoch: number
  leaseExpiresAt: string; quoteId: string; authorizationId: string; envelope: Record<string, unknown>
}

interface NodeRow {
  device_id: string; owner_id: string; token_hash: string; revision: string; adapter_version: string
  capabilities: string; max_concurrency: number; epoch: number; connection_id: string
  recovered: number; last_seen: number; free_slots: number; running: string
  free_vram: number; available_seconds: number
}

interface TaskRow {
  sequence: number; device_id: string; task_id: string; attempt_id: string; lease_epoch: number
  expires_at: number; payload: string; stage: string; event_sequence: number
}

/** Research API observations are independent of paid profiles and never advertise a GPU slot. */
export interface MediaLocalApiObservation {
  mode: 'image' | 'video'; adapter: string
  status: 'ready' | 'unavailable' | 'auth_required' | 'unsupported' | 'unknown'
  model: { id: string; sha256: string | null; version: string | null } | null
  workflow: { id: string; sha256: string | null; version: string | null } | null
  observedAt: string
}
interface LocalApiReport { device_id: string; epoch: number; revision: string; payload: string; created_at: number }
interface LocalApiProbe {
  request_id: string; device_id: string; epoch: number; revision: string; mode: 'image' | 'video'; adapter: string
  created_at: number; expires_at: number; delivered: number; result: string | null
  status: 'pending' | 'confirmed' | 'failed' | 'expired'; completed_at: number
}
const apiProbeLifetime = 90_000
const apiConfirmationLifetime = 120_000
const apiProbeInterval = 60_000
const apiIdentifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(value)
    || isIP(value) !== 0 || value === 'localhost' || value.includes('..')) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
  return value
}
const exactApiFields = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(k => !fields.includes(k))) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
  return value as Record<string, unknown>
}
function localApiObservation(value: unknown): MediaLocalApiObservation {
  const p = exactApiFields(value, ['mode', 'adapter', 'status', 'model', 'workflow', 'observedAt'])
  if (!['image', 'video'].includes(String(p['mode'])) || !['ready', 'unavailable', 'auth_required', 'unsupported', 'unknown'].includes(String(p['status']))
    || typeof p['observedAt'] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(p['observedAt'])
    || !Number.isFinite(Date.parse(p['observedAt']))) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
  const artifact = (raw: unknown): MediaLocalApiObservation['model'] => {
    if (raw === null) return null
    const a = exactApiFields(raw, ['id', 'sha256', 'version'])
    if (a['sha256'] !== null && (typeof a['sha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(a['sha256']))) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
    return { id: apiIdentifier(a['id']), sha256: a['sha256'] as string | null, version: a['version'] === null ? null : apiIdentifier(a['version']) }
  }
  const result = { mode: p['mode'] as MediaLocalApiObservation['mode'], adapter: apiIdentifier(p['adapter']),
    status: p['status'] as MediaLocalApiObservation['status'], model: artifact(p['model']), workflow: artifact(p['workflow']), observedAt: p['observedAt'] }
  if (result.status === 'ready' && (!result.model || !result.workflow)) throw new MediaNodeError('LOCAL_API_METADATA_REQUIRED')
  return result
}

function sameLocalApiArtifact(reported: MediaLocalApiObservation['model'], observed: MediaLocalApiObservation['model']): boolean {
  if (observed === null) return true
  return reported !== null && reported.id === observed.id
    && (reported.sha256 === null || reported.sha256 === observed.sha256)
    && (reported.version === null || reported.version === observed.version)
}

const terminal = new Set(['failed', 'cancelled', 'awaiting_settlement', 'completed'])
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const researchImage = { adapter: 'comfyui', modelId: 'qwen-image-2.1-int8-convrot', modelVersion: '2.1',
  workflowId: 'comfy-pilot-image-154f7d6133fe0276', workflowSha256: '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be',
  workflowVersion: '1' } as const
function supportsResearchImage(service: Record<string, unknown> | undefined): boolean {
  const model = service?.['model'] as MediaLocalApiObservation['model'] | undefined
  const workflow = service?.['workflow'] as MediaLocalApiObservation['workflow'] | undefined
  return service?.['mode'] === 'image' && service['adapter'] === researchImage.adapter && service['status'] === 'ready'
    && model?.id === researchImage.modelId && model.version === researchImage.modelVersion
    && workflow?.id === researchImage.workflowId && workflow.sha256 === researchImage.workflowSha256
    && workflow.version === researchImage.workflowVersion
}

/** Validate wire identifiers; task ids and device ids cannot select filesystem paths. */
export function mediaNodeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new MediaNodeError('MEDIA_NODE_IDENTIFIER_INVALID')
  return value
}

/** Validate bounded nonnegative integers at the public HTTP boundary. */
export function mediaNodeInteger(value: unknown, max: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > max) throw new MediaNodeError('MEDIA_NODE_NUMBER_INVALID')
  return value
}

/** Validate the closed registration JSON including profile digest fields. */
export function parseMediaNodeRegistration(value: Record<string, unknown>): MediaNodeRegistration {
  const deviceId = mediaNodeId(value['deviceId'])
  const deviceToken = value['deviceToken']
  if (typeof deviceToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(deviceToken)) throw new MediaNodeError('DEVICE_CREDENTIAL_INVALID')
  if (!Array.isArray(value['capabilities']) || value['capabilities'].length > 64) throw new MediaNodeError('MEDIA_NODE_CAPABILITIES_INVALID')
  const capabilities = value['capabilities'].map((raw: unknown): MediaNodeCapability => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MediaNodeError('MEDIA_NODE_CAPABILITIES_INVALID')
    const row = raw as Record<string, unknown>
    if (Object.keys(row).some(key => !['profile_id', 'profile_version', 'model_sha256', 'workflow_sha256', 'validation_receipt_sha256'].includes(key))) throw new MediaNodeError('MEDIA_NODE_CAPABILITIES_INVALID')
    const digests = ['model_sha256', 'workflow_sha256', 'validation_receipt_sha256'] as const
    for (const key of digests) if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(row[key])) throw new MediaNodeError('MEDIA_NODE_CAPABILITIES_INVALID')
    return { profile_id: mediaProfileId(row['profile_id']), profile_version: mediaNodeInteger(row['profile_version'], Number.MAX_SAFE_INTEGER, 1),
      model_sha256: row['model_sha256'] as string, workflow_sha256: row['workflow_sha256'] as string,
      validation_receipt_sha256: row['validation_receipt_sha256'] as string }
  }).sort((a, b) => `${a.profile_id}@${a.profile_version}`.localeCompare(`${b.profile_id}@${b.profile_version}`))
  if (new Set(capabilities.map(c => `${c.profile_id}@${c.profile_version}`)).size !== capabilities.length) throw new MediaNodeError('MEDIA_NODE_CAPABILITIES_INVALID')
  return { deviceId, deviceToken, adapterVersion: mediaNodeId(value['adapterVersion']), capabilityRevision: mediaNodeId(value['capabilityRevision']),
    capabilities, maxConcurrency: mediaNodeInteger(value['maxConcurrency'], 64, 1) }
}

/** Refuse credentials, local paths and embedded media in control metadata. */
export function mediaNodeMetadata(value: unknown, depth = 0): void {
  if (depth > 12) throw new MediaNodeError('MEDIA_CONTROL_METADATA_INVALID')
  if (typeof value === 'string' && /^data:/iu.test(value)) throw new MediaNodeError('MEDIA_CONTROL_BYTES_FORBIDDEN')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(url|path|localPath|base64|data|mediaBytes|deviceToken|accessToken|credential)$/iu.test(key)) throw new MediaNodeError('MEDIA_CONTROL_BYTES_FORBIDDEN')
    if (/^(billing|billing_status|billingStatus|non_billable|nonBillable|billable|price|unit_price_yuan|unitPrice|total_price|charge|charge_amount)$/iu.test(key)) throw new MediaNodeError('MEDIA_BILLING_FIELDS_FORBIDDEN')
    mediaNodeMetadata(child, depth + 1)
  }
}

function mediaProfileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{2,99}$/u.test(value)) throw new MediaNodeError('MEDIA_PROFILE_ID_INVALID')
  return value
}

/** Mirrors Shanghai's closed MediaInput wire validation, without inventing a local price/profile. */
function dispatchMediaInput(spec: Record<string, unknown>): Record<string, unknown> {
  const raw = spec['media_input']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MediaNodeError('MEDIA_DISPATCH_PROFILE_REQUIRED', 409)
  const input = raw as Record<string, unknown>
  const fields = ['capability', 'mode', 'prompt', 'negative_prompt', 'quality', 'orientation', 'seconds', 'assets', 'profile_id', 'profile_version']
  if (Object.keys(input).some(key => !fields.includes(key))) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  const capability = input['capability']; const mode = input['mode']
  const imageModes = ['text_to_image', 'image_to_image', 'image_edit']
  const videoModes = ['text_to_video', 'image_to_video', 'first_last_frame']
  if ((capability !== 'image' && capability !== 'video') || typeof mode !== 'string'
    || !(capability === 'image' ? imageModes : videoModes).includes(mode)) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  if (spec['task_type'] !== (capability === 'image' ? 'image_generate' : 'video_generate')) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  const prompt = input['prompt']; const negative = input['negative_prompt'] === undefined ? '' : input['negative_prompt']
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 8192
    || typeof negative !== 'string' || Buffer.byteLength(negative) > 8192) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  if (!['fast', 'standard', 'clear', 'hd'].includes(String(input['quality']))
    || !['square', 'landscape', 'portrait'].includes(String(input['orientation']))) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  if (capability === 'video') mediaNodeInteger(input['seconds'], 120, 1)
  else if (input['seconds'] !== undefined && input['seconds'] !== null) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  mediaProfileId(input['profile_id']); mediaNodeInteger(input['profile_version'], Number.MAX_SAFE_INTEGER, 1)
  const assets = input['assets'] === undefined ? [] : input['assets']
  if (!Array.isArray(assets) || assets.length > 8) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  const ids = new Set<string>(); const roles: string[] = []
  for (const rawAsset of assets) {
    if (!rawAsset || typeof rawAsset !== 'object' || Array.isArray(rawAsset)) throw new MediaNodeError('MEDIA_INPUT_INVALID')
    const asset = rawAsset as Record<string, unknown>
    if (Object.keys(asset).some(key => !['asset_id', 'sha256', 'role'].includes(key)) || Object.keys(asset).length !== 3) throw new MediaNodeError('MEDIA_INPUT_INVALID')
    const assetId = mediaNodeId(asset['asset_id']); const role = asset['role']
    if (ids.has(assetId) || typeof asset['sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(asset['sha256'])
      || typeof role !== 'string' || !['reference', 'first_frame', 'last_frame'].includes(role)) throw new MediaNodeError('MEDIA_INPUT_INVALID')
    ids.add(assetId); roles.push(role)
  }
  if ((mode === 'text_to_image' || mode === 'text_to_video') && roles.length > 0
    || (mode === 'image_to_image' || mode === 'image_edit') && (roles.length === 0 || roles.some(role => role !== 'reference'))
    || mode === 'image_to_video' && (roles.length !== 1 || roles[0] !== 'first_frame')
    || mode === 'first_last_frame' && (roles.length !== 2 || !roles.includes('first_frame') || !roles.includes('last_frame'))) throw new MediaNodeError('MEDIA_INPUT_INVALID')
  const legacy = ['input_ref', 'input_refs', 'inline_input', 'params', 'code_url']
  if (legacy.some(key => spec[key] !== undefined && spec[key] !== null && spec[key] !== ''
    && !(Array.isArray(spec[key]) && (spec[key] as unknown[]).length === 0)
    && !(typeof spec[key] === 'object' && !Array.isArray(spec[key]) && Object.keys(spec[key] as object).length === 0))
    || (spec['input_kind'] !== undefined && !['', 'params_only'].includes(String(spec['input_kind'])))
    || (spec['redundancy_factor'] !== undefined && spec['redundancy_factor'] !== 1)) throw new MediaNodeError('MEDIA_LEGACY_INPUT_FORBIDDEN')
  return input
}

/** SQLite transactions prevent two gateway connections from reserving the same inbox slot. */
export class MediaNodeStore {
  private readonly db: DatabaseSync
  private readonly researchResultPath: string
  private readonly clock: () => number
  private readonly orderAuthorizationPublicKeys: Readonly<Record<string, string>>
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number

  /** Open a private SQLite file. Startup invalidates stale process connections while preserving tasks.
   * @param options - Absolute private database path, liveness settings and optional deterministic clock.
   */
  constructor(options: { path: string; heartbeatIntervalMs: number; heartbeatTimeoutMs: number; clock?: () => number;
    orderAuthorizationPublicKeys?: Readonly<Record<string, string>> }) {
    if (!isAbsolute(options.path)) throw new Error('MEDIA_NODE_STORE_PATH_INVALID')
    this.heartbeatIntervalMs = mediaNodeInteger(options.heartbeatIntervalMs, 60_000, 100)
    this.heartbeatTimeoutMs = mediaNodeInteger(options.heartbeatTimeoutMs, 180_000, this.heartbeatIntervalMs * 2)
    this.clock = options.clock ?? Date.now
    this.orderAuthorizationPublicKeys = options.orderAuthorizationPublicKeys ?? {}
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    const parent = lstatSync(dirname(options.path))
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error('MEDIA_NODE_STORE_DIRECTORY_PRIVATE_REQUIRED')
    try {
      const stat = lstatSync(options.path)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('MEDIA_NODE_STORE_FILE_PRIVATE_REQUIRED')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.researchResultPath = join(dirname(options.path), 'research-results')
    this.db = new DatabaseSync(options.path)
    chmodSync(options.path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS media_nodes (device_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        revision TEXT NOT NULL, adapter_version TEXT NOT NULL, capabilities TEXT NOT NULL, max_concurrency INTEGER NOT NULL,
        epoch INTEGER NOT NULL, connection_id TEXT NOT NULL, recovered INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0, free_slots INTEGER NOT NULL DEFAULT 0, running TEXT NOT NULL DEFAULT '[]',
        free_vram INTEGER NOT NULL DEFAULT 0, available_seconds INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media_node_inbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        payload TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'leased', event_sequence INTEGER NOT NULL DEFAULT 0,
        UNIQUE(task_id, attempt_id));
      CREATE TABLE IF NOT EXISTS media_node_events (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id, attempt_id, sequence));
      CREATE TABLE IF NOT EXISTS media_control_feed (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, device_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, source_sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(source,task_id,attempt_id,source_sequence));
      CREATE TABLE IF NOT EXISTS media_control_consumers (consumer_id TEXT PRIMARY KEY,
        acked_sequence INTEGER NOT NULL DEFAULT 0, delivered_sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media_result_verdicts (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        result_revision TEXT NOT NULL, payload TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(task_id,attempt_id));
      CREATE TABLE IF NOT EXISTS media_settlement_receipts (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(task_id,attempt_id));
      CREATE TABLE IF NOT EXISTS media_node_controls (device_id TEXT PRIMARY KEY,
        authorization TEXT NOT NULL CHECK(authorization IN ('active','paused','revoked')));
      CREATE TABLE IF NOT EXISTS media_node_admin_audit (ref TEXT PRIMARY KEY,device_id TEXT NOT NULL,
        action TEXT NOT NULL,operator_account_id TEXT NOT NULL,reason TEXT NOT NULL,occurred_at TEXT NOT NULL,
        request TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_local_api_observations (device_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        revision TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(device_id,epoch,revision));
      CREATE TABLE IF NOT EXISTS media_local_api_current (device_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_local_api_probes (request_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,revision TEXT NOT NULL,mode TEXT NOT NULL,adapter TEXT NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,
        result TEXT,status TEXT NOT NULL DEFAULT 'pending',completed_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media_research_execution (device_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,
        revision TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_node_device_info (device_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_node_account_names (owner_id TEXT PRIMARY KEY,username TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_research_tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,attempt_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,owner_id TEXT NOT NULL,assignment_epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        submitted TEXT NOT NULL,payload TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'leased',event_sequence INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER NOT NULL DEFAULT 0,backend_job_id TEXT);
      CREATE TABLE IF NOT EXISTS media_research_results (task_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_research_events (task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(task_id,attempt_id,sequence));
      INSERT OR IGNORE INTO media_control_feed(source,device_id,task_id,attempt_id,lease_epoch,source_sequence,occurred_at,payload)
        SELECT 'node',i.device_id,e.task_id,e.attempt_id,i.lease_epoch,e.sequence,'',e.payload
        FROM media_node_events e JOIN media_node_inbox i ON e.task_id=i.task_id AND e.attempt_id=i.attempt_id
        ORDER BY i.sequence,e.sequence;
      UPDATE media_nodes SET epoch=epoch+1, recovered=0, last_seen=0, free_slots=0;`)
  }

  /** Close the store after all HTTP requests have quiesced. */
  close(): void { this.db.close() }

  /** Bind one saved device credential to its verified account; an identical retry preserves its epoch. */
  register(ownerId: string, value: MediaNodeRegistration, username?: string | null): Record<string, unknown> {
    return this.transaction(() => {
      const existing = this.node(value.deviceId)
      if (existing && this.authorization(value.deviceId) === 'revoked') throw new MediaNodeError('DEVICE_AUTHORIZATION_REVOKED', 403)
      const tokenHash = sha(value.deviceToken)
      const capabilities = JSON.stringify(value.capabilities)
      if (existing && (existing.owner_id !== ownerId || existing.token_hash !== tokenHash)) throw new MediaNodeError('DEVICE_CREDENTIAL_CONFLICT', 409)
      if (username !== undefined) this.accountName(ownerId, username)
      if (existing?.revision === value.capabilityRevision) {
        if (existing.capabilities !== capabilities || existing.adapter_version !== value.adapterVersion || existing.max_concurrency !== value.maxConcurrency) throw new MediaNodeError('CAPABILITY_REVISION_CONFLICT', 409)
        return { ...this.connection(existing), deviceToken: value.deviceToken }
      }
      const epoch = (existing?.epoch ?? 0) + 1
      this.db.prepare(`INSERT INTO media_nodes(device_id,owner_id,token_hash,revision,adapter_version,capabilities,max_concurrency,epoch,connection_id)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,adapter_version=excluded.adapter_version,
        capabilities=excluded.capabilities,max_concurrency=excluded.max_concurrency,epoch=excluded.epoch,connection_id=excluded.connection_id,
        recovered=0,last_seen=0,free_slots=0`).run(value.deviceId, ownerId, tokenHash, value.capabilityRevision, value.adapterVersion, capabilities, value.maxConcurrency, epoch, randomUUID())
      return { ...this.connection(this.node(value.deviceId)!), deviceToken: value.deviceToken }
    })
  }

  /** Replace an old connection using the device credential, without a cached account token. */
  reconnect(deviceId: string, token: string, capabilityRevision: string): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.authenticate(deviceId, token)
      if (row.revision !== capabilityRevision) throw new MediaNodeError('CAPABILITY_REVISION_CONFLICT', 409)
      this.db.prepare('UPDATE media_nodes SET epoch=epoch+1,connection_id=?,recovered=0,last_seen=0,free_slots=0 WHERE device_id=?').run(randomUUID(), deviceId)
      return this.connection(this.node(deviceId)!)
    })
  }

  /** Withdraw idle supply immediately when the Host stops contribution; old epoch messages are refused. */
  disconnect(deviceId: string, token: string, epoch: number): Record<string, unknown> {
    this.authenticate(deviceId, token, epoch)
    this.db.prepare('UPDATE media_nodes SET epoch=epoch+1,recovered=0,last_seen=0,free_slots=0 WHERE device_id=? AND epoch=?').run(deviceId, epoch)
    return { ok: true, online: false }
  }

  /** A channel snapshot must be read before this epoch may publish idle supply. */
  channel(deviceId: string, token: string, epoch: number, afterSequence: number): Record<string, unknown> {
    const row = this.authenticate(deviceId, token, epoch)
    const maximum = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM media_node_inbox WHERE device_id=?').get(deviceId) as { maximum: number }
    if (afterSequence > maximum.maximum) throw new MediaNodeError('MEDIA_CHANNEL_CURSOR_INVALID', 409)
    this.db.prepare('UPDATE media_nodes SET recovered=1 WHERE device_id=? AND epoch=?').run(deviceId, epoch)
    const tasks = this.db.prepare('SELECT * FROM media_node_inbox WHERE device_id=? AND sequence>? ORDER BY sequence LIMIT 64').all(deviceId, afterSequence) as unknown as TaskRow[]
    const recoveryTasks = row.recovered === 1 ? [] : this.db.prepare("SELECT * FROM media_node_inbox WHERE device_id=? AND sequence<=? AND stage NOT IN ('failed','cancelled','awaiting_settlement','completed') ORDER BY sequence LIMIT 64").all(deviceId, afterSequence) as unknown as TaskRow[]
    return { ...this.connection(row), online: this.online(row), sequence: tasks.at(-1)?.sequence ?? afterSequence,
      ...(this.localApiReport(row.device_id, row.epoch) ? { apiProbes: this.apiProbes(row) } : {}),
      tasks: [...recoveryTasks, ...tasks].map(task => ({ sequence: task.sequence, ...JSON.parse(task.payload) as Record<string, unknown>,
        stage: task.stage, expired: task.expires_at <= this.clock() })) }
  }

  /** Save an immutable, credential-free local API snapshot without modifying paid capability or occupancy. */
  apiObservations(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    exactApiFields(body, ['deviceId', 'connectionEpoch', 'observationRevision', 'observations'])
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    this.authenticate(deviceId, token, epoch)
    const revision = apiIdentifier(body['observationRevision'])
    if (!Array.isArray(body['observations']) || body['observations'].length > 2) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
    const observations = body['observations'].map(localApiObservation).sort((a, b) => a.mode.localeCompare(b.mode))
    if (new Set(observations.map(p => p.mode)).size !== observations.length) throw new MediaNodeError('LOCAL_API_METADATA_INVALID')
    const payload = canonicalMediaJson(observations)
    return this.transaction(() => {
      const known = this.db.prepare('SELECT * FROM media_local_api_observations WHERE device_id=? AND epoch=? AND revision=?').get(deviceId, epoch, revision) as LocalApiReport | undefined
      const current = this.localApiReport(deviceId, epoch)
      if (known && (known.payload !== payload || current?.revision !== revision)) throw new MediaNodeError('LOCAL_API_REVISION_CONFLICT', 409)
      if (!known) {
        for (const p of observations) if (this.clock() - Date.parse(p.observedAt) > 60_000 || Date.parse(p.observedAt) - this.clock() > 5_000) throw new MediaNodeError('LOCAL_API_OBSERVATION_STALE', 409)
        this.db.prepare('INSERT INTO media_local_api_observations(device_id,epoch,revision,payload,created_at) VALUES(?,?,?,?,?)').run(deviceId, epoch, revision, payload, this.clock())
        this.db.prepare('INSERT INTO media_local_api_current(device_id,epoch,revision) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision').run(deviceId, epoch, revision)
        this.db.prepare("UPDATE media_local_api_probes SET status='expired' WHERE device_id=? AND status='pending'").run(deviceId)
      }
      return { ok: true, deviceId, connectionEpoch: epoch, observationRevision: revision }
    })
  }

  /** Admit only the original delivered challenge, current epoch and immutable reported mode/adapter. */
  apiProbeResult(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    exactApiFields(body, ['deviceId', 'connectionEpoch', 'requestId', 'observation'])
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    this.authenticate(deviceId, token, epoch)
    const requestId = body['requestId']
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestId)) throw new MediaNodeError('LOCAL_API_PROBE_INVALID')
    const observation = localApiObservation(body['observation']); const result = canonicalMediaJson(observation)
    return this.transaction(() => {
      const probe = this.db.prepare('SELECT * FROM media_local_api_probes WHERE request_id=?').get(requestId) as LocalApiProbe | undefined
      const report = this.localApiReport(deviceId, epoch)
      const reported = report === undefined ? undefined : (JSON.parse(report.payload) as MediaLocalApiObservation[])
        .find(candidate => candidate.mode === observation.mode)
      if (!probe || probe.device_id !== deviceId || probe.epoch !== epoch || !probe.delivered || report?.revision !== probe.revision
        || this.authorization(deviceId) !== 'active' || observation.mode !== probe.mode || observation.adapter !== probe.adapter
        || reported?.status !== 'ready' || !sameLocalApiArtifact(reported.model, observation.model)
        || !sameLocalApiArtifact(reported.workflow, observation.workflow)) throw new MediaNodeError('LOCAL_API_PROBE_SCOPE_INVALID', 409)
      if (probe.result !== null) {
        if (probe.result !== result) throw new MediaNodeError('LOCAL_API_PROBE_CONFLICT', 409)
      } else {
        if (probe.status !== 'pending' || probe.expires_at <= this.clock() || this.clock() - Date.parse(observation.observedAt) > apiProbeLifetime
          || Date.parse(observation.observedAt) - this.clock() > 5_000) throw new MediaNodeError('LOCAL_API_PROBE_EXPIRED', 409)
        probe.status = observation.status === 'ready' ? 'confirmed' : 'failed'; probe.completed_at = this.clock()
        this.db.prepare('UPDATE media_local_api_probes SET result=?,status=?,completed_at=? WHERE request_id=?').run(result, probe.status, probe.completed_at, requestId)
      }
      return { ok: true, deviceId, connectionEpoch: epoch, requestId, status: probe.status,
        confirmedAt: probe.status === 'confirmed' ? new Date(probe.completed_at).toISOString() : null }
    })
  }

  private localApiReport(deviceId: string, epoch: number): LocalApiReport | undefined {
    return this.db.prepare('SELECT o.* FROM media_local_api_observations o JOIN media_local_api_current c ON c.device_id=o.device_id AND c.epoch=o.epoch AND c.revision=o.revision WHERE c.device_id=? AND c.epoch=?').get(deviceId, epoch) as LocalApiReport | undefined
  }

  /** Read-only metadata challenges are separate from task cursors and are safely repeatable until acknowledged. */
  private apiProbes(row: NodeRow): readonly Record<string, unknown>[] {
    const report = this.localApiReport(row.device_id, row.epoch)
    if (!report || this.authorization(row.device_id) !== 'active') return []
    const result: Record<string, unknown>[] = []
    for (const p of JSON.parse(report.payload) as MediaLocalApiObservation[]) {
      if (p.status !== 'ready') continue
      let probe = this.db.prepare('SELECT * FROM media_local_api_probes WHERE device_id=? AND epoch=? AND revision=? AND mode=? ORDER BY rowid DESC LIMIT 1').get(row.device_id, row.epoch, report.revision, p.mode) as LocalApiProbe | undefined
      if (probe?.status === 'pending' && probe.expires_at <= this.clock()) {
        this.db.prepare("UPDATE media_local_api_probes SET status='expired' WHERE request_id=?").run(probe.request_id); probe.status = 'expired'
      }
      if (!probe || probe.status !== 'pending' && this.clock() - (probe.completed_at || probe.created_at) >= apiProbeInterval) {
        const requestId = randomUUID(); const now = this.clock()
        this.db.prepare('INSERT INTO media_local_api_probes(request_id,device_id,epoch,revision,mode,adapter,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(requestId, row.device_id, row.epoch, report.revision, p.mode, p.adapter, now, now + apiProbeLifetime)
        probe = this.db.prepare('SELECT * FROM media_local_api_probes WHERE request_id=?').get(requestId) as unknown as LocalApiProbe
      }
      if (probe.status === 'pending') {
        this.db.prepare('UPDATE media_local_api_probes SET delivered=1 WHERE request_id=?').run(probe.request_id)
        result.push({ requestId: probe.request_id, mode: probe.mode, epoch: probe.epoch, kind: 'metadata', expiresAt: new Date(probe.expires_at).toISOString() })
      }
    }
    return result
  }

  /** Safe read projection reports research API readiness, never paid qualification or an inferred local address. */
  private localServices(row: NodeRow): readonly Record<string, unknown>[] {
    const report = this.localApiReport(row.device_id, row.epoch)
    if (!report) return []
    return (JSON.parse(report.payload) as MediaLocalApiObservation[]).map(p => {
      const probe = this.db.prepare('SELECT * FROM media_local_api_probes WHERE device_id=? AND epoch=? AND revision=? AND mode=? ORDER BY rowid DESC LIMIT 1').get(row.device_id, row.epoch, report.revision, p.mode) as LocalApiProbe | undefined
      const live = this.online(row) && this.authorization(row.device_id) === 'active'
      const state = !live || !probe || probe.status === 'expired' || probe.status === 'pending' && probe.expires_at <= this.clock()
        || probe.status === 'confirmed' && this.clock() - probe.completed_at >= apiConfirmationLifetime ? 'expired' : probe.status
      const observation = probe?.result ? JSON.parse(probe.result) as MediaLocalApiObservation : p
      return { ...observation, status: live ? observation.status : 'unknown', registration: 'reported',
        probe: { state: probe ? state : live ? 'pending' : 'expired', completedAt: probe?.completed_at ? new Date(probe.completed_at).toISOString() : null } }
    })
  }

  /** Only current, recovered epochs can change current liveness and reported capacity. */
  heartbeat(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    const row = this.authenticate(deviceId, token, epoch)
    if (row.recovered !== 1) throw new MediaNodeError('NODE_RECOVERY_REQUIRED', 409)
    if (body['capabilityRevision'] !== row.revision) throw new MediaNodeError('CAPABILITY_REVISION_CONFLICT', 409)
    const freeSlots = mediaNodeInteger(body['freeSlots'], row.max_concurrency)
    const running = body['runningAttemptIds']
    if (!Array.isArray(running) || running.length > row.max_concurrency) throw new MediaNodeError('MEDIA_NODE_RUNNING_INVALID')
    const runningIds = running.map(mediaNodeId)
    if (new Set(runningIds).size !== runningIds.length || freeSlots + runningIds.length > row.max_concurrency) throw new MediaNodeError('MEDIA_NODE_RUNNING_INVALID')
    this.db.prepare('UPDATE media_nodes SET last_seen=?,free_slots=?,running=?,free_vram=?,available_seconds=? WHERE device_id=? AND epoch=?')
      .run(this.clock(), freeSlots, JSON.stringify(runningIds), mediaNodeInteger(body['freeVramMb'], 2_097_152),
        mediaNodeInteger(body['availableSeconds'], 604_800), deviceId, epoch)
    return { ok: true, connectionEpoch: epoch, online: true }
  }

  /** Shanghai's authenticated service places an exact lease into a durable inbox; retries never consume a second slot. */
  dispatch(task: MediaNodeDispatch): Record<string, unknown> {
    const payload = JSON.stringify(task)
    const known = this.db.prepare('SELECT * FROM media_node_inbox WHERE task_id=? AND attempt_id=?').get(task.taskId, task.attemptId) as unknown as TaskRow | undefined
    if (known) {
      if (known.payload !== payload) throw new MediaNodeError('MEDIA_TASK_IDEMPOTENCY_CONFLICT', 409)
      return { ok: true, sequence: known.sequence, duplicate: true }
    }
    if (Object.keys(this.orderAuthorizationPublicKeys).length > 0 || task.envelope['authorization'] !== undefined
      || task.envelope['accountId'] !== undefined || task.envelope['plan_sha256'] !== undefined) {
      verifyMediaDispatchAuthorization(task, this.node(task.deviceId)?.owner_id ?? '', this.orderAuthorizationPublicKeys, Math.floor(this.clock() / 1000))
      const { authorization: _authorization, ...executionMetadata } = task.envelope
      mediaNodeMetadata(executionMetadata)
    } else mediaNodeMetadata(task.envelope)
    if (Buffer.byteLength(payload) > 128 * 1024) throw new MediaNodeError('MEDIA_CONTROL_METADATA_TOO_LARGE', 413)
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM media_node_inbox WHERE task_id=? AND attempt_id=?').get(task.taskId, task.attemptId) as unknown as TaskRow | undefined
      if (prior) {
        if (prior.payload !== payload) throw new MediaNodeError('MEDIA_TASK_IDEMPOTENCY_CONFLICT', 409)
        return { ok: true, sequence: prior.sequence, duplicate: true }
      }
      const uncertain = this.db.prepare("SELECT task_id FROM media_node_inbox WHERE task_id=? AND stage NOT IN ('failed','cancelled') LIMIT 1").get(task.taskId)
      if (uncertain) throw new MediaNodeError('MEDIA_TASK_RECONCILIATION_REQUIRED', 409)
      const row = this.node(task.deviceId)
      if (row && this.authorization(row.device_id) !== 'active') throw new MediaNodeError('DEVICE_AUTHORIZATION_DISABLED', 409)
      if (!row || !this.online(row)) throw new MediaNodeError('MEDIA_NODE_OFFLINE', 409)
      const spec = task.envelope['spec']
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new MediaNodeError('MEDIA_DISPATCH_PROFILE_REQUIRED', 409)
      const input = dispatchMediaInput(spec as Record<string, unknown>)
      const advertised = JSON.parse(row.capabilities) as MediaNodeCapability[]
      if (!advertised.some(capability => capability.profile_id === input['profile_id'] && capability.profile_version === input['profile_version'])) throw new MediaNodeError('MEDIA_NODE_PROFILE_UNAVAILABLE', 409)
      const expires = Date.parse(task.leaseExpiresAt)
      if (!Number.isFinite(expires) || expires <= this.clock() || expires > this.clock() + 3_600_000) throw new MediaNodeError('MEDIA_LEASE_EXPIRED', 409)
      if (this.researchBusy(row.device_id) || this.freeSlots(row) <= 0) throw new MediaNodeError('MEDIA_NODE_BUSY', 409)
      const result = this.db.prepare('INSERT INTO media_node_inbox(device_id,task_id,attempt_id,lease_epoch,expires_at,payload) VALUES(?,?,?,?,?,?)')
        .run(task.deviceId, task.taskId, task.attemptId, task.leaseEpoch, expires, payload)
      return { ok: true, sequence: Number(result.lastInsertRowid), duplicate: false }
    })
  }

  /** Persist monotonic node events; a finished model remains awaiting independent delivery and Shanghai settlement. */
  event(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    this.authenticate(deviceId, token, mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1))
    const taskId = mediaNodeId(body['taskId']); const attemptId = mediaNodeId(body['attemptId'])
    const sequence = mediaNodeInteger(body['sequence'], Number.MAX_SAFE_INTEGER, 1)
    const leaseEpoch = mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1)
    const stage = body['stage']
    if (typeof stage !== 'string' || !['accepted', 'downloading_assets', 'running', 'uploading', 'awaiting_settlement', 'failed', 'cancelled', 'outcome_unknown'].includes(stage)) throw new MediaNodeError('MEDIA_EVENT_STAGE_INVALID')
    const percent = body['percent']
    if (percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) throw new MediaNodeError('MEDIA_EVENT_PERCENT_INVALID')
    const allowed = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'sequence', 'leaseEpoch', 'stage', 'percent', 'assetId', 'artifact']
    if (Object.keys(body).some(k => !allowed.includes(k))) throw new MediaNodeError('MEDIA_EVENT_INVALID')
    const extra: Record<string, unknown> = {}
    if (body['assetId'] !== undefined || body['artifact'] !== undefined) {
      const assetId = body['assetId']; const artifact = body['artifact']
      if (stage !== 'awaiting_settlement' || typeof assetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(assetId)
        || !artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_INVALID')
      const a = artifact as Record<string, unknown>; const fields = ['object_key', 'object_version_id', 'sha256', 'size_bytes', 'content_type']
      if (Object.keys(a).length !== 5 || Object.keys(a).some(k => !fields.includes(k)) || typeof a['sha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(a['sha256'])
        || typeof a['object_version_id'] !== 'string' || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(a['object_version_id']) || a['object_version_id'] === 'null') throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_INVALID')
      mediaNodeInteger(a['size_bytes'], 64 * 1024 * 1024, 1)
      extra['assetId'] = assetId; extra['artifact'] = Object.fromEntries(fields.map(k => [k, a[k]]))
    }
    const payload = JSON.stringify({ taskId, attemptId, sequence, leaseEpoch, stage,
      ...(percent === undefined ? {} : { percent }), ...extra })
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM media_node_inbox WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as unknown as TaskRow | undefined
      if (!row || row.device_id !== deviceId || row.lease_epoch !== leaseEpoch) throw new MediaNodeError('MEDIA_LEASE_MISMATCH', 409)
      if (extra['artifact']) {
        const a = extra['artifact'] as Record<string, unknown>; const original = JSON.parse(row.payload) as MediaNodeDispatch
        const buyer = original.envelope['accountId']; const suffix = ({ 'video/mp4': 'mp4', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[String(a['content_type'])]
        if (!suffix || !Number.isSafeInteger(buyer) || a['object_key'] !== `v8/account-${String(buyer)}/workload-${taskId}/shard-${attemptId}/result/${String(extra['assetId'])}/result.${suffix}`) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_INVALID')
        const saved = this.db.prepare('SELECT payload FROM media_result_verdicts WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as { payload: string } | undefined
        if (saved) {
          const p = JSON.parse(saved.payload) as MediaResultPayload
          if (p.assetId !== extra['assetId'] || Object.keys(a).some(k => a[k] !== p.file[k as keyof typeof p.file])) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_CONFLICT', 409)
        }
      }
      const old = this.db.prepare('SELECT payload FROM media_node_events WHERE task_id=? AND attempt_id=? AND sequence=?').get(taskId, attemptId, sequence) as { payload: string } | undefined
      if (old) {
        if (old.payload !== payload) throw new MediaNodeError('MEDIA_EVENT_IDEMPOTENCY_CONFLICT', 409)
        return { ok: true, sequence, duplicate: true }
      }
      if (sequence <= row.event_sequence || terminal.has(row.stage) && !(row.stage === 'awaiting_settlement' && stage === 'awaiting_settlement' && extra['artifact'])) throw new MediaNodeError('MEDIA_EVENT_STALE', 409)
      const stages = ['leased', 'accepted', 'downloading_assets', 'running', 'uploading', 'awaiting_settlement']
      if (stages.includes(stage) && stages.indexOf(stage) < stages.indexOf(row.stage)) throw new MediaNodeError('MEDIA_EVENT_STALE', 409)
      this.db.prepare('INSERT INTO media_node_events VALUES(?,?,?,?)').run(taskId, attemptId, sequence, payload)
      this.db.prepare('UPDATE media_node_inbox SET event_sequence=?,stage=? WHERE task_id=? AND attempt_id=?').run(sequence, stage, taskId, attemptId)
      this.appendFeed('node', row, sequence, JSON.parse(payload) as Record<string, unknown>)
      return { ok: true, sequence, duplicate: false, settlement: 'not-performed' }
    })
  }

  /** Shanghai reconciles one exact dispatch; a missing response never requests another execution. */
  taskStatus(taskId: string, attemptId: string): Record<string, unknown> {
    const row = this.task(taskId, attemptId)
    const original = JSON.parse(row.payload) as MediaNodeDispatch
    const verdict = this.db.prepare('SELECT envelope FROM media_result_verdicts WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as { envelope: string } | undefined
    const settlement = this.db.prepare('SELECT payload FROM media_settlement_receipts WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as { payload: string } | undefined
    return { ok: true, task: { ...original, stage: row.stage, sequence: row.sequence, eventSequence: row.event_sequence,
      nodeOwnerId: this.node(row.device_id)?.owner_id, expired: row.expires_at <= this.clock(),
      verdict: verdict ? JSON.parse(verdict.envelope) as unknown : null, settlement: settlement ? JSON.parse(settlement.payload) as unknown : null } }
  }

  /** Read durable global sequence pages. Acknowledgement is separate from network delivery. */
  readEvents(consumerId: string, afterSequence: number, limit: number): Record<string, unknown> {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO media_control_consumers(consumer_id) VALUES(?)').run(consumerId)
      const cursor = this.db.prepare('SELECT acked_sequence,delivered_sequence FROM media_control_consumers WHERE consumer_id=?').get(consumerId) as { acked_sequence: number; delivered_sequence: number }
      if (afterSequence > cursor.delivered_sequence) throw new MediaNodeError('MEDIA_EVENT_CURSOR_INVALID', 409)
      const rows = this.db.prepare('SELECT * FROM media_control_feed WHERE sequence>? ORDER BY sequence LIMIT ?').all(afterSequence, limit) as unknown as { sequence: number; source: string; device_id: string; task_id: string; attempt_id: string; lease_epoch: number; source_sequence: number; occurred_at: string; payload: string }[]
      const sequence = rows.at(-1)?.sequence ?? afterSequence
      this.db.prepare('UPDATE media_control_consumers SET delivered_sequence=MAX(delivered_sequence,?) WHERE consumer_id=?').run(sequence, consumerId)
      const maximum = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM media_control_feed').get() as { maximum: number }
      return { ok: true, consumerId, sequence, ackedSequence: cursor.acked_sequence, hasMore: maximum.maximum > sequence,
        events: rows.map(row => ({ sequence: row.sequence, source: row.source, deviceId: row.device_id, taskId: row.task_id,
          attemptId: row.attempt_id, leaseEpoch: row.lease_epoch, nodeEventSequence: row.source_sequence,
          occurredAt: row.occurred_at || null, payload: JSON.parse(row.payload) as unknown })) }
    })
  }

  /** Only already delivered pages can be acknowledged; history remains replayable after client restart. */
  ackEvents(consumerId: string, sequence: number): Record<string, unknown> {
    return this.transaction(() => {
      const cursor = this.db.prepare('SELECT acked_sequence,delivered_sequence FROM media_control_consumers WHERE consumer_id=?').get(consumerId) as { acked_sequence: number; delivered_sequence: number } | undefined
      if (!cursor || sequence > cursor.delivered_sequence || sequence < cursor.acked_sequence) throw new MediaNodeError('MEDIA_EVENT_ACK_INVALID', 409)
      this.db.prepare('UPDATE media_control_consumers SET acked_sequence=? WHERE consumer_id=?').run(sequence, consumerId)
      return { ok: true, consumerId, sequence, duplicate: sequence === cursor.acked_sequence }
    })
  }

  /** The caller has verified an independent result signature; recheck the frozen task before saving it. */
  recordResult(p: MediaResultPayload, envelope: Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.task(p.taskId, p.attemptId)
      const task = JSON.parse(row.payload) as MediaNodeDispatch
      const spec = task.envelope['spec'] as Record<string, unknown>
      const input = spec['media_input'] as Record<string, unknown>
      if (p.deviceId !== row.device_id || p.leaseEpoch !== row.lease_epoch || p.ownerId !== String(task.envelope['accountId'])
        || p.plan_sha256 !== task.envelope['plan_sha256'] || p.profile_id !== input['profile_id'] || p.profile_version !== input['profile_version']) throw new MediaNodeError('MEDIA_RESULT_TASK_MISMATCH', 409)
      const saved = this.db.prepare('SELECT result_revision FROM media_result_verdicts WHERE task_id=? AND attempt_id=?').get(p.taskId, p.attemptId) as { result_revision: string } | undefined
      if (saved) {
        if (saved.result_revision !== p.resultRevision) throw new MediaNodeError('MEDIA_RESULT_CONFLICT', 409)
        return { ok: true, resultRevision: p.resultRevision, duplicate: true }
      }
      if (['failed', 'cancelled', 'completed'].includes(row.stage)) throw new MediaNodeError('MEDIA_RESULT_TASK_STALE', 409)
      this.db.prepare('INSERT INTO media_result_verdicts VALUES(?,?,?,?,?)').run(p.taskId, p.attemptId, p.resultRevision, JSON.stringify(p), JSON.stringify(envelope))
      this.db.prepare('UPDATE media_node_inbox SET stage=? WHERE task_id=? AND attempt_id=?').run(p.status === 'verified' ? 'awaiting_settlement' : 'failed', p.taskId, p.attemptId)
      this.appendFeed('verdict', row, 0, { verdict: envelope })
      return { ok: true, resultRevision: p.resultRevision, duplicate: false }
    })
  }

  /** Shanghai alone posts its committed ledger receipt; Guangzhou stores no second balance or price ledger. */
  settlement(body: Record<string, unknown>): Record<string, unknown> {
    const taskId = mediaNodeId(body['taskId']); const attemptId = mediaNodeId(body['attemptId'])
    const epoch = mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1)
    if (Object.keys(body).length !== 7 || Object.keys(body).some(key => !['taskId', 'attemptId', 'leaseEpoch', 'resultRevision', 'billableResultRevision', 'settled', 'ledgerReceiptId'].includes(key))
      || body['settled'] !== true || body['resultRevision'] !== body['billableResultRevision']) throw new MediaNodeError('MEDIA_SETTLEMENT_INVALID')
    mediaNodeId(body['ledgerReceiptId'])
    return this.transaction(() => {
      const row = this.task(taskId, attemptId)
      const verdict = this.db.prepare('SELECT payload FROM media_result_verdicts WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as { payload: string } | undefined
      const p = verdict ? JSON.parse(verdict.payload) as MediaResultPayload : undefined
      if (epoch !== row.lease_epoch || !p || p.status !== 'verified' || p.resultRevision !== body['resultRevision']) throw new MediaNodeError('MEDIA_SETTLEMENT_RESULT_MISMATCH', 409)
      const payload = canonicalMediaJson(body)
      const saved = this.db.prepare('SELECT payload FROM media_settlement_receipts WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as { payload: string } | undefined
      if (saved) {
        if (saved.payload !== payload) throw new MediaNodeError('MEDIA_SETTLEMENT_CONFLICT', 409)
        return { ok: true, duplicate: true }
      }
      this.db.prepare('INSERT INTO media_settlement_receipts VALUES(?,?,?)').run(taskId, attemptId, payload)
      this.db.prepare("UPDATE media_node_inbox SET stage='completed' WHERE task_id=? AND attempt_id=?").run(taskId, attemptId)
      this.appendFeed('settlement', row, 0, { ...body, stage: 'completed' })
      return { ok: true, duplicate: false }
    })
  }

  private task(taskId: string, attemptId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM media_node_inbox WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as unknown as TaskRow | undefined
    if (!row) throw new MediaNodeError('MEDIA_TASK_NOT_FOUND', 404)
    return row
  }
  private appendFeed(source: string, row: TaskRow, sourceSequence: number, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO media_control_feed(source,device_id,task_id,attempt_id,lease_epoch,source_sequence,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(source, row.device_id, row.task_id, row.attempt_id, row.lease_epoch, sourceSequence, new Date(this.clock()).toISOString(), JSON.stringify(payload))
  }

  /** Internal directory projection reports liveness separately from self-reported capability and official validation. */
  /** Authenticate the contributor credential before any private COS grant is requested. */
  authenticateResultUpload(deviceId: string, token: string, epoch: number, taskId: string, attemptId: string, leaseEpoch: number, recovery = false): void {
    this.authenticate(deviceId, token, epoch)
    const row = this.task(taskId, attemptId)
    if (row.device_id !== deviceId || row.lease_epoch !== leaseEpoch) throw new MediaNodeError('MEDIA_RESULT_TASK_MISMATCH', 409)
    if (!recovery && (row.expires_at <= this.clock() || ['failed', 'cancelled', 'completed'].includes(row.stage))) throw new MediaNodeError('MEDIA_RESULT_LEASE_STALE', 409)
  }

  formalAuthorizationConfigured(): boolean { return Object.keys(this.orderAuthorizationPublicKeys).length > 0 }

  directory(): readonly Record<string, unknown>[] {
    return (this.db.prepare('SELECT * FROM media_nodes ORDER BY device_id LIMIT 1000').all() as unknown as NodeRow[]).map(row => ({
      deviceId: row.device_id, ownerId: row.owner_id, capabilityRevision: row.revision, connectionEpoch: row.epoch,
      online: this.online(row), lastHeartbeatAt: row.last_seen === 0 ? null : new Date(row.last_seen).toISOString(),
      media_profiles: JSON.parse(row.capabilities), free_vram_mb: row.free_vram,
      max_media_concurrent: row.max_concurrency, media_available_seconds: row.available_seconds,
      freeSlots: this.online(row) && this.authorization(row.device_id) === 'active' ? this.freeSlots(row) : 0,
      authorization: this.authorization(row.device_id), verification: 'self-reported', media_exchange_ready: false,
    }))
  }

  /** Read-only research registry: confirmed metadata is never a dispatch or billing authority. */
  /** A verified account refreshes only its own node display identity without replacing its epoch or credential. */
  accountIdentity(ownerId: string, deviceId: string, username: string | null): Record<string, unknown> {
    const row = this.node(deviceId)
    if (!row || row.owner_id !== ownerId) throw new MediaNodeError('DEVICE_OWNER_MISMATCH', 403)
    this.accountName(ownerId, username)
    return { ok: true, deviceId }
  }

  private accountName(ownerId: string, username: string | null): void {
    if (username === null) this.db.prepare('DELETE FROM media_node_account_names WHERE owner_id=?').run(ownerId)
    else {
      if (!username.trim() || Buffer.byteLength(username) > 512 || /[\u0000-\u001f\u007f]/u.test(username)) throw new MediaNodeError('ACCOUNT_NAME_INVALID')
      this.db.prepare('INSERT INTO media_node_account_names(owner_id,username) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET username=excluded.username').run(ownerId, username)
    }
  }

  /** Hardware labels are bounded metadata and confer neither a slot nor verified execution capability. */
  deviceInfo(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    researchExact(body, ['deviceId', 'connectionEpoch', 'deviceInfo'])
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    this.authenticate(deviceId, token, epoch)
    const input = body['deviceInfo']
    if (body['deviceId'] !== deviceId || !input || typeof input !== 'object' || Array.isArray(input)) throw new MediaNodeError('DEVICE_INFO_INVALID')
    const info = input as Record<string, unknown>
    researchExact(info, ['os', 'osVersion', 'arch', 'deviceName', 'cpu', 'gpu', 'memoryMb', 'vramMb'])
    if (typeof info['os'] !== 'string' || !['darwin', 'win32', 'linux'].includes(info['os'])
      || typeof info['arch'] !== 'string' || !['arm64', 'x64', 'ia32', 'arm'].includes(info['arch'])) throw new MediaNodeError('DEVICE_INFO_INVALID')
    const label = (value: unknown): string | null => {
      if (value === null) return null
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f/\\]/u.test(value)
        || value.includes('://') || isIP(value) !== 0) throw new MediaNodeError('DEVICE_INFO_INVALID')
      return value
    }
    const payload = { os: info['os'], osVersion: label(info['osVersion']), arch: info['arch'], deviceName: label(info['deviceName']),
      cpu: label(info['cpu']), gpu: label(info['gpu']), memoryMb: info['memoryMb'] === null ? null : mediaNodeInteger(info['memoryMb'], 2_097_152, 1),
      vramMb: info['vramMb'] === null ? null : mediaNodeInteger(info['vramMb'], 2_097_152) }
    this.db.prepare('INSERT INTO media_node_device_info(device_id,epoch,payload) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET epoch=excluded.epoch,payload=excluded.payload')
      .run(deviceId, epoch, canonicalMediaJson(payload))
    return { ok: true, deviceId, connectionEpoch: epoch }
  }

  /** Save fresh owner-permitted resources without granting a GPU POST or changing formal capacity. */
  researchExecution(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    researchExact(body, ['deviceId', 'connectionEpoch', 'observationRevision', 'mode', 'idle', 'resourceAllowed'])
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    this.authenticate(deviceId, token, epoch)
    if (body['deviceId'] !== deviceId || body['mode'] !== 'image'
      || ![true, false, null].includes(body['idle'] as boolean | null)
      || ![true, false, null].includes(body['resourceAllowed'] as boolean | null)) throw new MediaNodeError('RESEARCH_EXECUTION_INVALID')
    const revision = apiIdentifier(body['observationRevision'])
    return this.transaction(() => {
      const report = this.localApiReport(deviceId, epoch)
      if (!report || report.revision !== revision) throw new MediaNodeError('RESEARCH_EXECUTION_SCOPE_INVALID', 409)
      const now = this.clock()
      this.db.prepare(`INSERT INTO media_research_execution(device_id,epoch,revision,payload,observed_at) VALUES(?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision,payload=excluded.payload,observed_at=excluded.observed_at`)
        .run(deviceId, epoch, revision, canonicalMediaJson({ idle: body['idle'], resourceAllowed: body['resourceAllowed'] }), now)
      return { ok: true, deviceId, connectionEpoch: epoch, observationRevision: revision, mode: 'image', observedAt: new Date(now).toISOString() }
    })
  }

  private researchOccupancy(row: NodeRow): number {
    const attempts = new Set((JSON.parse(row.running) as string[]))
    for (const table of ['media_research_tasks', 'media_node_inbox']) {
      const stored = this.db.prepare(`SELECT attempt_id FROM ${table} WHERE device_id=? AND stage NOT IN ('failed','cancelled','completed')`).all(row.device_id) as { attempt_id: string }[]
      for (const task of stored) attempts.add(task.attempt_id)
    }
    return attempts.size
  }

  private researchExecutionProjection(row: NodeRow): ResearchNodeExecution | undefined {
    const stored = this.db.prepare('SELECT * FROM media_research_execution WHERE device_id=? AND epoch=?').get(row.device_id, row.epoch) as
      { epoch: number; revision: string; payload: string; observed_at: number } | undefined
    if (!stored || this.localApiReport(row.device_id, row.epoch)?.revision !== stored.revision) return undefined
    const age = this.clock() - stored.observed_at
    const fresh = age >= 0 && age < RESEARCH_EXECUTION_TTL_MS && this.online(row) && this.authorization(row.device_id) === 'active'
    const flags = JSON.parse(stored.payload) as { idle: boolean | null; resourceAllowed: boolean | null }
    return { schema: 'qianshou.research-node-execution.v1', observedAt: new Date(stored.observed_at).toISOString(), connectionEpoch: row.epoch,
      observationRevision: stored.revision, idle: fresh ? flags.idle : null, resourceAllowed: fresh ? flags.resourceAllowed : null,
      activeTasks: this.researchOccupancy(row), slotCount: 1 }
  }

  researchDirectory(nonce: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT * FROM media_nodes ORDER BY device_id LIMIT 129').all() as unknown as NodeRow[]
    const nodes = rows.slice(0, 128).filter(row => /^[1-9][0-9]{0,18}$/u.test(row.owner_id) && isIP(row.device_id) === 0 && row.device_id !== 'localhost').map(row => {
      const execution = this.researchExecutionProjection(row)
      return {
      deviceId: row.device_id, ownerId: row.owner_id, connectionEpoch: row.epoch,
      online: this.online(row), authorization: this.authorization(row.device_id),
      lastHeartbeatAt: row.last_seen === 0 ? null : new Date(row.last_seen).toISOString(),
      localServices: this.localServices(row).map(service => ({ ...service, modeGrant: 'reported',
        availableForTrial: this.online(row) && this.authorization(row.device_id) === 'active'
          && supportsResearchImage(service) && (service['probe'] as { state: string }).state === 'confirmed'
          && execution?.idle === true && execution.resourceAllowed === true && execution.activeTasks === 0 })),
      ...(execution === undefined ? {} : { execution }),
    } })
    return { ok: true, schema: 'qianshou.research-api-directory.v1', nonce,
      generatedAt: new Date(this.clock()).toISOString(), truncated: rows.length > 128,
      dispatchAuthority: 'none', formalQualification: 'not_evaluated', nodes }
  }

  /** Durable same-owner trial dispatch. A task/request/attempt can never acquire a replacement execution. */
  researchDispatch(body: Record<string, unknown>): Record<string, unknown> {
    const request = parseResearchLease(body); const submitted = canonicalMediaJson(request)
    return this.transaction(() => {
      const known = this.db.prepare('SELECT * FROM media_research_tasks WHERE task_id=? OR request_id=? OR attempt_id=?').all(request.taskId, request.requestId, request.attemptId) as unknown as ResearchTaskRow[]
      if (known.length) {
        if (known.length !== 1 || known[0]!.submitted !== submitted) throw new MediaNodeError('RESEARCH_TASK_IDEMPOTENCY_CONFLICT', 409)
        return { ok: true, duplicate: true, task: this.researchProjection(known[0]!) }
      }
      const row = this.node(request.deviceId)
      if (!row || row.owner_id !== String(request.accountId)) throw new MediaNodeError('RESEARCH_OWNER_MISMATCH', 403)
      if (row.epoch !== request.connectionEpoch) throw new MediaNodeError('CONNECTION_EPOCH_STALE', 409)
      if (!this.online(row) || this.authorization(row.device_id) !== 'active') throw new MediaNodeError('RESEARCH_NODE_UNAVAILABLE', 409)
      const expires = Date.parse(request.leaseExpiresAt)
      if (expires <= this.clock() || expires > this.clock() + 300_000) throw new MediaNodeError('RESEARCH_LEASE_EXPIRED', 409)
      if (this.researchBusy(request.deviceId) || this.db.prepare("SELECT 1 FROM media_node_inbox WHERE device_id=? AND stage NOT IN ('failed','cancelled','completed') LIMIT 1").get(request.deviceId)
        || (JSON.parse(row.running) as unknown[]).length) throw new MediaNodeError('RESEARCH_NODE_BUSY', 409)
      const report = this.localApiReport(row.device_id, row.epoch)
      const service = this.localServices(row).find(p => p['mode'] === request.mode)
      if (request.modelId !== researchImage.modelId || request.workflowId !== researchImage.workflowId
        || request.adapter !== researchImage.adapter) throw new MediaNodeError('RESEARCH_WORKFLOW_UNSUPPORTED', 409)
      if (!report || !supportsResearchImage(service) || (service?.['probe'] as { state?: string } | undefined)?.state !== 'confirmed') throw new MediaNodeError('RESEARCH_API_NOT_CONFIRMED', 409)
      const execution = this.researchExecutionProjection(row)
      if (execution?.idle !== true || execution.resourceAllowed !== true || execution.activeTasks !== 0) throw new MediaNodeError('RESEARCH_EXECUTION_NOT_READY', 409)
      const lease: ResearchMediaLease = { ...request, observationRevision: report.revision, non_billable: true }
      this.db.prepare('INSERT INTO media_research_tasks(task_id,attempt_id,request_id,device_id,owner_id,assignment_epoch,expires_at,submitted,payload) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(request.taskId, request.attemptId, request.requestId, request.deviceId, String(request.accountId), request.connectionEpoch, expires, submitted, canonicalMediaJson(lease))
      return { ok: true, duplicate: false, task: this.researchProjection(this.researchTask(request.taskId, request.attemptId)) }
    })
  }

  /** A separate cursor keeps old strict formal channel clients compatible. Active original leases always replay. */
  researchChannel(deviceId: string, token: string, epoch: number, afterSequence: number): Record<string, unknown> {
    this.authenticate(deviceId, token, epoch)
    const maximum = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS maximum FROM media_research_tasks WHERE device_id=?').get(deviceId) as { maximum: number }
    if (afterSequence > maximum.maximum) throw new MediaNodeError('RESEARCH_CHANNEL_CURSOR_INVALID', 409)
    const fresh = this.db.prepare('SELECT * FROM media_research_tasks WHERE device_id=? AND sequence>? ORDER BY sequence LIMIT 16').all(deviceId, afterSequence) as unknown as ResearchTaskRow[]
    const recovery = this.db.prepare("SELECT * FROM media_research_tasks WHERE device_id=? AND sequence<=? AND stage NOT IN ('failed','cancelled','completed') ORDER BY sequence LIMIT 1").all(deviceId, afterSequence) as unknown as ResearchTaskRow[]
    const sequence = fresh.at(-1)?.sequence ?? afterSequence
    return { ok: true, deviceId, connectionEpoch: epoch, sequence, hasMore: maximum.maximum > sequence,
      tasks: [...recovery, ...fresh].map(row => this.researchProjection(row)) }
  }

  /** Claim persists the sole submission permission before a runtime POST; retries only reconcile this original claim. */
  researchClaim(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    researchExact(body, ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch'])
    const epoch = mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)
    const node = this.authenticate(deviceId, token, epoch)
    return this.transaction(() => {
      const row = this.researchNodeTask(deviceId, body)
      if (row.claimed_at) return { ok: true, duplicate: true, task: this.researchProjection(row) }
      if (this.authorization(deviceId) !== 'active' || !this.online(node) || row.assignment_epoch !== epoch || row.expires_at <= this.clock()
        || !['leased', 'accepted'].includes(row.stage)) throw new MediaNodeError('RESEARCH_SUBMISSION_DISABLED', 409)
      const lease = JSON.parse(row.payload) as ResearchMediaLease
      const report = this.localApiReport(deviceId, epoch); const service = this.localServices(node).find(p => p['mode'] === lease.mode)
      if (report?.revision !== lease.observationRevision || service?.['status'] !== 'ready' || (service['probe'] as { state?: string })?.state !== 'confirmed'
        || service['adapter'] !== lease.adapter || (service['model'] as { id?: string } | null)?.id !== lease.modelId || (service['workflow'] as { id?: string } | null)?.id !== lease.workflowId) throw new MediaNodeError('RESEARCH_API_NOT_CONFIRMED', 409)
      if (this.researchExecutionProjection(node)?.resourceAllowed !== true) throw new MediaNodeError('RESEARCH_EXECUTION_NOT_READY', 409)
      this.db.prepare("UPDATE media_research_tasks SET claimed_at=?,stage='submitting' WHERE task_id=?").run(this.clock(), row.task_id)
      return { ok: true, duplicate: false, task: this.researchProjection(this.researchTask(row.task_id, row.attempt_id)) }
    })
  }

  /** Research progress cannot claim verified delivery or settlement. Unknown execution retains the original attempt. */
  researchEvent(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    researchExact(body, ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch', 'sequence', 'stage', 'backendJobId'])
    this.authenticate(deviceId, token, mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1))
    const sequence = mediaNodeInteger(body['sequence'], Number.MAX_SAFE_INTEGER, 1)
    const stage = body['stage']; const backend = body['backendJobId'] === null ? null : researchUuid(body['backendJobId'])
    if (typeof stage !== 'string' || !['accepted', 'running', 'outcome_unknown', 'uploading', 'failed', 'cancelled'].includes(stage)) throw new MediaNodeError('RESEARCH_EVENT_STAGE_INVALID')
    const payload = canonicalMediaJson({ taskId: researchUuid(body['taskId']), attemptId: researchUuid(body['attemptId']), leaseEpoch: 1, sequence, stage, backendJobId: backend })
    return this.transaction(() => {
      const row = this.researchNodeTask(deviceId, body)
      const old = this.db.prepare('SELECT payload FROM media_research_events WHERE task_id=? AND attempt_id=? AND sequence=?').get(row.task_id, row.attempt_id, sequence) as { payload: string } | undefined
      if (old) {
        if (old.payload !== payload) throw new MediaNodeError('RESEARCH_EVENT_CONFLICT', 409)
        return { ok: true, taskId: row.task_id, attemptId: row.attempt_id, sequence, duplicate: true }
      }
      if (sequence <= row.event_sequence || researchTerminal.has(row.stage)) throw new MediaNodeError('RESEARCH_EVENT_STALE', 409)
      if (row.backend_job_id !== null && row.backend_job_id !== backend || stage === 'cancelled' && row.claimed_at || stage === 'accepted' && row.claimed_at
        || ['running', 'outcome_unknown', 'uploading'].includes(stage) && !row.claimed_at || !row.claimed_at && backend !== null
        || row.stage === 'uploading' && !['uploading', 'failed'].includes(stage)) throw new MediaNodeError('RESEARCH_EVENT_TRANSITION_INVALID', 409)
      this.db.prepare('INSERT INTO media_research_events VALUES(?,?,?,?)').run(row.task_id, row.attempt_id, sequence, payload)
      this.db.prepare('UPDATE media_research_tasks SET stage=?,event_sequence=?,backend_job_id=? WHERE task_id=?').run(stage, sequence, backend, row.task_id)
      return { ok: true, taskId: row.task_id, attemptId: row.attempt_id, sequence, duplicate: false }
    })
  }

  /** Service reconciliation contains control metadata only; no research read key has access to this operation. */
  researchTaskStatus(taskId: string, attemptId: string): Record<string, unknown> {
    const row = this.researchTask(researchUuid(taskId), researchUuid(attemptId))
    this.recoverResearchResult(row)
    return { ok: true, task: this.researchProjection(this.researchTask(row.task_id, row.attempt_id)) }
  }

  /** A current device credential may recover its original attempt after epoch replacement or administrator pause. */
  researchNodeStatus(deviceId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
    researchExact(body, ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch'])
    this.authenticate(deviceId, token, mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1))
    const row = this.researchNodeTask(deviceId, body); this.recoverResearchResult(row)
    return { ok: true, task: this.researchProjection(this.researchTask(row.task_id, row.attempt_id)) }
  }

  /** Check the saved device and original claim before reading any media request body. Pause permits only old delivery. */
  authenticateResearchResult(deviceId: string, token: string, body: Record<string, unknown>): void {
    researchExact(body, ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch'])
    this.authenticate(deviceId, token, mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1))
    const row = this.researchNodeTask(deviceId, body)
    if (!row.claimed_at || row.backend_job_id === null || ['failed', 'cancelled'].includes(row.stage)) throw new MediaNodeError('RESEARCH_RESULT_NOT_ADMITTED', 409)
  }

  /** Store one original PNG privately, atomically and immutably; only this independent file check can complete a trial. */
  researchUpload(deviceId: string, token: string, body: Record<string, unknown>, expectedSha256: string, bytes: Buffer): Record<string, unknown> {
    this.authenticateResearchResult(deviceId, token, body)
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256) || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new MediaNodeError('RESEARCH_RESULT_HASH_MISMATCH', 422)
    inspectResearchPng(bytes)
    const row = this.researchNodeTask(deviceId, body); this.ensureResearchResultDirectory()
    const path = this.researchResultFile(row); let duplicate = false
    try {
      const saved = this.readResearchResult(row)
      if (!saved.equals(bytes)) throw new MediaNodeError('RESEARCH_RESULT_CONFLICT', 409)
      duplicate = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(this.researchResultPath, `${row.attempt_id}.${randomUUID()}.tmp`)
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      try {
        try { linkSync(temporary, path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (!this.readResearchResult(row).equals(bytes)) throw new MediaNodeError('RESEARCH_RESULT_CONFLICT', 409)
          duplicate = true
        }
        const directory = openSync(this.researchResultPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { fsyncSync(directory) } finally { closeSync(directory) }
      } finally { unlinkSync(temporary) }
    }
    this.recoverResearchResult(row)
    return { ok: true, duplicate, task: this.researchProjection(this.researchTask(row.task_id, row.attempt_id)) }
  }

  /** Account-scoped original bytes are served by Guangzhou, never through Shanghai or a node-supplied URL. */
  researchOwnerResult(accountId: string, taskId: string, attemptId: string): { bytes: Buffer; artifact: Record<string, unknown> } {
    const row = this.researchTask(researchUuid(taskId), researchUuid(attemptId))
    if (row.owner_id !== accountId) throw new MediaNodeError('RESEARCH_TASK_NOT_FOUND', 404)
    this.recoverResearchResult(row)
    const artifact = this.researchArtifact(row)
    if (!artifact) throw new MediaNodeError('RESEARCH_RESULT_NOT_READY', 409)
    const bytes = this.readResearchResult(row); inspectResearchPng(bytes)
    if (bytes.length !== artifact['size_bytes'] || createHash('sha256').update(bytes).digest('hex') !== artifact['sha256']) throw new MediaNodeError('RESEARCH_RESULT_INTEGRITY_FAILED', 422)
    return { bytes, artifact }
  }

  private researchArtifact(row: ResearchTaskRow): Record<string, unknown> | null {
    const saved = this.db.prepare('SELECT payload FROM media_research_results WHERE task_id=? AND attempt_id=?').get(row.task_id, row.attempt_id) as { payload: string } | undefined
    return saved ? JSON.parse(saved.payload) as Record<string, unknown> : null
  }
  private researchResultFile(row: ResearchTaskRow): string { return join(this.researchResultPath, `${row.task_id}.${row.attempt_id}.png`) }
  private ensureResearchResultDirectory(): void {
    mkdirSync(this.researchResultPath, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.researchResultPath)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new MediaNodeError('RESEARCH_RESULT_STORE_PRIVATE_REQUIRED', 503)
  }
  private readResearchResult(row: ResearchTaskRow): Buffer {
    this.ensureResearchResultDirectory()
    const fd = openSync(this.researchResultFile(row), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size < 57 || stat.size > 64 * 1024 * 1024 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new MediaNodeError('RESEARCH_RESULT_STORE_PRIVATE_REQUIRED', 503)
      const bytes = readFileSync(fd)
      if (bytes.length !== stat.size) throw new MediaNodeError('RESEARCH_RESULT_INTEGRITY_FAILED', 422)
      return bytes
    } finally { closeSync(fd) }
  }
  private recoverResearchResult(row: ResearchTaskRow): void {
    if (this.researchArtifact(row) || !row.claimed_at || row.backend_job_id === null || ['failed', 'cancelled'].includes(row.stage)) return
    let bytes: Buffer
    try { bytes = this.readResearchResult(row) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const dimensions = inspectResearchPng(bytes); const digest = createHash('sha256').update(bytes).digest('hex')
    const identity = { taskId: row.task_id, attemptId: row.attempt_id, accountId: Number(row.owner_id), leaseEpoch: 1, sha256: digest, size_bytes: bytes.length, ...dimensions }
    const artifact = { assetId: row.attempt_id, sha256: digest, size_bytes: bytes.length, content_type: 'image/png', ...dimensions,
      resultRevision: sha(canonicalMediaJson(identity)), download_path: `/v1/media/research/result?taskId=${row.task_id}&attemptId=${row.attempt_id}` }
    this.transaction(() => {
      const fresh = this.researchTask(row.task_id, row.attempt_id)
      if (['failed', 'cancelled'].includes(fresh.stage)) throw new MediaNodeError('RESEARCH_RESULT_NOT_ADMITTED', 409)
      const existing = this.researchArtifact(fresh)
      if (existing && canonicalMediaJson(existing) !== canonicalMediaJson(artifact)) throw new MediaNodeError('RESEARCH_RESULT_CONFLICT', 409)
      this.db.prepare('INSERT OR IGNORE INTO media_research_results VALUES(?,?,?)').run(row.task_id, row.attempt_id, canonicalMediaJson(artifact))
      this.db.prepare("UPDATE media_research_tasks SET stage='completed' WHERE task_id=?").run(row.task_id)
    })
  }

  private researchTask(taskId: string, attemptId: string): ResearchTaskRow {
    const row = this.db.prepare('SELECT * FROM media_research_tasks WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as unknown as ResearchTaskRow | undefined
    if (!row) throw new MediaNodeError('RESEARCH_TASK_NOT_FOUND', 404)
    return row
  }
  private researchNodeTask(deviceId: string, body: Record<string, unknown>): ResearchTaskRow {
    const row = this.researchTask(researchUuid(body['taskId']), researchUuid(body['attemptId']))
    if (body['deviceId'] !== deviceId || row.device_id !== deviceId || body['leaseEpoch'] !== 1) throw new MediaNodeError('RESEARCH_LEASE_MISMATCH', 409)
    return row
  }
  private researchBusy(deviceId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM media_research_tasks WHERE device_id=? AND stage NOT IN ('failed','cancelled','completed') LIMIT 1").get(deviceId)
  }
  private researchProjection(row: ResearchTaskRow): Record<string, unknown> {
    return { sequence: row.sequence, lease: JSON.parse(row.payload) as ResearchMediaLease, stage: row.stage, eventSequence: row.event_sequence,
      backendJobId: row.backend_job_id, artifact: this.researchArtifact(row), submission: row.claimed_at ? 'claimed' : 'not_claimed', expired: row.expires_at <= this.clock() }
  }

  /** Administrator-safe projection; counts come from unique persisted tasks and real Shanghai receipts. */
  adminList(ownerId?: string): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT * FROM media_nodes ${ownerId === undefined ? '' : 'WHERE owner_id=?'} ORDER BY device_id LIMIT 1001`)
      .all(...(ownerId === undefined ? [] : [ownerId])) as unknown as NodeRow[]
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM media_nodes ${ownerId === undefined ? '' : 'WHERE owner_id=?'}`)
      .get(...(ownerId === undefined ? [] : [ownerId])) as { total: number }
    return { ok: true, nodes: rows.slice(0, 1000).map(row => this.adminProjection(row)),
      total: count.total, truncated: rows.length > 1000, generatedAt: new Date(this.clock()).toISOString() }
  }

  adminDetail(deviceId: string, ownerId?: string): Record<string, unknown> {
    const row = this.adminNode(deviceId, ownerId)
    const tasks = this.db.prepare(`SELECT task_id,attempt_id,stage FROM (
      SELECT task_id,attempt_id,stage,sequence FROM media_node_inbox WHERE device_id=?
      UNION ALL SELECT task_id,attempt_id,stage,sequence FROM media_research_tasks WHERE device_id=?) ORDER BY sequence DESC,task_id LIMIT 1000`)
      .all(deviceId, deviceId) as unknown as { task_id: string; attempt_id: string; stage: string }[]
    const audit = this.db.prepare('SELECT ref,action,operator_account_id,reason,occurred_at FROM media_node_admin_audit WHERE device_id=? ORDER BY rowid DESC LIMIT 1000')
      .all(deviceId) as unknown as { ref: string; action: string; operator_account_id: string; reason: string; occurred_at: string }[]
    return { ok: true, node: this.adminProjection(row), tasks: tasks.map(t => ({ taskId: t.task_id, attemptId: t.attempt_id, stage: t.stage })),
      audit: audit.map(a => ({ ref: a.ref, action: a.action, operatorAccountId: a.operator_account_id, reason: a.reason, occurredAt: a.occurred_at })) }
  }

  adminPreview(deviceId: string, action: string, ref: string, ownerId?: string): Record<string, unknown> {
    const row = this.adminNode(deviceId, ownerId)
    const before = { deviceId, authorization: this.authorization(deviceId), connectionEpoch: row.epoch }
    if (!['pause', 'resume', 'revoke'].includes(action)) throw new MediaNodeError('MEDIA_ADMIN_ACTION_INVALID')
    if (before.authorization === 'revoked' && action !== 'revoke') throw new MediaNodeError('DEVICE_AUTHORIZATION_REVOKED', 409)
    const authorization = action === 'pause' ? 'paused' : action === 'revoke' ? 'revoked' : 'active'
    const epoch = before.authorization === authorization ? row.epoch : row.epoch + (action === 'pause' ? 0 : 1)
    return { ok: true, ref, preview: { before, after: { deviceId, authorization, connectionEpoch: epoch } } }
  }

  /** Atomic durable authorization and audit. Repeated original refs return the original receipt. Existing leases are unchanged. */
  adminApply(deviceId: string, action: string, ref: string, operatorAccountId: string, reason: string, before: Record<string, unknown>, ownerId?: string): Record<string, unknown> {
    if (reason.trim() !== reason || reason.length < 4 || reason.length > 200 || /[\u0000-\u001f\u007f]/u.test(reason)) throw new MediaNodeError('MEDIA_ADMIN_REASON_INVALID')
    const request = JSON.stringify({ deviceId, action, ref, operatorAccountId, reason, before })
    return this.transaction(() => {
      this.adminNode(deviceId, ownerId)
      const saved = this.db.prepare('SELECT request,result FROM media_node_admin_audit WHERE ref=?').get(ref) as { request: string; result: string } | undefined
      if (saved) {
        if (saved.request !== request) throw new MediaNodeError('MEDIA_ADMIN_IDEMPOTENCY_CONFLICT', 409)
        return JSON.parse(saved.result) as Record<string, unknown>
      }
      const preview = this.adminPreview(deviceId, action, ref, ownerId)['preview'] as { before: Record<string, unknown>; after: Record<string, unknown> }
      if (canonicalMediaJson(before) !== canonicalMediaJson(preview.before)) throw new MediaNodeError('MEDIA_ADMIN_STATE_CHANGED', 409)
      this.db.prepare('INSERT INTO media_node_controls VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET authorization=excluded.authorization').run(deviceId, String(preview.after['authorization']))
      if (preview.after['connectionEpoch'] !== preview.before['connectionEpoch']) {
        this.db.prepare('UPDATE media_nodes SET epoch=?,recovered=0,last_seen=0,free_slots=0 WHERE device_id=?').run(Number(preview.after['connectionEpoch']), deviceId)
      } else if (action === 'pause') this.db.prepare('UPDATE media_nodes SET free_slots=0 WHERE device_id=?').run(deviceId)
      const result = { ok: true, ref, deviceId, authorization: preview.after['authorization'], connectionEpoch: preview.after['connectionEpoch'] }
      this.db.prepare('INSERT INTO media_node_admin_audit VALUES(?,?,?,?,?,?,?,?,?,?)').run(ref, deviceId, action, operatorAccountId, reason,
        new Date(this.clock()).toISOString(), request, JSON.stringify(preview.before), JSON.stringify(preview.after), JSON.stringify(result))
      return result
    })
  }

  adminCheck(ref: string, operatorAccountId: string, ownerId?: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT device_id,operator_account_id,result FROM media_node_admin_audit WHERE ref=?').get(ref) as { device_id: string; operator_account_id: string; result: string } | undefined
    if (!row || row.operator_account_id !== operatorAccountId) return { ok: true, ref, recorded: false }
    this.adminNode(row.device_id, ownerId)
    return { ok: true, ref, recorded: true, result: JSON.parse(row.result) as unknown }
  }

  private adminNode(deviceId: string, ownerId?: string): NodeRow {
    const row = this.node(deviceId)
    if (!row || ownerId !== undefined && row.owner_id !== ownerId) throw new MediaNodeError('MEDIA_NODE_NOT_FOUND', 404)
    return row
  }
  private authorization(deviceId: string): 'active' | 'paused' | 'revoked' {
    return (this.db.prepare('SELECT authorization FROM media_node_controls WHERE device_id=?').get(deviceId) as { authorization: 'active' | 'paused' | 'revoked' } | undefined)?.authorization ?? 'active'
  }
  private adminProjection(row: NodeRow): Record<string, unknown> {
    const counts = this.db.prepare(`SELECT COUNT(DISTINCT task_id) AS total,
      COUNT(DISTINCT CASE WHEN stage NOT IN ('failed','cancelled','completed') THEN task_id END) AS active
      FROM (SELECT task_id,stage FROM media_node_inbox WHERE device_id=?
        UNION ALL SELECT task_id,stage FROM media_research_tasks WHERE device_id=?)`).get(row.device_id, row.device_id) as { total: number; active: number }
    const settled = this.db.prepare('SELECT COUNT(DISTINCT i.task_id) AS total FROM media_node_inbox i JOIN media_settlement_receipts s ON i.task_id=s.task_id AND i.attempt_id=s.attempt_id WHERE i.device_id=?').get(row.device_id) as { total: number }
    // Profile digests alone do not establish image/video support; do not infer a mode from a profile name.
    const name = this.db.prepare('SELECT username FROM media_node_account_names WHERE owner_id=?').get(row.owner_id) as { username: string } | undefined
    const info = this.db.prepare('SELECT payload FROM media_node_device_info WHERE device_id=? AND epoch=?').get(row.device_id, row.epoch) as { payload: string } | undefined
    return { deviceId: row.device_id, ownerId: row.owner_id, username: name?.username ?? null,
      deviceInfo: info ? JSON.parse(info.payload) as Record<string, unknown> : null,
      online: this.online(row), authorization: this.authorization(row.device_id),
      modes: [], lastHeartbeatAt: row.last_seen === 0 ? null : new Date(row.last_seen).toISOString(), connectionEpoch: row.epoch,
      activeTasks: counts.active, totalTasks: counts.total, settledTasks: settled.total,
      ...(this.localApiReport(row.device_id, row.epoch) ? { localServices: this.localServices(row) } : {}) }
  }

  private node(deviceId: string): NodeRow | undefined { return this.db.prepare('SELECT * FROM media_nodes WHERE device_id=?').get(deviceId) as unknown as NodeRow | undefined }
  private freeSlots(row: NodeRow): number {
    const pending = this.db.prepare("SELECT attempt_id FROM media_node_inbox WHERE device_id=? AND stage NOT IN ('failed','cancelled','awaiting_settlement','completed')").all(row.device_id) as unknown as { attempt_id: string }[]
    const running = JSON.parse(row.running) as string[]
    return Math.max(0, row.free_slots - pending.filter(task => !running.includes(task.attempt_id)).length)
  }
  private online(row: NodeRow): boolean { return this.authorization(row.device_id) !== 'revoked' && row.recovered === 1 && row.last_seen > 0 && this.clock() - row.last_seen < this.heartbeatTimeoutMs }
  private authenticate(deviceId: string, token: string, epoch?: number): NodeRow {
    const row = this.node(deviceId)
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(sha(token), 'hex'))) throw new MediaNodeError('DEVICE_CREDENTIAL_INVALID', 401)
    if (this.authorization(deviceId) === 'revoked') throw new MediaNodeError('DEVICE_AUTHORIZATION_REVOKED', 403)
    if (epoch !== undefined && row.epoch !== epoch) throw new MediaNodeError('CONNECTION_EPOCH_STALE', 409)
    return row
  }
  private connection(row: NodeRow): Record<string, unknown> {
    return { ok: true, deviceId: row.device_id, connectionId: row.connection_id, connectionEpoch: row.epoch,
      heartbeatIntervalMs: this.heartbeatIntervalMs, heartbeatTimeoutMs: this.heartbeatTimeoutMs }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
