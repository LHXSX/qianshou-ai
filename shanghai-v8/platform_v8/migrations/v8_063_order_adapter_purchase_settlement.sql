-- Additive settlement contract. Existing v8_062 `granted` rows have already
-- paid author/platform and require manual reconciliation; never relabel them.
ALTER TABLE we_order_adapter_entitlements
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_reason VARCHAR(128);
ALTER TABLE we_order_adapter_entitlements
    ALTER COLUMN status SET DEFAULT 'pending_install';
ALTER TABLE we_order_adapter_entitlements
    DROP CONSTRAINT IF EXISTS we_order_adapter_entitlements_status_check;
ALTER TABLE we_order_adapter_entitlements
    ADD CONSTRAINT we_order_adapter_entitlements_status_check
    CHECK (status IN ('granted','pending_install','installed','refunded'));
CREATE INDEX IF NOT EXISTS we_order_adapter_entitlements_expiring_idx
    ON we_order_adapter_entitlements (status,expires_at)
    WHERE status = 'pending_install';

CREATE TABLE IF NOT EXISTS we_order_adapter_device_installs (
    id VARCHAR(36) PRIMARY KEY,
    entitlement_id VARCHAR(36) NOT NULL REFERENCES we_order_adapter_entitlements(id),
    device_id VARCHAR(128) NOT NULL,
    runtime_digest VARCHAR(71) NOT NULL,
    receipt_key_id VARCHAR(64) NOT NULL,
    signed_receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT we_order_adapter_device_install_uq UNIQUE (entitlement_id,device_id)
);
COMMENT ON TABLE we_order_adapter_device_installs IS
    'Independent signed device installation; account purchase alone never proves activation';
