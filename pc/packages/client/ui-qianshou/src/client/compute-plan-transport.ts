/** Owner-only local plan workflow. Nothing here runs in a model tool. */
export interface ComputePlanView {
  readonly id: string
  readonly createdAt: string
  readonly authorization: 'pending' | 'approved' | 'declined'
  readonly workloadId: string | null
  readonly request: {
    readonly capabilityId: string
    readonly goal: string
    readonly budgetMinor: number
    readonly currency: 'CNY'
    readonly maxNodes: number | null
  }
}

export interface ComputeQuoteView {
  readonly quoteId: string
  readonly taskType: string
  readonly name: string
  readonly goal: string
  readonly inputKind: 'inline'
  readonly timeoutSeconds: number
  readonly maxShards: number
  readonly autoShard: boolean
  readonly currency: 'CNY'
  readonly requestedBudget: string
  readonly recommendedBudget: string
  readonly expiresAt: number
  readonly balanceEnough: boolean
  readonly priceBasis: string
  readonly settingsVersion: string
  readonly billingMode: 'server_price' | 'client_budget'
}

export interface ComputePlanTransport {
  read(id: string, signal?: AbortSignal): Promise<ComputePlanView>
  decide(id: string, decision: 'approved' | 'declined'): Promise<ComputePlanView>
  quote(id: string): Promise<ComputeQuoteView>
  /** A failed/uncertain POST must never be retried automatically. */
  submit(id: string, quote: ComputeQuoteView): Promise<ComputePlanView>
}

export interface ComputePlanTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly baseUri?: string
}

export const GENERIC_COMPUTE_ERROR = 'COMPUTE_REQUEST_FAILED'

const PLAN_ID = /^plan_[0-9a-f-]{36}$/u
const QUOTE_ID = /^[a-f0-9]{32}$/u
const MONEY = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMPUTE_RESPONSE_INVALID')
  return value as Record<string, unknown>
}

function string(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

/** Parse a Host receipt, never trusting replayed conversation metadata as the plan itself. */
export function parseComputePlan(value: unknown): ComputePlanView {
  const plan = object(value)
  const request = object(plan.request)
  if (typeof plan.id !== 'string' || !PLAN_ID.test(plan.id)
    || !string(plan.createdAt, 64) || !Number.isFinite(Date.parse(plan.createdAt))
    || !['pending', 'approved', 'declined'].includes(String(plan.authorization))
    || !(plan.workloadId === null || string(plan.workloadId, 128))
    || !string(request.capabilityId, 128) || !string(request.goal)
    || !integer(request.budgetMinor, 0) || request.currency !== 'CNY'
    || !(request.maxNodes === null || integer(request.maxNodes, 1, 64))) throw new Error('COMPUTE_RESPONSE_INVALID')
  return {
    id: plan.id, createdAt: plan.createdAt, authorization: plan.authorization as ComputePlanView['authorization'],
    workloadId: plan.workloadId as string | null,
    request: {
      capabilityId: request.capabilityId, goal: request.goal, budgetMinor: request.budgetMinor,
      currency: 'CNY', maxNodes: request.maxNodes as number | null,
    },
  }
}

/** A quote is a bounded view of Shanghai's actual estimate, with no ticket or credential. */
export function parseComputeQuote(value: unknown): ComputeQuoteView {
  const quote = object(value)
  if (typeof quote.quoteId !== 'string' || !QUOTE_ID.test(quote.quoteId)
    || !string(quote.taskType, 128) || !string(quote.name, 255) || !string(quote.goal)
    || quote.inputKind !== 'inline' || !integer(quote.timeoutSeconds, 1, 86_400)
    || !integer(quote.maxShards, 1, 64) || typeof quote.autoShard !== 'boolean'
    || quote.currency !== 'CNY' || typeof quote.requestedBudget !== 'string' || !MONEY.test(quote.requestedBudget)
    || typeof quote.recommendedBudget !== 'string' || !MONEY.test(quote.recommendedBudget)
    || !integer(quote.expiresAt, 1) || typeof quote.balanceEnough !== 'boolean'
    || !string(quote.priceBasis, 255) || !string(quote.settingsVersion, 128)
    || !['server_price', 'client_budget'].includes(String(quote.billingMode))) throw new Error('COMPUTE_RESPONSE_INVALID')
  return quote as unknown as ComputeQuoteView
}

function errorCode(value: unknown): string {
  try {
    const code = object(object(value).error).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/u.test(code)) return code
  } catch { /* malformed error body */ }
  return GENERIC_COMPUTE_ERROR
}

/** Each call uses the authenticated same-origin Host carrier and rejects redirects. */
export function createComputePlanTransport(options: ComputePlanTransportOptions = {}): ComputePlanTransport {
  const request = options.fetchImpl ?? fetch
  const base = options.baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)
  const route = (path: string) => new URL(`/api/qianshou/compute/${path}`, base).toString()
  const call = async (path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const response = await request(route(path), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      ...(signal === undefined ? {} : { signal }),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status < 200 || response.status >= 300) {
      let value: unknown
      try { value = await response.json() } catch { value = null }
      throw new Error(errorCode(value))
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('COMPUTE_RESPONSE_INVALID')
    return response.json()
  }
  return {
    async read(id, signal) {
      if (!PLAN_ID.test(id)) throw new Error('COMPUTE_PLAN_ID_INVALID')
      const listed = await call('plans', undefined, signal)
      if (!Array.isArray(listed) || listed.length > 2_000) throw new Error('COMPUTE_RESPONSE_INVALID')
      const found = listed.find(item => object(item).id === id)
      if (found === undefined) throw new Error('COMPUTE_PLAN_NOT_FOUND')
      return parseComputePlan(found)
    },
    async decide(id, decision) {
      if (!PLAN_ID.test(id)) throw new Error('COMPUTE_PLAN_ID_INVALID')
      const plan = parseComputePlan(await call('plans/confirm', { id, decision }))
      if (plan.id !== id || plan.authorization !== decision) throw new Error('COMPUTE_RESPONSE_INVALID')
      return plan
    },
    async quote(id) {
      if (!PLAN_ID.test(id)) throw new Error('COMPUTE_PLAN_ID_INVALID')
      return parseComputeQuote(await call('plans/quote', { id }))
    },
    async submit(id, quote) {
      if (!PLAN_ID.test(id) || !QUOTE_ID.test(quote.quoteId) || !MONEY.test(quote.recommendedBudget)) {
        throw new Error('COMPUTE_QUOTE_CONFIRMATION_INVALID')
      }
      const plan = parseComputePlan(await call('plans/confirm-quoted', {
        id, quoteId: quote.quoteId, amount: quote.recommendedBudget,
      }))
      if (plan.id !== id || plan.workloadId === null) throw new Error('COMPUTE_SUBMISSION_UNKNOWN')
      return plan
    },
  }
}
