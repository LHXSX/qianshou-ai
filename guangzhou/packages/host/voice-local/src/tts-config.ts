/** Host-owned local neural speech assets and bounded synthesis settings. */
import { isAbsolute } from 'node:path'

/** Only bundled, non-cloned CustomVoice speakers are accepted by this endpoint. */
export type TtsSpeaker = 'Vivian' | 'Serena'

/** Deployment settings for a separately installed local MLX worker. */
export interface TtsConfig {
  /** Absolute Python executable path; all three asset paths must be configured together. */
  ttsPythonPath?: string
  /** Absolute path to the trusted JSONL worker script. */
  ttsWorkerPath?: string
  /** Absolute local model directory, including its speech tokenizer. */
  ttsModelPath?: string
  /** Preset used when the synthesis request omits speaker. */
  ttsDefaultSpeaker?: TtsSpeaker
  /** Maximum Unicode code points in a synthesis request. */
  ttsMaxTextChars?: number
  /** Complete request deadline, including queueing and cold model load, in milliseconds. */
  ttsRequestTimeoutMs?: number
  /** Maximum complete WAV response size in bytes. */
  ttsMaxOutputBytes?: number
  /** Number of waiting requests permitted beside the one active synthesis. */
  ttsMaxQueuedRequests?: number
  /** Idle lifetime of a loaded worker in milliseconds. */
  ttsIdleTimeoutMs?: number
}

/** Resolved settings; absent assets explicitly disable neural synthesis. */
export interface TtsOptions {
  assets: { python: string; worker: string; model: string } | undefined
  defaultSpeaker: TtsSpeaker
  maxTextChars: number
  requestTimeoutMs: number
  maxOutputBytes: number
  maxQueuedRequests: number
  idleTimeoutMs: number
}

/**
 * Resolve deployment defaults once and reject partially configured local executables.
 * @param config - Validated plugin configuration.
 * @param environment - Trusted launcher paths, used only when every configured asset path is empty.
 * @returns Complete synthesis settings with either all assets or no assets.
 */
export function resolveTtsOptions(config: TtsConfig, environment: Readonly<Record<string, string | undefined>> = process.env): TtsOptions {
  const explicit = Boolean(config.ttsPythonPath || config.ttsWorkerPath || config.ttsModelPath)
  const python = explicit ? config.ttsPythonPath : environment.FORGE_TTS_PYTHON
  const worker = explicit ? config.ttsWorkerPath : environment.FORGE_TTS_WORKER
  const model = explicit ? config.ttsModelPath : environment.FORGE_TTS_MODEL
  let assets: TtsOptions['assets']
  if (python || worker || model) {
    if (!python || !worker || !model || ![python, worker, model].every(path => isAbsolute(path))) {
      throw new Error('Local TTS requires absolute ttsPythonPath, ttsWorkerPath and ttsModelPath together')
    }
    assets = { python, worker, model }
  }
  return {
    assets,
    defaultSpeaker: config.ttsDefaultSpeaker ?? 'Vivian',
    maxTextChars: config.ttsMaxTextChars ?? 500,
    requestTimeoutMs: config.ttsRequestTimeoutMs ?? 180_000,
    maxOutputBytes: config.ttsMaxOutputBytes ?? 8 * 1024 * 1024,
    maxQueuedRequests: config.ttsMaxQueuedRequests ?? 2,
    idleTimeoutMs: config.ttsIdleTimeoutMs ?? 300_000,
  }
}
