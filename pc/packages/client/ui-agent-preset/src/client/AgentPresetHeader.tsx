/** Persistent Qianshou preset choice; started sessions select a new conversation. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconAgentPresetOutline16, IconChevronDownOutline14, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSeatInjected } from './AgentPresetSeat.tsx'
import { presetDisplayText } from './locales.ts'
import { hasQianshouHomeModes } from './qianshou-modes.ts'
import css from './AgentPresetLabel.module.css'
import seatCss from './AgentPresetSeat.module.css'

/** Header registration shares the roster and staged-selection controller with the hero. */
export type AgentPresetHeaderProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'> & InjectFace<AgentPresetSeatInjected>

/**
 * Keep the agent-type entry visible after a turn begins, with explicit new-session copy.
 * @param props - current session, Host roster, and guarded selection action.
 * @returns the current preset and its available selection menu.
 */
export function AgentPresetHeader({
  sessionId, useSessions, useAgentPresetSeat, load, select, t,
}: AgentPresetHeaderProps) {
  const session = useSessions(state => state.byId[sessionId])
  const state = useAgentPresetSeat(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const preset = session?.projectionValues?.agentPreset
  const selectable = state.showPicker && session?.origin !== 'subagent'
    && (session?.retainedBy.mainView ?? 0) > 0 && state.options.length > 0

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setOpen(false)
    setError(undefined)
  }, [sessionId, selectable])

  if (typeof preset !== 'string') return null
  // The same blank session already exposes its three real choices in the hero.
  if (process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' && session?.blank === true
    && selectable && hasQianshouHomeModes(state.options, state.current)
    && hasQianshouHomeModes(state.options, preset)) return null
  const current = state.options.find(option => option.id === preset)
  const text = current === undefined ? undefined : presetDisplayText(current, t)
  const label = text?.name ?? (preset === 'qianshou-plugin-creator' ? t('retiredCreatorName') : preset)
  const name = <><IconAgentPresetOutline16 size={process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? 16 : 14} className={css.icon} />{label}</>
  if (!selectable) return <span className={css.label} title={text?.description ?? t('headerHint')}>{name}</span>

  return <div className={css.picker} data-agent-preset-header
    data-qianshou-preset-header={process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? '' : undefined}>
    <Menu open={open} onClose={() => { setOpen(false) }} align="end" portal
      selectedId={preset}
      items={state.options.map((option) => {
        const display = presetDisplayText(option, t)
        return {
          id: option.id,
          disabled: option.id === preset,
          label: <span className={seatCss.item}>
            <span className={seatCss.itemName}>{display.name}</span>
            <span className={seatCss.itemDesc}>{display.description ?? t('noDescription')}</span>
            {session?.blank !== true && <span className={seatCss.itemDesc}>{t('headerNewSession')}</span>}
          </span>,
        }
      })}
      onSelect={(id) => {
        setOpen(false)
        setBusy(true)
        setError(undefined)
        void select(id).then((refusal) => { setError(refusal) })
          .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : t('error')) })
          .finally(() => { setBusy(false) })
      }}
      anchor={<button type="button" className={`${css.label} ${css.control}`}
        aria-label={t('headerPickerLabel', { name: label })}
        aria-haspopup="menu" aria-expanded={open}
        title={session?.blank === true ? t('seatHint') : t('headerNewSessionHint')}
        disabled={busy || state.busy}
        onClick={() => { setOpen(value => !value) }}>
        {name}<IconChevronDownOutline14 size={12} className={css.icon} />
      </button>} />
    {error !== undefined && <span className={css.error} role="alert">{error}</span>}
  </div>
}
