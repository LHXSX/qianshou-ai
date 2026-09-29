-- Buyer activation is a one-use remote execution challenge, not a proof of
-- physical disk installation. Shanghai holds control metadata only.
CREATE TABLE IF NOT EXISTS we_order_adapter_remote_challenges (
    nonce VARCHAR(36) PRIMARY KEY,
    entitlement_id VARCHAR(36) NOT NULL REFERENCES we_order_adapter_entitlements(id),
    product_id VARCHAR(36) NOT NULL REFERENCES we_order_adapter_products(id),
    publication_id VARCHAR(36) NOT NULL REFERENCES we_task_adapter_publications(id),
    buyer_id BIGINT NOT NULL REFERENCES we_accounts(id),
    worker_id UUID NOT NULL REFERENCES we_workers(id),
    archive_digest VARCHAR(71) NOT NULL CHECK (archive_digest ~ '^sha256:[0-9a-f]{64}$'),
    archive_version_id VARCHAR(200) NOT NULL,
    artifact_digest VARCHAR(71) NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    reviewed_seller_runtime_digest VARCHAR(71) NOT NULL
        CHECK (reviewed_seller_runtime_digest ~ '^sha256:[0-9a-f]{64}$'),
    challenge_input_sha256 VARCHAR(71)
        CHECK (challenge_input_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    signed_plan JSONB,
    status VARCHAR(16) NOT NULL DEFAULT 'pending_plan'
        CHECK (status IN ('pending_plan', 'issued', 'passed', 'expired')),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    receipt_sha256 VARCHAR(71),
    consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS we_order_adapter_remote_challenge_owner_idx
    ON we_order_adapter_remote_challenges (buyer_id, issued_at);
CREATE INDEX IF NOT EXISTS we_order_adapter_remote_challenge_entitlement_idx
    ON we_order_adapter_remote_challenges (entitlement_id, worker_id);
COMMENT ON TABLE we_order_adapter_remote_challenges IS
    'One-use attestor-planned randomized execution gate for purchased order adapters';
