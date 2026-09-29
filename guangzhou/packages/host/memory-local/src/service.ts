/** Host capability declaration shared by owner routes and opt-in model tools. */
import type { MemoryStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { memoryStore: MemoryStore }
}
