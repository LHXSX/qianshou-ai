# Shanghai payment management

English | [中文](README.zh.md)

The Guangzhou console projects Shanghai's existing money ledger through the signed-in administrator's account session. It does not modify Guangzhou SP balances. `OrderView.vue` replaces the old order placeholder with global payment orders, detail, manual credit and the pending withdrawal queue. Shanghai remains the authority for balances, state transitions and platform-admin authorization.

## Entry and permissions

The existing `/order` view and server-generated menu use `payment.read`. Writes require the separate `payment.manage` permission, and all payment routes require data scope `all`. Credential permissions confer no payment access. The built-in super administrator inherits the new permission catalogue; existing finance, operations and support roles are not automatically expanded. Custom role grants use the existing administrator workflow.

The proxy reads `session.tokens.access` from server memory and sends it only to the configured account origin and `/api/v8` prefix. It accepts neither caller-supplied upstream URLs nor bearer tokens. Requests carry no browser cookies, follow no redirects and perform no automatic retries. Both Guangzhou RBAC and Shanghai's administrator check must pass.

## HTTP contract

Every console endpoint below is `POST` with JSON under `/api/qianshou/ai/admin/payment`. Reads preserve Shanghai decimal amount strings and currency. No browser calls the Shanghai payment API directly.

| Console suffix | Body | Shanghai request |
| --- | --- | --- |
| `/orders` | `limit`, `offset`, optional `account_id`, `status`, `gateway` | `GET /admin/payment/orders` with pagination and filters |
| `/order` | `order_no` | `GET /admin/payment/orders/{order_no}` |
| `/withdrawals` | empty object | `GET /admin/payment/withdraw/pending?limit=200` |
| `/preflight` | action draft | authoritative read, then existing confirmation token |
| `/apply` | same draft, `before`, `token`, `reason` | one Shanghai write after confirmation and audit |

Drafts support `confirm` with `order_no` and `gateway_tx_id`; `recharge` with numeric `account_id` and decimal-string `amount`; `approve` or `reject` with `request_no`; and `mark_paid` with `request_no` and `paid_tx_id`. Reasons require at least four characters. Approval and rejection forward the reason as Shanghai's `note`.

Manual confirmation is limited to pending `admin_manual` and `bank_transfer` orders. Automated payment channels are reconciled by their own callback flow. Withdrawal approval requires `pending`; paid registration requires `approved`; rejection accepts the states allowed by the pending queue and Shanghai's service. Paid registration records a transfer already performed; this console does not send money through a bank.

The queue contains at most 200 `pending` and `approved` records. It is not complete withdrawal history. Recipient fields are allowlisted from Shanghai's `payee_info`: account number masking is performed upstream, while holder and bank names may remain present. The separate `payee_info_full` object is excluded. Manual recharge has no exact-account balance read endpoint in the current Shanghai contract, so its preview explicitly records `balance: null`; the resulting balance comes from the successful Shanghai response.

Paid registration is currently gated with `503 payment_withdrawal_gate` in both confirmation stages. Shanghai withdrawal locking and its independent review must be completed before this gate is removed. Querying and approval remain available; this local projection does not establish a safe external payout workflow.

## Confirmation and uncertain outcomes

The existing one-use token binds actor, draft and authoritative before-state. Apply reads the target again and refuses a changed state. The frontend freezes the draft across both steps and consumes its local preview before submitting, preventing repeated clicks from issuing another write. A new independent confirmation is an explicit operator action.

Before a Shanghai write, an intent audit must persist. An unavailable audit store prevents submission. The response audit records the projected before-state, result, actor and operator reason. Account credentials and the excluded full recipient object never enter this audit; allowed business recipient fields may appear in its before-state. If Shanghai succeeds but the local result audit fails, the response explicitly says Shanghai succeeded and asks for reconciliation instead of reporting ordinary failure.

Shanghai's existing manual-recharge endpoint creates a new ledger entry for each request and has no caller idempotency key. Network errors, timeouts, 5xx responses or malformed write receipts therefore produce `payment_outcome_unknown`. Operators must check Shanghai's ledger before another confirmation. The proxy never retries. Read failures remain explicit errors; they do not become an empty order list. Authorization rejection, missing deployment or target, changed state and unavailable service have distinct error codes.

## Verification and delivery limits

Scope tests exercise the real admin HTTP pipeline with local Shanghai-contract fixtures and the real Vue order view. They cover permission and scope separation, global pagination, server-side bearer selection, masked recipients, immutable confirmation payloads, concurrent clicks, changed state, decimal amounts, failed auditing and uncertain outcomes. Backend TypeScript and frontend Vue TypeScript checks are required alongside both test suites.

The new global order and administrative detail routes are coordinated with Shanghai's local T1/T2 candidate. The previous production contract only listed the caller's orders and must never be used as a substitute. Until that candidate is deployed and authenticated integration is accepted, global reads may explicitly report an unavailable interface. No production database, credentials or payment was changed by this local development.

WeChat and Alipay live callbacks and merchant credentials require Shanghai delivery and real acceptance evidence. Refunds, ledger deletion, fee policy, SP synchronization and payout policy are outside this implementation. The module readiness keeps those dependencies visible instead of declaring the entire order ecosystem complete.

## Rollback

The work package records the pre-edit file hashes and backups in the task's `work/payments/guangzhou` directory. Restore only this package's recorded changes after reviewing the manifest; the checkout already contained unrelated work. No branch switch, reset, dependency installation or production migration is part of rollback. Financial records created later in production must be reconciled by their ledger owner, never deleted as a code rollback.
