/** Lazily loaded, fully rigged character; no microphone or task ownership. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanionMotionInput } from './companion-motion.ts'
import type { CompanionRuntime } from './vrm-companion-runtime.ts'
import css from './VRMCompanion.module.css'

interface VRMCompanionProps extends PropsLocale<'chat'> {
  readonly frame: Omit<CompanionMotionInput, 'elapsed'>
  readonly speaking: boolean
  readonly modelUrl: string
}

/**
 * Render an interactive full-body model using the existing speech playback observations.
 * @param props - UI-owned activity, approved local model and localized loading messages.
 * @returns A transparent WebGL canvas with an explicit loading/error state.
 */
export function VRMCompanion({ frame, speaking, modelUrl, t }: VRMCompanionProps) {
  const mount = useRef<HTMLDivElement>(null)
  const live = useRef({ frame, speaking })
  live.current = { frame, speaking }
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    const container = mount.current
    if (!container) return
    let disposed = false
    const isDisposed = () => disposed
    let runtime: CompanionRuntime | undefined
    const controller = new AbortController()
    setState('loading')
    void import('./vrm-companion-runtime.ts').then(async ({ createCompanionRuntime }) => {
      if (disposed) return
      runtime = await createCompanionRuntime(container, {
        modelUrl, signal: controller.signal, readState: () => live.current,
        onError: () => { if (!disposed) setState('error') },
      })
      if (isDisposed()) runtime.dispose()
      else setState('ready')
    }).catch(() => { if (!disposed) setState('error') })
    return () => { disposed = true; controller.abort(); runtime?.dispose() }
  }, [modelUrl, generation])
  return <div className={css.host} data-vrm-character={state}>
    <div className={css.canvas} ref={mount} role="img" aria-label={t('voice.characterDescription')} />
    {state !== 'ready' && <div className={css.notice} role="status">
      <span>{t(state === 'loading' ? 'voice.characterLoading' : 'voice.characterFailed')}</span>
      {state === 'error' && <button type="button" onClick={() => { setGeneration(value => value + 1) }}>{t('voice.characterRetry')}</button>}
    </div>}
  </div>
}
