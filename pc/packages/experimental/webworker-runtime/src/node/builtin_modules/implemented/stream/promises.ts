/** Promise stream helpers from the same maintained implementation as `node:stream`. */
import { promises } from '../stream.ts'

export const { finished, pipeline } = promises

/** CommonJS interop marker consumed by the worker module loader. */
export const __esModule = true

/** CommonJS-compatible promise helper namespace. */
export default promises
