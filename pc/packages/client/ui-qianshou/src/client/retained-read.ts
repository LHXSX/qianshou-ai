/** Retained display data never establishes current authorization or a live quote. */
export interface RetainedRead<T> {
  readonly phase: 'loading' | 'ready' | 'unavailable'
  readonly data: T | null
}

/** Begin another read of the same source while keeping its last displayed data.
 * @param previous - Same-source data, or null after the source identity changes.
 * @returns Pending data whose authorization must be revalidated by its consumer.
 */
export function beginRetainedRead<T>(previous: RetainedRead<T> | null): RetainedRead<T> {
  return { phase: 'loading', data: previous?.data ?? null }
}

/** Keep displayed data after a failed read without representing it as current.
 * @param previous - The display data belonging to the failed read's source.
 * @returns Unavailable status with the retained display data.
 */
export function failRetainedRead<T>(previous: RetainedRead<T> | null): RetainedRead<T> {
  return { phase: 'unavailable', data: previous?.data ?? null }
}
