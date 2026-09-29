import { useEffect, useRef, useState } from 'react'
import type { ChatViewSlotProps } from '../../contract/slots.ts'
import { speakReply, spokenText } from './speech.ts'
import { loadPlaybackSpeaker } from './voice-catalog.ts'
import css from '../MessageIconActions.module.css'

/** Read a completed assistant answer on demand; navigation always ends playback. */
export function ReadAloud({ text, t }: { text: string; t: ChatViewSlotProps['t'] }) {
  const [speaking, setSpeaking] = useState(false)
  const [failed, setFailed] = useState(false)
  const cancel = useRef<(() => void) | null>(null)
  useEffect(() => () => { cancel.current?.() }, [text])
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined' || spokenText(text) === '') return null
  const label = failed ? t('voice.speechFailed') : t(speaking ? 'voice.stopReading' : 'voice.read')
  return <button type="button" className={css.action} aria-label={label} title={label} aria-pressed={speaking} onClick={() => {
    if (speaking) { cancel.current?.(); setSpeaking(false); return }
    setFailed(false); setSpeaking(true)
    cancel.current = speakReply(text, t('voice.language'), () => { setSpeaking(false) },
      () => { setSpeaking(false); setFailed(true) }, loadPlaybackSpeaker(), () => { setSpeaking(false) })
  }}>
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      {speaking ? <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" /> : <><path d="M9 4 5 7H2v6h3l4 3V4Z" /><path d="M12 7c2 1.5 2 4.5 0 6m3-9c4 3 4 9 0 12" /></>}
    </svg>
  </button>
}
