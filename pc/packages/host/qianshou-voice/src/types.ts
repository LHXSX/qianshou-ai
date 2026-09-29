/** Safe local ASR information; asset paths never cross the Remote interface. */
export interface VoiceStatus {
  available: boolean
  busy: boolean
  reason: 'ready' | 'not-configured' | 'assets-unavailable'
  backend: 'whisper.cpp'
  language: 'zh'
  maxAudioBytes: number
  maxDurationSeconds: number
  minDurationSeconds: number
}

/** Stable failures returned by the authenticated audio upload and synthesis routes. */
export type VoiceErrorCode = 'REQUEST_ABORTED' | 'VOICE_BUSY' | 'VOICE_UNAVAILABLE' | 'INVALID_AUDIO'
  | 'VOICE_TIMEOUT' | 'TRANSCRIPTION_FAILED' | 'SESSION_UNAVAILABLE' | 'SESSION_MISMATCH' | 'RESULT_TOO_LARGE'
  | 'TTS_UNAVAILABLE' | 'TTS_BUSY' | 'TTS_TIMEOUT' | 'INVALID_TEXT' | 'SYNTHESIS_FAILED'

/** Only bundled, non-cloned CustomVoice presets are accepted by the synthesis route. */
export type TtsSpeaker = 'Vivian' | 'Serena'

/** Optional local neural speech; all three asset paths are empty or all are absolute. */
export interface TtsConfig {
  /** Absolute Python executable of the separately prepared MLX environment. */
  ttsPythonPath: string
  /** Absolute path to the trusted JSONL worker script copied by the preparer. */
  ttsWorkerPath: string
  /** Absolute local model directory including its speech tokenizer. */
  ttsModelPath: string
  /** Preset used when a synthesis request omits speaker. */
  ttsDefaultSpeaker: TtsSpeaker
  /** Maximum Unicode code points accepted per synthesis request. */
  ttsMaxTextChars: number
  /** Complete synthesis deadline including cold model load, in milliseconds. */
  ttsRequestTimeoutMs: number
  /** Maximum complete WAV response size in bytes. */
  ttsMaxOutputBytes: number
  /** Idle lifetime of a loaded worker process in milliseconds. */
  ttsIdleTimeoutMs: number
}

/** Safe neural speech information returned by the authenticated status route; no paths or diagnostics. */
export interface TtsStatus {
  available: boolean
  reason: 'ready' | 'not-configured' | 'resources-missing'
  /** Whether a live worker has acknowledged a model load; false does not mean unavailable. */
  ready: boolean
  busy: boolean
  engine: 'qwen3-tts'
  speakers: readonly TtsSpeaker[]
  defaultSpeaker: TtsSpeaker
  maxTextChars: number
  maxOutputBytes: number
  sampleRate: 24000
}

/** Configured local resources and per-operation limits; empty paths disable recognition. */
export interface VoiceConfig extends TtsConfig {
  /** Owner-selected absolute whisper.cpp executable path; both asset paths empty disable recognition. */
  binaryPath: string
  /** Absolute local model-weights path paired with binaryPath. */
  modelPath: string
  /** Maximum milliseconds allowed to receive a bounded audio upload. */
  uploadTimeoutMs: number
  /** Maximum milliseconds allowed for the local recognition process. */
  recognitionTimeoutMs: number
  /** Number of CPU threads passed to whisper.cpp. */
  threads: number
  /** Maximum bytes in the recognition result file and serialized text response. */
  maxResultBytes: number
  /** Maximum bytes captured from the recognizer process output by execFile. */
  maxProcessOutputBytes: number
}

/** Resolved native process settings, never taken from a client request. */
export interface VoiceEngineOptions {
  binary: string
  model: string
  timeoutMs: number
  threads: number
  maxResultBytes: number
  maxProcessOutputBytes: number
}
