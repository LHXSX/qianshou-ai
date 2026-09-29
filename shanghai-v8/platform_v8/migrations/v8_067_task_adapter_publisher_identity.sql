-- Account-bound author identity is control metadata only.  This migration does
-- not approve packages or move source/media bytes through Shanghai.
CREATE TABLE IF NOT EXISTS we_task_adapter_publisher_challenges (
    owner_id BIGINT PRIMARY KEY REFERENCES we_accounts(id) ON DELETE CASCADE,
    challenge_id VARCHAR(36) NOT NULL UNIQUE,
    nonce VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS we_task_adapter_publisher_keys (
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    key_id VARCHAR(64) NOT NULL,
    public_key VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, key_id)
);
CREATE INDEX IF NOT EXISTS we_task_adapter_publisher_keys_owner_active_idx
    ON we_task_adapter_publisher_keys (owner_id, revoked_at);

CREATE TABLE IF NOT EXISTS we_task_adapter_author_manifests (
    publication_id VARCHAR(36) PRIMARY KEY REFERENCES we_task_adapter_publications(id) ON DELETE CASCADE,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    key_id VARCHAR(64) NOT NULL,
    artifact_digest VARCHAR(71) NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    package_digest VARCHAR(71) NOT NULL CHECK (package_digest ~ '^sha256:[0-9a-f]{64}$'),
    manifest JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE we_task_adapter_publisher_keys IS
    'JWT owner enrolled Ed25519 public keys; revocation invalidates future review and distribution';
COMMENT ON TABLE we_task_adapter_author_manifests IS
    'Immutable author signature over six source files and local runtime claim, not independent review evidence';
