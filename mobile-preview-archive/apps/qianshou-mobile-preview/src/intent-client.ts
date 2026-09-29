/** Account-authenticated client for the model-gateway intent classifier. */

export type IntentDecision =
  | { readonly route: 'chat' }
  | {
    readonly route: 'image'
    readonly stage: 'clarify'
    readonly originalText: string
    readonly question: string
  }
  | {
    readonly route: 'image'
    readonly stage: 'generate'
    readonly prompt: string
    readonly model: string
  }

export interface IntentPrevious {
  readonly capability: 'image.generate'
  readonly originalText: string
  readonly stage: 'clarify'
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseDecision(payload: unknown): IntentDecision | null {
  const body = objectOf(payload)
  if (body === null || body.ok !== true) return null
  if (body.route === 'chat') return { route: 'chat' }
  if (body.route !== 'image') return null
  if (body.stage === 'clarify') {
    const originalText = stringOf(body.originalText)
    const question = stringOf(body.question)
    if (originalText === undefined || question === undefined) return null
    return { route: 'image', stage: 'clarify', originalText, question }
  }
  if (body.stage === 'generate') {
    const prompt = stringOf(body.prompt)
    const model = stringOf(body.model)
    if (prompt === undefined || model === undefined) return null
    return { route: 'image', stage: 'generate', prompt, model }
  }
  return null
}

/**
 * Classify one conversation turn. 404/network return `null` so the phone can
 * keep a local fallback until the live gateway process loads this route.
 */
export function createIntentClient(options: {
  readonly fetch: typeof fetch
  readonly access: (signal: AbortSignal) => Promise<string | null>
  readonly accountId: () => string | null
  readonly endpoint?: string
}): {
  readonly classify: (
    request: { readonly text: string; readonly previous?: IntentPrevious; readonly attachmentCount?: number },
    signal: AbortSignal,
  ) => Promise<IntentDecision | null>
} {
  const endpoint = options.endpoint ?? '/api/qianshou/ai/intent'
  return {
    classify: async (request, signal) => {
      const accountId = options.accountId()
      if (!accountId) return null
      const token = await options.access(signal)
      signal.throwIfAborted()
      if (!token || options.accountId() !== accountId) return null
      let response: Response
      try {
        response = await options.fetch(endpoint, {
          method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            text: request.text,
            ...(request.previous === undefined ? {} : { previous: request.previous }),
            ...(request.attachmentCount === undefined ? {} : { attachmentCount: request.attachmentCount }),
          }),
        })
      } catch {
        return null
      }
      if (response.status === 404) return null
      if (!response.ok) return null
      return parseDecision(await response.json().catch(() => null))
    },
  }
}
