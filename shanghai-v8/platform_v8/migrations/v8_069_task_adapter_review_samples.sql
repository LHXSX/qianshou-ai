-- Dedicated audit samples: real workload/shard leases but never paid orders.
-- The control plane stores only identifiers and signed result metadata.
CREATE TABLE IF NOT EXISTS we_task_adapter_review_samples (
    publication_id VARCHAR(36) NOT NULL
        REFERENCES we_task_adapter_publications(id) ON DELETE CASCADE,
    format VARCHAR(3) NOT NULL CHECK (format IN ('gif', 'mp4')),
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    workload_id UUID NOT NULL UNIQUE REFERENCES we_workloads(id) ON DELETE CASCADE,
    shard_id UUID NOT NULL UNIQUE REFERENCES we_shards(id) ON DELETE CASCADE,
    worker_id UUID REFERENCES we_workers(id) ON DELETE SET NULL,
    recipe_sha256 VARCHAR(64) NOT NULL CHECK (recipe_sha256 ~ '^[0-9a-f]{64}$'),
    status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'upload_issued', 'verified')),
    lease_expires_at TIMESTAMPTZ,
    result_id VARCHAR(36),
    sha256 VARCHAR(64),
    content_md5 VARCHAR(24),
    size_bytes BIGINT,
    object_key TEXT,
    object_version_id VARCHAR(200),
    issuance_receipt JSONB,
    verify_request JSONB,
    verify_receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (publication_id, format)
);

COMMENT ON TABLE we_task_adapter_review_samples IS
    'Zero-budget quarantined review sample jobs; never production dispatch or settlement';
