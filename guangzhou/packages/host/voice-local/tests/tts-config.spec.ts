import { describe, expect, it } from 'vitest'
import { resolveTtsOptions } from '../src/tts-config.ts'

const installed = { FORGE_TTS_PYTHON: '/optional/python', FORGE_TTS_WORKER: '/optional/worker.py', FORGE_TTS_MODEL: '/optional/model' }

describe('optional desktop TTS installation', () => {
  it('uses complete launcher paths only when no configured asset path is set', () => {
    expect(resolveTtsOptions({}, installed).assets).toEqual({ python: '/optional/python', worker: '/optional/worker.py', model: '/optional/model' })
    expect(resolveTtsOptions({ ttsPythonPath: '', ttsWorkerPath: '', ttsModelPath: '' }, installed).assets).toBeDefined()
    expect(resolveTtsOptions({}, {}).assets).toBeUndefined()
  })

  it('preserves explicit assets, voice and limits instead of replacing them with a new installation', () => {
    const config = { ttsPythonPath: '/existing/python', ttsWorkerPath: '/existing/worker.py', ttsModelPath: '/existing/model',
      ttsDefaultSpeaker: 'Serena' as const, ttsMaxTextChars: 300, ttsIdleTimeoutMs: 900000 }
    expect(resolveTtsOptions(config, installed)).toMatchObject({
      assets: { python: '/existing/python', worker: '/existing/worker.py', model: '/existing/model' },
      defaultSpeaker: 'Serena', maxTextChars: 300, idleTimeoutMs: 900000,
    })
  })

  it('never fills a partial explicit configuration with unrelated launcher assets', () => {
    expect(() => resolveTtsOptions({ ttsPythonPath: '/existing/python' }, installed)).toThrow('together')
    expect(() => resolveTtsOptions({}, { FORGE_TTS_PYTHON: '/optional/python' })).toThrow('together')
    expect(() => resolveTtsOptions({}, { ...installed, FORGE_TTS_WORKER: 'relative.py' })).toThrow('absolute')
  })
})
