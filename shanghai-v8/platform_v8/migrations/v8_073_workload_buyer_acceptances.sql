-- Buyer decisions apply only to structurally verified inline results that
-- explicitly require acceptance. They never mark machine semantics verified.
CREATE TABLE IF NOT EXISTS we_workload_buyer_acceptances (
    workload_id UUID PRIMARY KEY REFERENCES we_workloads(id) ON DELETE CASCADE,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE RESTRICT,
    decision VARCHAR(12) NOT NULL CHECK (decision IN ('accept', 'reject')),
    idempotency_key VARCHAR(36) NOT NULL,
    content_sha256 VARCHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    contract_sha256 VARCHAR(71) NOT NULL CHECK (contract_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT we_workload_buyer_acceptances_owner_idempotency_uq
        UNIQUE (owner_id, idempotency_key)
);
COMMENT ON TABLE we_workload_buyer_acceptances IS
    'Owner-only immutable decision for a signed structural result; escrow remains held until accepted or refunded';
