-- Additive only. Historical balances, SP entitlements and legacy orders are unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS we_subscription_quotes (
 quote_id varchar(96) PRIMARY KEY,
 account_id bigint NOT NULL REFERENCES we_accounts(id),
 payload json NOT NULL,
 ticket text NOT NULL,
 expires_at bigint NOT NULL,
 created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS we_subscription_orders (
 order_id varchar(96) PRIMARY KEY,
 account_id bigint NOT NULL REFERENCES we_accounts(id),
 quote_id varchar(96) NOT NULL UNIQUE REFERENCES we_subscription_quotes(quote_id),
 idempotency_key varchar(96) NOT NULL,
 request_hash varchar(64) NOT NULL,
 amount_fen bigint NOT NULL,
 currency varchar(3) NOT NULL,
 tier varchar(16) NOT NULL,
 months integer NOT NULL,
 ledger_id uuid NOT NULL REFERENCES we_ledger(id),
 paid_at bigint NOT NULL,
 status varchar(24) NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 last_error varchar(64),
 subscription json,
 updated_at bigint NOT NULL,
 CONSTRAINT we_subscription_orders_account_key_uniq UNIQUE(account_id,idempotency_key),
 CONSTRAINT we_subscription_orders_value_chk CHECK(amount_fen>0 AND currency='CNY' AND months BETWEEN 1 AND 12),
 CONSTRAINT we_subscription_orders_status_chk CHECK(status IN ('fulfilling','fulfilled','requires-review'))
);
CREATE INDEX IF NOT EXISTS we_subscription_orders_pending_idx ON we_subscription_orders(status,updated_at);
COMMIT;
-- Rollback: disable the new public routes and carrier; retain these tables and
-- SUBSCRIPTION_PURCHASE ledger rows. Never refund, drop outbox, or restore old balances automatically.
