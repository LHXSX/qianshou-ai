-- Author-side upload intent only. Independent Guangzhou package evidence is
-- stored in we_task_adapter_publications.review_evidence after verification.
CREATE TABLE IF NOT EXISTS we_task_adapter_package_uploads (
    publication_id VARCHAR(36) PRIMARY KEY
        REFERENCES we_task_adapter_publications(id) ON DELETE CASCADE,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    archive_digest VARCHAR(71) NOT NULL
        CHECK (archive_digest ~ '^sha256:[0-9a-f]{64}$'),
    content_md5 VARCHAR(24) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
    bucket VARCHAR(200) NOT NULL,
    object_key TEXT NOT NULL,
    intent_nonce VARCHAR(36) NOT NULL,
    intent_expires_at TIMESTAMPTZ NOT NULL,
    version_id VARCHAR(200),
    lock_retain_until TIMESTAMPTZ,
    status VARCHAR(16) NOT NULL DEFAULT 'prepared'
        CHECK (status IN ('prepared', 'confirmed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE we_task_adapter_package_uploads IS
    'Client upload intent and storage HEAD confirmation; never substitute for independently signed package evidence';
