import css from './WorkingRobot.module.css'

/** Decorative activity glyph; the owning status supplies its accessible text and lifetime. */
export function WorkingRobot() {
  return (
    <svg className={css.robot} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" data-working-robot>
      <g className={css.body} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <g className={css.backArm}><path d="M16 15 11 19 8 16" /></g>
        <g className={css.backLeg}><path d="M15 21 11 26 6.5 25" /></g>
        <rect className={css.shell} x="12.5" y="12.5" width="10" height="10" rx="3" transform="rotate(8 17.5 17.5)" />
        <path d="M18 5.5 18.5 3.5" />
        <circle className={css.antenna} cx="18.8" cy="2.8" r="1.2" stroke="none" />
        <rect className={css.shell} x="12.5" y="5.5" width="12" height="8.5" rx="3.1" />
        <path className={css.eyes} d="M17 9v1M21 9v1" />
        <g className={css.frontLeg}><path d="M18 21 22 25 21 29 25 29" /></g>
        <g className={css.frontArm}><path d="M20 15.5 24 19 27 16" /></g>
      </g>
    </svg>
  )
}
