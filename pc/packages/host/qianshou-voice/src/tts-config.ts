/** Host-owned neural speech assets resolved once from validated configuration. */
import { isAbsolute } from 'node:path'
import type { TtsConfig, TtsSpeaker } from './types.ts'

/** Trusted local worker launch paths; absent when neural speech is not configured. */
export interface TtsAssets { python: string; worker: string; model: string }

/** Resolved synthesis settings; `assets` undefined explicitly disables neural speech. */
export interface TtsOptions {
  assets: TtsAssets | undefined
  defaultSpeaker: TtsSpeaker
  maxTextChars: number
  requestTimeoutMs: number
  maxOutputBytes: number
  idleTimeoutMs: number
}

/** Presets bundled with the pinned CustomVoice model; voice cloning is never offered. */
export const TTS_SPEAKERS: readonly TtsSpeaker[] = ['Vivian', 'Serena']

/**
 * Resolve neural speech settings and reject partially configured or relative asset paths.
 * @param config - Validated plugin configuration; no environment lookup happens here.
 * @returns Complete settings with either all three assets or none.
 * @throws TypeError when some but not all asset paths are set, or any is relative or contains NUL.
 */
export function resolveTtsOptions(config: TtsConfig): TtsOptions {
  const paths = [config.ttsPythonPath, config.ttsWorkerPath, config.ttsModelPath]
  let assets: TtsAssets | undefined
  if (paths.some(Boolean)) {
    if (!paths.every(path => isAbsolute(path) && !path.includes('\0'))) {
      throw new TypeError('qianshou-voice requires absolute ttsPythonPath, ttsWorkerPath and ttsModelPath together')
    }
    assets = { python: config.ttsPythonPath, worker: config.ttsWorkerPath, model: config.ttsModelPath }
  }
  return { assets, defaultSpeaker: config.ttsDefaultSpeaker, maxTextChars: config.ttsMaxTextChars,
    requestTimeoutMs: config.ttsRequestTimeoutMs, maxOutputBytes: config.ttsMaxOutputBytes, idleTimeoutMs: config.ttsIdleTimeoutMs }
}
