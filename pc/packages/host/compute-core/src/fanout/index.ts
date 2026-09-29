import { ComputeError } from '../errors.ts'

/** A deterministic unit of a fan-out plan. Executors are deliberately outside this module. */
export interface ComputeFanOutPiece {
  readonly pieceId: string
  readonly index: number
}

export interface ComputeFanOutPlan {
  readonly parentTaskId: string
  readonly arity: number
  readonly pieces: readonly ComputeFanOutPiece[]
}

export interface ComputePieceResult<T = unknown> {
  readonly parentTaskId: string
  readonly pieceId: string
  readonly index: number
  readonly output: T
}

/** Create only the identity/shape of a fan-out; no scheduling or execution occurs. */
export function createComputeFanOutPlan(parentTaskId: string, arity: number): ComputeFanOutPlan {
  if (!parentTaskId || !Number.isSafeInteger(arity) || arity < 1) {
    throw new ComputeError('COMPUTE_FANOUT_PLAN_INVALID', 400)
  }
  const pieces = Array.from({ length: arity }, (_, index) => ({
    index,
    pieceId: `${parentTaskId}:${index}`,
  }))
  return { parentTaskId, arity, pieces }
}

/** In-memory join primitive. It is intentionally not an executor, queue, or settlement store. */
export class ComputeJoinStore<T = unknown> {
  private readonly results = new Map<string, ComputePieceResult<T>>()

  constructor(readonly plan: ComputeFanOutPlan) {
    if (plan.pieces.length !== plan.arity || new Set(plan.pieces.map(piece => piece.pieceId)).size !== plan.arity) {
      throw new ComputeError('COMPUTE_FANOUT_PLAN_INVALID', 400)
    }
  }

  add(result: ComputePieceResult<T>): readonly ComputePieceResult<T>[] | undefined {
    const piece = this.plan.pieces[result.index]
    if (result.parentTaskId !== this.plan.parentTaskId || !piece || result.pieceId !== piece.pieceId) {
      throw new ComputeError('COMPUTE_FANOUT_PIECE_INVALID', 400)
    }
    if (this.results.has(result.pieceId)) throw new ComputeError('COMPUTE_FANOUT_DUPLICATE', 409)
    if (this.results.size >= this.plan.arity) throw new ComputeError('COMPUTE_FANOUT_OVER_ARITY', 409)
    this.results.set(result.pieceId, result)
    return this.results.size === this.plan.arity ? this.join() : undefined
  }

  join(): readonly ComputePieceResult<T>[] {
    if (this.results.size !== this.plan.arity) throw new ComputeError('COMPUTE_FANOUT_MISSING', 409)
    return this.plan.pieces.map(piece => this.results.get(piece.pieceId)!)
  }

  get size(): number { return this.results.size }
}

export const ComputeFanOutJoinStore = ComputeJoinStore
/** Short name for consumers that already operate within compute-core. */
export const JoinStore = ComputeJoinStore
