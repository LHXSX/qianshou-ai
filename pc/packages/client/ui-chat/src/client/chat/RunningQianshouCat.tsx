import css from './RunningQianshouCat.module.css'

/** The selected Session mode's decorative waiting mascot; omitted mode defaults to CEO. */
export function RunningQianshouCat({ mode = 'ceo' }: { mode?: 'ceo' | 'helper' | 'call' } = {}) {
  return (
    <span className={css.stage} data-qianshou-running-cat data-qianshou-mascot-mode={mode} aria-hidden="true">
      <span className={css.sprite} data-qianshou-cat-sprite />
    </span>
  )
}
