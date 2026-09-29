/** Read OS facts and execute bounded local version probes; never read provider credentials or download models. */
import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem, platform, arch } from 'node:os'
import { createHash } from 'node:crypto'
import { record, SupplyError } from './policy.ts'
import { requestJson, safeOrigin, validateTransportOptions, type JsonTransportOptions } from './http.ts'
import type { LocalSupplyService, SupplyActivity, SupplyGpu, SupplyProbeResult } from './types.ts'

/** Fixed executable and version arguments chosen by the host, not by HTTP request input. */
export interface LocalToolProbe {
  /** Stable lower-case probe key reported in the capability facts. */
  readonly id: string
  /** Owner-visible display name for the probed tool. */
  readonly name: string
  /** Absolute path or PATH-resolved executable; never taken from HTTP input. */
  readonly command: string
  /** Literal argument vector for the version probe; no shell interpolation. */
  readonly args: readonly string[]
}

/** All subprocess bounds and optional local service origins are host configuration. */
export interface LocalProbeOptions extends JsonTransportOptions {
  readonly tools: readonly LocalToolProbe[]
  readonly ollamaOrigin?: string
  readonly readHostActivity: () => Pick<SupplyActivity, 'foregroundTaskActive' | 'voiceActive'>
}

/** Injectable command port for OS fixtures; the real implementation suppresses command output on failure. */
export type ProbeCommand = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<string>

/** Bound version/system probes and remove inherited secret-bearing environment entries.
 * @param options - Per-command timeout and output byte limits.
 * @returns The bounded subprocess command port.
 */
export function createProbeCommand(options: JsonTransportOptions): ProbeCommand {
  validateTransportOptions(options)
  return (command, args, signal) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)
      && !['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'ELECTRON_RUN_AS_NODE'].includes(key)))
    execFile(command, [...args], { env, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxResponseBytes,
      signal, windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) reject(new SupplyError(signal?.aborted ? 'SUPPLY_ABORTED' : 'LOCAL_PROBE_UNAVAILABLE'))
      else resolve(stdout)
    })
  })
}

/** Return real local hardware and install observations. Model installation alone remains pending.
 * @param options - Fixed tools, local model origin and authoritative activity reader.
 * @param signal - Optional caller cancellation signal.
 * @param run - Command port, replaceable by deterministic test fixtures.
 * @returns Observed hardware, tools, model inventory and activity facts.
 */
export async function probeLocalSupply(options: LocalProbeOptions, signal?: AbortSignal, run = createProbeCommand(options)): Promise<SupplyProbeResult> {
  const probeErrors: string[] = []
  const toolJobs = options.tools.map(async (tool): Promise<LocalSupplyService> => {
    try {
      const text = await run(tool.command, tool.args, signal)
      const version = /(?:^|[^\w])v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)(?![\d.])/.exec(text)?.[1] ?? null
      return { id: tool.id, kind: 'tool', name: tool.name, version, verification: 'verified', reason: null }
    } catch {
      if (signal?.aborted) throw new SupplyError('SUPPLY_ABORTED')
      return { id: tool.id, kind: 'tool', name: tool.name, version: null, verification: 'unavailable', reason: 'LOCAL_TOOL_CHECK_FAILED' }
    }
  })
  const gpuJob = probeGpus(platform(), run, signal).catch(() => { probeErrors.push('GPU_PROBE_UNAVAILABLE'); return [] as SupplyGpu[] })
  const idleJob = probeIdle(platform(), run, signal).catch(() => { probeErrors.push('IDLE_PROBE_UNAVAILABLE'); return null })
  const modelsJob = options.ollamaOrigin ? probeOllama(options, signal).catch(() => {
    probeErrors.push('LOCAL_MODEL_SERVICE_UNAVAILABLE'); return [] as LocalSupplyService[]
  }) : Promise.resolve([] as LocalSupplyService[])
  const [tools, gpus, idleSeconds, models] = await Promise.all([Promise.all(toolJobs), gpuJob, idleJob, modelsJob])
  if (signal?.aborted) throw new SupplyError('SUPPLY_ABORTED')
  const cpu = cpus()
  return {
    hardware: { platform: platform(), arch: arch(), cpuModel: cpu[0]?.model ?? 'unknown', logicalCores: cpu.length,
      totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), gpus, probeErrors },
    localServices: [...tools, ...models], activity: { idleSeconds, ...options.readHostActivity() },
  }
}

async function probeOllama(options: LocalProbeOptions, signal?: AbortSignal): Promise<LocalSupplyService[]> {
  const origin = safeOrigin(options.ollamaOrigin!, true)
  const value = await requestJson(new URL('/api/tags', origin), { method: 'GET' }, options, signal)
  if (!record(value) || !Array.isArray(value.models) || value.models.length > 128) throw new SupplyError('LOCAL_MODEL_RESPONSE_INVALID')
  return value.models.map(model => {
    if (!record(model) || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 256
      || /[\x00-\x1f]/.test(model.name) || typeof model.digest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(model.digest)) throw new SupplyError('LOCAL_MODEL_RESPONSE_INVALID')
    const id = createHash('sha256').update(`${model.name}\0${model.digest}`).digest('hex')
    return { id: `ollama:${id}`, kind: 'local-model', name: model.name, version: null,
      verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED' }
  })
}

/** Parse only GPU fields needed by the supply UI; displays and serial identifiers are discarded.
 * @param os - Operating-system identifier reported by Node.
 * @param run - Bounded platform command port.
 * @param signal - Optional caller cancellation signal.
 * @returns Observed GPU names and known dedicated-memory sizes.
 */
export async function probeGpus(os: string, run: ProbeCommand, signal?: AbortSignal): Promise<SupplyGpu[]> {
  if (os === 'darwin') {
    const parsed: unknown = JSON.parse(await run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], signal))
    if (!record(parsed) || !Array.isArray(parsed.SPDisplaysDataType)) throw new SupplyError('GPU_PROBE_INVALID')
    return parsed.SPDisplaysDataType.map(gpu => {
      if (!record(gpu) || typeof gpu.sppci_model !== 'string') throw new SupplyError('GPU_PROBE_INVALID')
      return { name: gpu.sppci_model, vendor: typeof gpu.spdisplays_vendor === 'string' ? gpu.spdisplays_vendor : null,
        memoryBytes: memoryBytes(gpu.spdisplays_vram) }
    })
  }
  if (os === 'win32') {
    const parsed: unknown = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,AdapterCompatibility | ConvertTo-Json -Compress'], signal))
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.map(gpu => {
      if (!record(gpu) || typeof gpu.Name !== 'string') throw new SupplyError('GPU_PROBE_INVALID')
      return { name: gpu.Name, vendor: typeof gpu.AdapterCompatibility === 'string' ? gpu.AdapterCompatibility : null,
        memoryBytes: typeof gpu.AdapterRAM === 'number' && Number.isSafeInteger(gpu.AdapterRAM) && gpu.AdapterRAM > 0 ? gpu.AdapterRAM : null }
    })
  }
  if (os === 'linux') {
    const output = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], signal)
    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split(','); const amount = Number(parts.at(-1))
      if (parts.length !== 2 || !Number.isFinite(amount) || amount <= 0) throw new SupplyError('GPU_PROBE_INVALID')
      return { name: parts[0]!.trim(), vendor: 'NVIDIA', memoryBytes: Math.floor(amount * 1048576) }
    })
  }
  throw new SupplyError('GPU_PROBE_UNSUPPORTED')
}

async function probeIdle(os: string, run: ProbeCommand, signal?: AbortSignal): Promise<number | null> {
  if (os !== 'darwin') throw new SupplyError('IDLE_PROBE_UNSUPPORTED')
  const output = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1'], signal)
  const value = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output)?.[1]
  if (value === undefined) throw new SupplyError('IDLE_PROBE_INVALID')
  return Math.floor(Number(value) / 1e9)
}
function memoryBytes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d+(?:\.\d+)?)\s*(MB|GB)$/i.exec(value.trim())
  return match ? Math.floor(Number(match[1]) * (match[2]!.toUpperCase() === 'GB' ? 1073741824 : 1048576)) : null
}
