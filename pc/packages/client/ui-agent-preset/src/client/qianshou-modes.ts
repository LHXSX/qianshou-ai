/** The built-in modes are rendered only after the real Host roster provides all three. */
export const QIANSHOU_MODE_IDS = ['qianshou-ceo', 'qianshou-skill-creator', 'qianshou-call'] as const

/** Whether the current choice can use the compact Qianshou home mode row. */
export function hasQianshouHomeModes(options: readonly { id: string }[], current: string): boolean {
  return QIANSHOU_MODE_IDS.some(id => id === current)
    && QIANSHOU_MODE_IDS.every(id => options.some(option => option.id === id))
}
