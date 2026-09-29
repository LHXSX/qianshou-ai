/** First vertical workflow contract: an owner-local commerce image job. */
import { ComputeError } from './errors.ts'
import { planRoute, type RouterNodeOffer, type RouterPlan } from './router.ts'

/** Route-preview format that takes model requirements from a selected image recipe. */
export const COMMERCE_IMAGE_WORKFLOW_VERSION = 'qianshou.workflow.commerce-image.v2' as const

/** Inputs for a non-executing image route preview. */
export interface CommerceImageWorkflowInput {
  readonly workflowId: string
  readonly intentId: string
  readonly now: string
  readonly deadlineAt: string
  readonly budgetMinor: number
  readonly currency: 'CNY'
  readonly ownerAuthorization: 'approved' | 'pending' | 'denied'
  readonly privacy: 'private' | 'shared'
  /** Exact model IDs from the current reviewed image recipe; this preview does not verify the review. */
  readonly requiredModelIds: readonly string[]
  readonly offers: readonly RouterNodeOffer[]
}

/** One image-generation route, including the recipe's exact model requirements. */
export interface CommerceImageWorkflowStep {
  readonly stepId: 'generate'
  readonly capabilityId: 'image.generate'
  readonly requiredModelIds: readonly string[]
  readonly plan: RouterPlan
}

/** Candidate route and price with no permission to dispatch or spend. */
export interface CommerceImageWorkflowPlan {
  readonly version: typeof COMMERCE_IMAGE_WORKFLOW_VERSION
  readonly workflowId: string
  readonly intentId: string
  readonly status: 'ready' | 'no-route' | 'awaiting-authorization' | 'expired'
  readonly steps: readonly CommerceImageWorkflowStep[]
  readonly totalPriceMinor: number | null
  /** This is a route preview only; lease and model invocation remain separate. */
  readonly executionAuthorized: false
}

/** Preview an image recipe's model requirements without verifying review or authorizing execution.
 * @param input - Candidate offers and the caller-supplied recipe model IDs.
 * @returns A route preview that never authorizes execution.
 */
export function planCommerceImageWorkflow(input: CommerceImageWorkflowInput): CommerceImageWorkflowPlan {
  const currency: unknown = input.currency
  if (!id(input.workflowId) || !id(input.intentId) || currency !== 'CNY' || !Number.isSafeInteger(input.budgetMinor) || input.budgetMinor < 0) throw new ComputeError('COMPUTE_COMMERCE_WORKFLOW_INVALID')
  if (!validModelIds(input.requiredModelIds)) {
    throw new ComputeError('COMPUTE_COMMERCE_WORKFLOW_INVALID')
  }
  const requiredModelIds = Object.freeze([...input.requiredModelIds])
  const plan = planRoute({
    now: input.now,
    intent: {
      version: 'qianshou.intent.v1',
      intentId: input.intentId,
      capabilityId: 'image.generate',
      requiredModelIds,
      dataScope: 'task-inputs',
      privacy: input.privacy,
      ownerAuthorization: input.ownerAuthorization,
      budgetMinor: input.budgetMinor,
      currency: 'CNY',
      deadlineAt: input.deadlineAt,
      idempotencyKey: input.workflowId,
    },
    offers: input.offers,
  })
  const step: CommerceImageWorkflowStep = Object.freeze({ stepId: 'generate', capabilityId: 'image.generate', requiredModelIds, plan })
  return Object.freeze({
    version: COMMERCE_IMAGE_WORKFLOW_VERSION,
    workflowId: input.workflowId,
    intentId: input.intentId,
    status: plan.status,
    steps: Object.freeze([step]),
    totalPriceMinor: plan.selected?.priceMinor ?? null,
    executionAuthorized: false,
  })
}

function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) }

function validModelIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  const models: readonly unknown[] = value
  return models.length > 0 && models.length <= 16 && models.every(id)
    && new Set(models).size === models.length
}
