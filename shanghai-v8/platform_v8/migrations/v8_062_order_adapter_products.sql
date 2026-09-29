-- A task-adapter publication is not a product. This sale queue and account
-- entitlement remain separate from we_apps / we_installs and device receipts.
CREATE TABLE IF NOT EXISTS we_order_adapter_products (
    id VARCHAR(36) PRIMARY KEY,
    publication_id VARCHAR(36) NOT NULL UNIQUE REFERENCES we_task_adapter_publications(id),
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id),
    sale_price_yuan NUMERIC(12,2) NOT NULL CHECK (sale_price_yuan >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    status VARCHAR(16) NOT NULL DEFAULT 'review'
        CHECK (status IN ('review','published','rejected','suspended')),
    distribution_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_note TEXT NOT NULL DEFAULT '',
    reviewer_id BIGINT REFERENCES we_accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS we_order_adapter_products_status_created_idx
    ON we_order_adapter_products (status,created_at DESC);

CREATE TABLE IF NOT EXISTS we_order_adapter_entitlements (
    id VARCHAR(36) PRIMARY KEY,
    product_id VARCHAR(36) NOT NULL REFERENCES we_order_adapter_products(id),
    buyer_id BIGINT NOT NULL REFERENCES we_accounts(id),
    price_yuan NUMERIC(12,2) NOT NULL CHECK (price_yuan >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    ledger_key VARCHAR(128) UNIQUE,
    request_key VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'granted' CHECK (status = 'granted'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT we_order_adapter_entitlement_buyer_uq UNIQUE (product_id,buyer_id),
    CONSTRAINT we_order_adapter_entitlement_request_uq UNIQUE (buyer_id,request_key)
);
COMMENT ON TABLE we_order_adapter_entitlements IS
    'Account purchase only; a device must separately verify and report installation';
