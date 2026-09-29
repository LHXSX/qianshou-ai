/** Scoped opt-in shared by continuation messaging and peer discovery. */
import z from '@deepseek-ai/schemastery'

/** Configuration for model-visible sibling communication. */
export interface Config {
  /** Enable same-direct-parent continuable peer communication; default false. */
  siblingMessaging?: boolean
}

export const Config: z<Config> = z.object({
  siblingMessaging: z.boolean().default(false),
})
