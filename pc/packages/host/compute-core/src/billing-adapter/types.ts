/** Native CNY balance projection; positive ledger totals are not exclusively node earnings. */
export interface EdgeBalance {
  readonly accountId: number
  readonly balance: string
  readonly currency: 'CNY'
  readonly totalEarned: string
  readonly totalSpent: string
  readonly transactionCount: number
}

/** Caller-selected bounded ledger page; native transaction type strings remain native. */
export interface EdgeLedgerQuery {
  readonly limit: number
  readonly offset: number
  readonly type?: string
}

/** A real ledger entry; notes and unrelated fields are intentionally not exposed. */
export interface EdgeLedgerEntry {
  readonly id: string
  readonly type: string
  readonly amount: string
  readonly currency: 'CNY'
  readonly workloadId: string | null
  readonly shardId: string | null
  readonly createdAt: string | null
}

/** The server does not return a total count or an authoritative next-page token. */
export interface EdgeLedgerPage {
  readonly items: readonly EdgeLedgerEntry[]
  readonly limit: number
  readonly offset: number
}

/** Existing estimate input; budget is an optional comparison amount, not reservation authority. */
export interface EdgeEstimateRequest {
  readonly name?: string
  readonly spec: Readonly<Record<string, unknown>>
  readonly budget?: number
}

/** Server estimate and balance comparison, explicitly separate from executable budget authorization. */
export interface EdgeBudgetEstimate {
  readonly taskType: string
  readonly inputKind: string
  readonly units: number
  readonly shards: number
  readonly estimatedTotal: string
  readonly recommendedBudget: string
  readonly requestedBudget: string | null
  readonly workerRewardPool: string
  readonly platformFee: string
  readonly riskPool: string
  readonly scriptAuthorFee: string
  readonly currency: 'CNY'
  readonly balance: string
  readonly balanceEnough: boolean
  readonly billingMode: 'server_price'
  readonly authority: 'estimate-only'
}
