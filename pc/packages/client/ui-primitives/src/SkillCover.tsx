/** One packaged static atlas supplies all capability covers. */
import type { CSSProperties } from 'react'
import css from './SkillCover.module.css'

const POSITIONS: Record<string, readonly [number, number]> = {
  automation: [0, 0], development: [50, 0], design: [100, 0], image: [100, 0],
  legal: [0, 50], research: [0, 50], text: [50, 50], video: [100, 50],
  ppt: [0, 100], spreadsheet: [50, 100], data: [100, 100], other: [100, 100],
}

/** Decorative cover; capability names and prices remain live accessible text. */
export function SkillCover({ category, atlasUrl }: { category: string; atlasUrl?: string | undefined }) {
  if (atlasUrl === undefined) return null
  const [x, y] = POSITIONS[category] ?? POSITIONS.other!
  return <div aria-hidden="true" className={css.cover} data-skill-cover={category}
    style={{ backgroundImage: `url("${atlasUrl}")`, backgroundPosition: `${x}% ${y}%` } as CSSProperties} />
}
