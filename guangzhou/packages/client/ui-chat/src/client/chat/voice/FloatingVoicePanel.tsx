/** Session-owned voice controls presented by the interactive character stage. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CharacterStage } from './CharacterStage.tsx'
import type { CharacterStageProps } from './CharacterStage.tsx'
import { VRMCompanion } from './VRMCompanion.tsx'

interface FloatingVoicePanelProps extends PropsLocale<'chat'> {
  readonly state: string
  readonly status: string
  readonly activity?: string | undefined
  readonly onClose: () => void
  readonly onInterrupt?: (() => void) | undefined
  readonly revealControls?: boolean | undefined
  readonly children: ReactNode
}

/**
 * Project real voice activity onto a transparent, movable full-body character.
 * @param props - Existing controller state and actions; children remain mounted when tucked away.
 * @returns Character chrome without creating a microphone, task, or playback owner.
 */
export function FloatingVoicePanel({
  state, status, activity, onClose, onInterrupt, revealControls, children, t,
}: FloatingVoicePanelProps) {
  const characterState: CharacterStageProps['state'] = state === 'listening' || state === 'speaking'
    ? state : state === 'thinking' || state === 'executing' || state === 'waiting' || state === 'starting' ? 'busy' : 'idle'
  return <CharacterStage t={t} state={characterState} status={status} onClose={onClose} onInterrupt={onInterrupt} revealControls={revealControls ?? state === 'paused'}
    renderCharacter={frame => <VRMCompanion t={t} frame={frame} speaking={state === 'speaking'} modelUrl="/qianshou/voice-companion.vrm" />}>
    {activity !== undefined && activity !== status && <p>{activity}</p>}
    {children}
  </CharacterStage>
}
