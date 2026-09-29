/** Speaker selector for the local neural speech used by the virtual companion. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { loadVoiceCatalog, loadPlaybackSpeaker, playVoiceSample, savePreferredSpeaker, VOICE_PREVIEW_TEXT } from './voice-catalog.ts'
import type { VoiceCatalog, VoiceId } from './voice-catalog.ts'
import css from './VoicePicker.module.css'

/** Observable preview lifecycle; only playing represents audible media. */
export type VoicePreviewState = 'idle' | 'preparing' | 'playing'

type VoicePickerProps = PropsLocale<'chat'> & {
  /** Reports the selected identity, or null when no identity is known. */
  readonly onVoiceChange?: ((speaker: VoiceId | null) => void) | undefined
  /** Runs synchronously before synthesis so the capture owner can pause safely. */
  readonly onPreviewStart?: ((cancel: () => void) => void) | undefined
  readonly onPreviewStateChange?: ((state: VoicePreviewState) => void) | undefined
}

/** Distinguishes a status failure from a status that reported unavailability. */
type CatalogState = VoiceCatalog & { readonly statusError: boolean }

/**
 * Offer every speaker the host reports and remember the user's choice.
 * The list is never hard-coded: it comes from the authenticated status route,
 * and a stored speaker the host no longer accepts remains selected with
 * a visible notice until the user explicitly chooses another speaker.
 * @param props - framework-injected `t` seat plus the owner's change callback.
 * @returns a labelled speaker select with a preview button and honest status text.
 */
export function VoicePicker({ t, onVoiceChange, onPreviewStart, onPreviewStateChange }: VoicePickerProps) {
  const [catalog, setCatalog] = useState<CatalogState | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [previewState, setPreviewState] = useState<VoicePreviewState>('idle')
  const [storageError, setStorageError] = useState(false)
  const stopPreview = useRef<(() => void) | null>(null)
  const reportVoiceChange = useRef(onVoiceChange)
  reportVoiceChange.current = onVoiceChange
  const previewCallbacks = useRef({ onPreviewStart, onPreviewStateChange })
  previewCallbacks.current = { onPreviewStart, onPreviewStateChange }
  const reportPreview = (state: VoicePreviewState) => {
    setPreviewState(state); previewCallbacks.current.onPreviewStateChange?.(state)
  }
  const cancelPreview = () => {
    stopPreview.current?.(); stopPreview.current = null
    reportPreview('idle')
  }

  useEffect(() => {
    const request = new AbortController()
    void loadVoiceCatalog(request.signal).then(({ catalog: loaded, statusError }) => {
      if (request.signal.aborted) return
      setCatalog({ ...loaded, statusError })
      reportVoiceChange.current?.(loaded.available ? loaded.selected : loadPlaybackSpeaker() ?? null)
    })
    return () => {
      request.abort()
      stopPreview.current?.(); stopPreview.current = null
      previewCallbacks.current.onPreviewStateChange?.('idle')
    }
  }, [])

  const preview = (speaker: VoiceId) => {
    cancelPreview()
    previewCallbacks.current.onPreviewStart?.(cancelPreview)
    setPreviewError(false); reportPreview('preparing')
    stopPreview.current = playVoiceSample(VOICE_PREVIEW_TEXT, speaker, () => {
      stopPreview.current = null; reportPreview('idle'); setPreviewError(true)
    }, () => {
      stopPreview.current = null; reportPreview('idle')
    }, () => { reportPreview('playing') }, () => { stopPreview.current = null; reportPreview('idle') })
  }
  const select = (speaker: VoiceId) => {
    if (catalog === null) return
    cancelPreview()
    setPreviewError(false); setStorageError(false)
    // A blocked storage write still applies to this session; the user is told
    // that the choice will not survive a reload instead of losing it silently.
    if (!savePreferredSpeaker(speaker)) setStorageError(true)
    setCatalog({ ...catalog, selected: speaker, selectionUnavailable: false })
    reportVoiceChange.current?.(speaker)
  }

  const unavailable = catalog !== null && !catalog.available
  const selectable = catalog !== null && catalog.available
  const label = catalog?.selected === 'Serena' ? t('voice.serena') : t('voice.vivian')
  // Only a rejected saved choice or a failed preview is a user-facing failure
  // worth an assertive alert. An unreadable status is incidental to the
  // conversation, so it stays a polite status instead of stealing focus.
  const failed = catalog?.selectionUnavailable === true || previewError
  const notice = catalog === null ? null
    : catalog.selectionUnavailable ? t('voice.voiceRejected', { voice: label })
      : storageError ? t('voice.voicePreferenceFailed')
        : unavailable ? t(catalog.statusError ? 'voice.voiceStatusFailed' : 'voice.voiceUnavailable')
          : previewError ? t('voice.voicePreviewFailed')
            : previewState !== 'idle' ? t(previewState === 'playing' ? 'voice.voicePreviewPlaying' : 'voice.voicePreviewPreparing')
              : null
  return <div className={css.root}>
    <label className={css.picker}>
      <span className={css.label}>{t('voice.voice')}</span>
      <select
        className={css.select}
        aria-label={t('voice.voice')}
        value={catalog?.selected ?? 'Vivian'}
        disabled={!selectable}
        onChange={(event) => {
          const next = catalog?.speakers.find(speaker => speaker === event.currentTarget.value)
          if (next !== undefined) select(next)
        }}
      >
        {catalog === null && <option value="Vivian">{t('voice.voiceLoading')}</option>}
        {catalog !== null && !catalog.speakers.includes(catalog.selected) && <option value={catalog.selected} disabled>{label}</option>}
        {catalog?.speakers.map(speaker => <option key={speaker} value={speaker}>
          {speaker === 'Serena' ? t('voice.serena') : t('voice.vivian')}
        </option>)}
      </select>
    </label>
    <button
      className={css.preview}
      type="button"
      aria-label={previewState === 'idle' ? t('voice.voicePreviewVoice', { voice: label }) : t('voice.voicePreviewStop')}
      disabled={(!selectable || catalog.selectionUnavailable) && previewState === 'idle'}
      onClick={() => { if (previewState !== 'idle') cancelPreview(); else if (catalog !== null) preview(catalog.selected) }}
    >{t(previewState === 'idle' ? 'voice.voicePreview' : 'voice.voicePreviewStop')}</button>
    {notice !== null && <span
      className={css.notice}
      data-kind={failed ? 'error' : 'progress'}
      role={failed ? 'alert' : 'status'}
    >{notice}</span>}
  </div>
}
