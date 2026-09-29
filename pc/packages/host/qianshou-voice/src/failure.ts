/** Error classification shared by bounded uploads and local recognition. */
import type { VoiceErrorCode } from './types.ts'

/** A safe code and HTTP status without filesystem paths or process stderr. */
export class VoiceFailure extends Error {
  constructor(readonly code: VoiceErrorCode, readonly status: number) { super(code) }
}
