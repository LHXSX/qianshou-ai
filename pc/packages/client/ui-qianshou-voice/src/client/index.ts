/** Qianshou-only speech controls assembled through existing Conversation slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { VoiceController, type VoiceTarget } from './controller.ts'
import { SystemSpeech } from './speech.ts'
import { transcribe } from './api.ts'
import { VoiceControl, VoiceStatus, ReadAloudAction, type VoiceInjected } from './VoiceControls.tsx'
import { en, zh, type VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.voice': VoiceKey }
}

/** Live Session, input and generated status services required by this plugin. */
export const inject = ['slots', 'locale', 'sessions', 'uiSession', 'conversation', 'remote',
  ...(process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouVoice'] : [])]

/**
 * Register reversible voice presentation without changing model, permissions, or CEO dispatch.
 * @param ctx - Browser plugin scope.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.voice', { zh, en }), 'qianshou-voice: locales')
  const speech = new SystemSpeech()
  const controller = new VoiceController({
    status: async (signal) => {
      signal.throwIfAborted()
      const result = await ctx.remote.qianshouVoice.status()
      signal.throwIfAborted()
      if (!result.ok) throw new Error('VOICE_UNAVAILABLE')
      return result.value
    },
    transcribe,
  }, speech)
  const target = (sessionId: SessionId): VoiceTarget | undefined => {
    const binding = ctx.sessions.binding(sessionId)
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    if (binding === undefined || cwd === undefined) return undefined
    const block = ctx.conversation.blocks.storeFor(sessionId)
    const current = (): boolean => {
      const snapshot = binding.session.getSnapshot()
      return ctx.sessions.binding(sessionId) === binding && !snapshot.removed
        && (snapshot.subagent === null || (snapshot.subagent.address.mode === 'continuable' && snapshot.subagent.parentAvailable === true))
        && ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd === cwd
        && ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction === undefined
        && block.getSnapshot() === undefined
    }
    return { sessionId, cwd, identity: binding, input: ctx.conversation.input.for(binding.ctx), current,
      watch: (changed) => {
        const offs = [binding.session.subscribe(changed), ctx.sessions.list.subscribe(changed),
          ctx.uiSession.sessionStatus.subscribe(changed), block.subscribe(changed)]
        return () => { for (const off of offs) off() }
      } }
  }
  const injected = (sessionId: SessionId): VoiceInjected => ({ controller, target: () => target(sessionId),
    hooks: { voice: controller.store, speech: speech.store } })
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'qianshou-voice', order: 5, locale: 'qianshou.voice', inject: injected,
  }, VoiceControl))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'qianshou-voice-status', order: 5, locale: 'qianshou.voice', inject: injected,
  }, VoiceStatus))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'qianshou-read-aloud', order: 30, locale: 'qianshou.voice', inject: injected,
  }, ReadAloudAction))
  const cancel = (): void => { void controller.cancel(); speech.stop() }
  ctx.effect(() => ctx.on('connection/reset', cancel), 'qianshou-voice: connection')
  ctx.effect(() => {
    window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel)
    return async () => {
      window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel)
      await controller.dispose()
    }
  }, 'qianshou-voice: resource ownership')
}
