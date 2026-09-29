/** A real JSONL backend whose fixture import deliberately settles late. */
import { setTimeout } from 'node:timers/promises'
import JsonlSessionPersistence from '../../../../session/session-persistence-jsonl/src/index.ts'

await setTimeout(100)

export default JsonlSessionPersistence
