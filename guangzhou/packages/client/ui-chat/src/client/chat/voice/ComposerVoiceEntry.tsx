/** Compact composer entry; microphone and task ownership stay in VoiceConversation. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronDownOutline14, IconEditOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ComposerVoiceEntry.module.css'

/** Delivery routes already owned by the voice interaction controller. */
export type VoiceDelivery = 'manager' | 'parallel' | 'current'

/** Presentation callbacks do not access microphone, playback, or task services. */
export interface ComposerVoiceEntryProps extends PropsLocale<'chat'> {
  readonly delivery: VoiceDelivery
  readonly isSubagent: boolean
  readonly onStartConversation: () => void
  readonly onStartDictation: () => void
  readonly onDeliveryChange: (delivery: VoiceDelivery) => void
}

/**
 * Present a microphone action and an optional menu inside the resident composer.
 * @param props - current delivery choice and controller-owned actions.
 * @returns compact controls that open no microphone until a start action.
 */
export function ComposerVoiceEntry({
  t, delivery, isSubagent, onStartConversation, onStartDictation, onDeliveryChange,
}: ComposerVoiceEntryProps) {
  const [optionsOpen, setOptionsOpen] = useState(false)
  const select = (id: string) => {
    setOptionsOpen(false)
    if (id === 'dictate') onStartDictation()
    else if (id === 'manager' || id === 'parallel' || id === 'current') onDeliveryChange(id)
  }

  return <div className={css.root} data-composer-voice-entry>
    <Button size="sm" className={css.microphone} aria-label={t('voice.start')}
      aria-description={t(`voice.${delivery}`)} title={t('voice.start')} onClick={onStartConversation}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="7" y="2" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </Button>
    <Menu open={optionsOpen} onClose={() => { setOptionsOpen(false) }} onSelect={select}
      selectedId={delivery} side="top" align="end" compact dense portal autoFocus
      anchor={<Button size="sm" className={css.options} aria-label={t('voice.delivery')}
        title={t('voice.delivery')} aria-haspopup="menu" aria-expanded={optionsOpen}
        onClick={() => { setOptionsOpen(value => !value) }}><IconChevronDownOutline14 size={11} /></Button>}
      items={[
        { type: 'label', id: 'delivery-heading', text: t('voice.delivery') },
        { id: 'manager', label: t('voice.manager'), disabled: isSubagent },
        { id: 'parallel', label: t('voice.parallel'), disabled: isSubagent },
        { id: 'current', label: t('voice.current') },
        { type: 'separator', id: 'dictation-separator' },
        { id: 'dictate', label: t('voice.dictate'), icon: <IconEditOutline16 size={15} /> },
      ]}
    />
  </div>
}
