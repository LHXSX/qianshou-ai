/** Optional resource installer output. Explicit Host settings retain priority over these environment defaults. */
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { readOptionalConfig } from './config.mjs'

/** Read only the owned voice path schema; no profile or credential file is accessed. */
export function optionalVoiceEnvironment(userHome = homedir()) {
  const config = readOptionalConfig(join(userHome, '.local', 'share', 'qianshou-agent', 'voice', 'voice-settings.json'))
  if (Object.keys(config).length === 0) return {}
  if (config.version !== 1) throw new Error('INVALID_CONFIG')
  const result = {}
  for (const [group, mappings] of Object.entries({ asr: { binary: 'FORGE_WHISPER_BINARY', model: 'FORGE_WHISPER_MODEL' }, tts: { python: 'FORGE_TTS_PYTHON', worker: 'FORGE_TTS_WORKER', model: 'FORGE_TTS_MODEL' } })) {
    if (config[group] === undefined) continue
    for (const [field, key] of Object.entries(mappings)) {
      const value = config[group]?.[field]
      if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('INVALID_CONFIG')
      result[key] = value
    }
  }
  return result
}
