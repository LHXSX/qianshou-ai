// @vitest-environment jsdom
/** Actual Cordis slot mounting and generation guards; no capture/playback is invoked. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import type { VoiceInjected } from '../src/client/VoiceControls.tsx'
import { apply, inject } from '../src/client/index.ts'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); vi.unstubAllEnvs() })

async function bench(withVoice = true) {
  const runtime = await SlotTestRuntime.create(); runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx); locale.setLocale('zh'); runtime.ctx.provide('locale', locale)
  if (withVoice) runtime.remote.provideNamespaces({ qianshouVoice: { status: vi.fn() } })
  const block = createSnapshotStore(undefined)
  const input = new SessionInputShell({ actx: runtime.ctx, canAcceptExternalText: () => true,
    defaultSink: async () => ({ kind: 'success' }), commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  runtime.ctx.provide('conversation', { input: { for: () => input }, blocks: { storeFor: () => block } } as never)
  const sessionId = await runtime.sessions.add({ id: 'voice-session', summary: { cwd: '/fixture' } })
  const reference = runtime.sessions.retain(sessionId); await reference.ready
  await runtime.declare({
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
    'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
  })
  return { runtime, input, sessionId, reference }
}

describe('voice plugin assembly', () => {
  it('mounts the three existing slots only in the Qianshou profile and removes them on disposal', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const b = await bench(); const feature = await b.runtime.mount({ inject, apply })
    const names = ['conversation.input.right', 'conversation.input.dock', 'conversation.chat.assistant-actions'] as const
    expect(names.map(name => b.runtime.slots.entries(name).length)).toEqual([1, 1, 1])
    const entry = b.runtime.slots.entries('conversation.input.right')[0]!
    const injected = (entry.inject as unknown as (id: typeof b.sessionId) => VoiceInjected)(b.sessionId)
    const target = injected.target()
    expect(target?.sessionId).toBe(b.sessionId); expect(target?.cwd).toBe('/fixture'); expect(target?.current()).toBe(true)
    await feature.dispose()
    expect(names.map(name => b.runtime.slots.entries(name).length)).toEqual([0, 0, 0])
    b.reference.release(); b.input.dispose()
  })
  it('actually mounts without a Qianshou Remote and contributes no controls in the upstream profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const b = await bench(false)
    expect(inject).not.toContain('remote.qianshouVoice')
    const feature = await b.runtime.mount({ inject, apply })
    await feature.fiber.await()
    expect(b.runtime.slots.entries('conversation.input.right')).toHaveLength(0)
    b.reference.release(); b.input.dispose()
  })
})
