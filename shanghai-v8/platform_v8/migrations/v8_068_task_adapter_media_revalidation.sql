-- Original, bounded control-plane evidence for independent Guangzhou
-- revalidation. Exact media and archive bytes stay in the locked OSS bucket.
CREATE TABLE IF NOT EXISTS we_task_adapter_media_revalidation (
    publication_id VARCHAR(36) PRIMARY KEY
        REFERENCES we_task_adapter_publications(id) ON DELETE CASCADE,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    media_receipt_sha256 VARCHAR(71) NOT NULL
        CHECK (media_receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'),
    original_media_receipt JSONB NOT NULL,
    material JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE we_task_adapter_media_revalidation IS
    'Original signed sample issuance and verification control metadata; no media bytes, ZIP bytes or URLs';
