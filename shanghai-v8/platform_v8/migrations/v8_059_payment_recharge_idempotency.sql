-- Optional client checkout key for WeChat/Alipay recharge requests.
-- Apply before deploying code that writes these columns. Existing clients and
-- historical rows remain valid because both new columns are nullable.
BEGIN;

ALTER TABLE we_payment_orders
    ADD COLUMN IF NOT EXISTS client_idempotency_key VARCHAR(128);
ALTER TABLE we_payment_orders
    ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64);

-- NULL keys retain the old behavior; a supplied key is unique within an
-- account. The service additionally takes a transaction advisory lock before
-- looking up/inserting the key, so simultaneous replays return the first row.
CREATE UNIQUE INDEX IF NOT EXISTS we_payment_orders_account_client_key_uq
    ON we_payment_orders (account_id, client_idempotency_key)
    WHERE client_idempotency_key IS NOT NULL;

COMMENT ON COLUMN we_payment_orders.client_idempotency_key IS
    'Client checkout intent identifier, unique per account; optional for legacy callers';
COMMENT ON COLUMN we_payment_orders.request_fingerprint IS
    'SHA-256 of canonical amount, gateway and remark for replay conflict detection';

COMMIT;
