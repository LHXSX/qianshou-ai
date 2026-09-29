/** Click-through window character with a small, keyboard-accessible control strip. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  advanceCharacterPosition, avoidCharacterPanel, characterBounds, fitCharacterPosition,
  type CharacterAction, type CharacterBounds, type CharacterDirection, type CharacterFacing,
  type CharacterFrame, type CharacterPosition,
} from './character-position.ts'
import css from './CharacterStage.module.css'

/** Character chrome is independent from microphone and task ownership. */
export interface CharacterStageProps extends PropsLocale<'chat'> {
  readonly state: 'idle' | 'listening' | 'speaking' | 'busy'
  readonly status: string
  readonly onClose: () => void
  readonly onInterrupt?: (() => void) | undefined
  readonly revealControls?: boolean | undefined
  readonly renderCharacter: (frame: CharacterFrame) => ReactNode
  readonly children?: ReactNode
}

const ACTIONS = ['idle', 'wave', 'walk', 'climb', 'lean', 'sit'] as const

/**
 * Render a movable character without intercepting clicks through its canvas.
 * @param props - Renderer, real controller status, and owner-provided voice controls.
 * @returns A body portal; only the control strip and expanded details accept pointer input.
 */
export function CharacterStage({ state, status, onClose, onInterrupt, revealControls, renderCharacter, children, t }: CharacterStageProps) {
  const [action, setAction] = useState<CharacterAction>('idle')
  const [facing, setFacing] = useState<CharacterFacing>('left')
  const [moving, setMoving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const stage = useRef<HTMLElement>(null)
  const handle = useRef<HTMLButtonElement>(null)
  const actionsButton = useRef<HTMLButtonElement>(null)
  const detailsButton = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  const position = useRef<CharacterPosition | null>(null)
  const bounds = useRef<CharacterBounds>({ left: 12, right: 12, top: 12, bottom: 12 })
  const direction = useRef<CharacterDirection>(-1)
  const pose = useRef({ action, facing })
  pose.current = { action, facing }
  const waveTimer = useRef<ReturnType<typeof setTimeout> | undefined>()
  const drag = useRef<{ readonly id: number; readonly pointer: CharacterPosition; readonly origin: CharacterPosition } | null>(null)

  const place = useCallback((next: CharacterPosition) => {
    const fitted = fitCharacterPosition(next, bounds.current)
    position.current = fitted
    stage.current?.style.setProperty('--character-x', `${fitted.x}px`)
    stage.current?.style.setProperty('--character-y', `${fitted.y}px`)
  }, [])

  useLayoutEffect(() => {
    const fit = () => {
      const box = stage.current?.getBoundingClientRect()
      bounds.current = characterBounds(
        { width: window.innerWidth, height: window.innerHeight },
        { width: box?.width || 220, height: box?.height || 330 },
      )
      const next = position.current ?? { x: bounds.current.right, y: bounds.current.bottom }
      const current = pose.current
      const preferred = {
        x: current.action === 'climb' || current.action === 'lean'
          ? current.facing === 'left' ? bounds.current.left : bounds.current.right : next.x,
        y: current.action === 'walk' || current.action === 'sit' ? bounds.current.bottom : next.y,
      }
      const team = document.querySelector<HTMLElement>('[data-team-dock="expanded"]')
      const teamBox = team?.getBoundingClientRect()
      const layout = avoidCharacterPanel(preferred, { width: box?.width || 220, height: box?.height || 330 },
        bounds.current, teamBox && teamBox.width > 0 && teamBox.height > 0 ? teamBox : undefined)
      stage.current?.style.setProperty('--character-details-max-height', `${layout.detailsMaxHeight}px`)
      place(layout.position)
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit)
    if (stage.current !== null) observer?.observe(stage.current)
    let observedTeam: Element | null = null
    const syncTeam = () => {
      const team = document.querySelector('[data-team-dock="expanded"]')
      if (team !== observedTeam) {
        if (observedTeam !== null) observer?.unobserve(observedTeam)
        observedTeam = team
        if (team !== null) observer?.observe(team)
      }
      fit()
    }
    syncTeam()
    const panels = new MutationObserver(records => {
      // Portals are direct body children. Streaming message mutations should
      // not trigger layout work; only panel membership/state can move the dock.
      if (records.some(record => record.type === 'attributes' || record.target === document.body)) syncTeam()
    })
    panels.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-team-dock'] })
    window.addEventListener('resize', fit)
    return () => { panels.disconnect(); observer?.disconnect(); window.removeEventListener('resize', fit) }
  }, [place, detailsOpen])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => { setReducedMotion(query.matches) }
    update(); query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])

  useEffect(() => {
    if (reducedMotion || (action !== 'walk' && action !== 'climb')) { setMoving(false); return }
    let frame = 0
    let previous: number | undefined
    const tick = (now: number) => {
      const next = advanceCharacterPosition(position.current ?? { x: 12, y: 12 }, action, direction.current,
        previous === undefined ? 0 : (now - previous) / 1000, bounds.current)
      previous = now; direction.current = next.direction
      place(next.position)
      setMoving(value => value === next.moving ? value : next.moving)
      if (action === 'walk') setFacing(next.direction === -1 ? 'left' : 'right')
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [action, place, reducedMotion])

  useEffect(() => () => { clearTimeout(waveTimer.current) }, [])
  useEffect(() => {
    if (!revealControls) return
    clearTimeout(waveTimer.current); setAction('idle'); setMoving(false); setDetailsOpen(true)
  }, [revealControls])

  const stopMotion = () => { clearTimeout(waveTimer.current); setAction('idle'); setMoving(false) }
  const dock = (side: CharacterFacing) => {
    stopMotion(); setFacing(side)
    place({ ...(position.current ?? { x: 12, y: 12 }), x: side === 'left' ? bounds.current.left : bounds.current.right })
    setAction('lean')
  }
  const selectAction = (id: string) => {
    setMenuOpen(false); clearTimeout(waveTimer.current)
    actionsButton.current?.focus({ preventScroll: true })
    if (id === 'left' || id === 'right') { dock(id); return }
    const selected = ACTIONS.find(value => value === id)
    if (selected === undefined) return
    const current = position.current ?? { x: 12, y: 12 }
    if (selected === 'walk' || selected === 'sit') place({ ...current, y: bounds.current.bottom })
    if (selected === 'climb' || selected === 'lean') {
      const side = current.x < (bounds.current.left + bounds.current.right) / 2 ? 'left' : 'right'
      place({ ...current, x: side === 'left' ? bounds.current.left : bounds.current.right }); setFacing(side)
    }
    direction.current = selected === 'climb' || facing === 'left' ? -1 : 1
    setAction(selected)
    if (selected === 'wave') waveTimer.current = setTimeout(() => { setAction('idle') }, 2600)
  }
  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined) return
    stopMotion(); event.currentTarget.focus({ preventScroll: true })
    drag.current = { id: event.pointerId, pointer: { x: event.clientX, y: event.clientY }, origin: { x: box.left, y: box.top } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current
    if (active === null || active.id !== event.pointerId) return
    place({ x: active.origin.x + event.clientX - active.pointer.x, y: active.origin.y + event.clientY - active.pointer.y })
  }
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const moveKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 40 : 12
    const offsets: Record<string, CharacterPosition> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
    }
    const offset = offsets[event.key]
    if (offset === undefined) return
    event.preventDefault(); stopMotion()
    const current = position.current ?? { x: 12, y: 12 }
    place({ x: current.x + offset.x, y: current.y + offset.y })
  }

  return createPortal(<aside ref={stage} className={css.stage} aria-label={t('character.label')}
    data-character-stage data-state={state} data-action={action} data-moving={moving || undefined}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || menuOpen) return
      event.preventDefault(); event.stopPropagation(); stopMotion()
      if (detailsOpen) { setDetailsOpen(false); detailsButton.current?.focus({ preventScroll: true }) }
      else handle.current?.focus({ preventScroll: true })
    }}>
    <div className={css.art}>{renderCharacter({ action, facing, moving })}</div>
    {children !== undefined && <div id={detailsId} className={css.details} hidden={!detailsOpen} data-character-controls>{children}</div>}
    <div className={css.toolbar}>
      <button ref={handle} className={css.drag} type="button" aria-label={t('character.move')} title={t('character.moveHint')}
        onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
        onLostPointerCapture={() => { drag.current = null }} onKeyDown={moveKeyboard}>
        <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">
          <circle cx="4" cy="4" r="1" /><circle cx="8" cy="4" r="1" /><circle cx="4" cy="8" r="1" />
          <circle cx="8" cy="8" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="8" cy="12" r="1" />
        </svg>
      </button>
      <span className={css.status} role="status" title={status} data-character-status>{status}</span>
      {onInterrupt !== undefined && (state === 'speaking' || state === 'busy') && <button
        className={css.interrupt} type="button" onClick={onInterrupt} aria-label={t('character.interrupt')}
        title={t('character.interrupt')}><span aria-hidden="true">■</span></button>}
      <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} onSelect={selectAction} selectedId={action}
        side="top" align="end" compact dense portal autoFocus
        anchor={<button ref={actionsButton} className={css.button} type="button" aria-label={t('character.actions')} title={t('character.actions')}
          aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value) }}>
          <IconChevronDownOutline14 size={13} />
        </button>}
        items={[
          ...ACTIONS.map(id => ({ id, label: t(`character.action.${id}`) })),
          { type: 'separator', id: 'character-position' },
          { id: 'left', label: t('character.left') }, { id: 'right', label: t('character.right') },
        ]}
      />
      {children !== undefined && <button ref={detailsButton} className={css.button} type="button"
        aria-label={t(detailsOpen ? 'character.less' : 'character.more')} title={t(detailsOpen ? 'character.less' : 'character.more')}
        aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => { stopMotion(); setDetailsOpen(value => !value) }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" />
        </svg>
      </button>}
      <button className={css.button} type="button" onClick={onClose} aria-label={t('voice.stop')} title={t('voice.stop')}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  </aside>, document.body)
}
