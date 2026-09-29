-- 接单适配器发布审核，与 we_apps 商品审核完全分离。
-- 作者字段只是投稿声明；review_evidence 须由服务端验签后写入。
CREATE TABLE IF NOT EXISTS we_task_adapter_publications (
    id VARCHAR(36) PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    task_type VARCHAR(100) NOT NULL,
    capability_id VARCHAR(100) NOT NULL,
    input_kinds JSONB NOT NULL,
    output_kind VARCHAR(32) NOT NULL,
    contract_version VARCHAR(16) NOT NULL,
    artifact_digest VARCHAR(71) NOT NULL,
    package_digest VARCHAR(71) NOT NULL,
    version VARCHAR(40) NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(32) NOT NULL,
    description TEXT NOT NULL,
    configuration TEXT NOT NULL DEFAULT '',
    currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    price_yuan NUMERIC(12, 2) NOT NULL CHECK (price_yuan >= 0),
    status VARCHAR(16) NOT NULL DEFAULT 'review'
        CHECK (status IN ('review', 'approved', 'rejected')),
    submission_fingerprint VARCHAR(64) NOT NULL,
    review_fingerprint VARCHAR(64),
    review_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    review_note TEXT NOT NULL DEFAULT '',
    reviewer_id BIGINT REFERENCES we_accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    CONSTRAINT we_task_adapter_publication_owner_digest_uq
        UNIQUE (owner_id, task_type, artifact_digest)
);

CREATE INDEX IF NOT EXISTS we_task_adapter_publications_status_created_idx
    ON we_task_adapter_publications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS we_task_adapter_publications_task_status_idx
    ON we_task_adapter_publications (task_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS we_task_adapter_publications_one_approved_task_uq
    ON we_task_adapter_publications (task_type) WHERE status = 'approved';

COMMENT ON TABLE we_task_adapter_publications IS
    'Owner intake and signed independent review receipts for task adapters; approved alone never opens billing or dispatch';
