-- Metadata only. Apply only after the native H3 candidate and independent issuer are reviewed.
CREATE TABLE IF NOT EXISTS we_native_h3_device_proofs (
    publication_id VARCHAR(36) NOT NULL REFERENCES we_task_adapter_publications(id),
    device_id UUID NOT NULL REFERENCES we_workers(id),
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id),
    connection_id VARCHAR(36) NOT NULL,
    proof JSONB NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (publication_id, device_id)
);
CREATE INDEX IF NOT EXISTS we_native_h3_device_proofs_owner_device_idx
    ON we_native_h3_device_proofs(owner_id, device_id);
CREATE TABLE IF NOT EXISTS we_native_h3_key_challenges (
    id VARCHAR(36) PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id),
    device_id UUID NOT NULL REFERENCES we_workers(id),
    payload JSONB NOT NULL,
    connection_id VARCHAR(36), signature VARCHAR(86), expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS we_native_h3_key_challenges_owner_device_idx ON we_native_h3_key_challenges(owner_id, device_id);
CREATE TABLE IF NOT EXISTS we_native_h3_device_keys (
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id), device_id UUID NOT NULL REFERENCES we_workers(id),
    key_id VARCHAR(64) NOT NULL, public_key VARCHAR(43) NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
    PRIMARY KEY(owner_id, device_id, key_id)
);
CREATE TABLE IF NOT EXISTS we_native_h3_review_samples (
    nonce VARCHAR(43) PRIMARY KEY, publication_id VARCHAR(36) NOT NULL REFERENCES we_task_adapter_publications(id),
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id), device_id UUID NOT NULL REFERENCES we_workers(id),
    device_key_id VARCHAR(64) NOT NULL, workload_id UUID NOT NULL REFERENCES we_workloads(id),
    shard_id UUID NOT NULL REFERENCES we_shards(id), plan JSONB NOT NULL, expires_at INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL, issuance JSONB, execution JSONB, decoded_report JSONB,
    sample_receipt JSONB, sample_verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS we_native_h3_review_samples_owner_device_idx ON we_native_h3_review_samples(owner_id, device_id);
CREATE TABLE IF NOT EXISTS we_native_h3_presence (
    nonce VARCHAR(43) PRIMARY KEY, publication_id VARCHAR(36) NOT NULL REFERENCES we_task_adapter_publications(id),
    owner_id BIGINT NOT NULL REFERENCES we_accounts(id), device_id UUID NOT NULL REFERENCES we_workers(id),
    plan JSONB NOT NULL, expires_at INTEGER NOT NULL, signature VARCHAR(86), observed_at INTEGER, proof JSONB
);
CREATE INDEX IF NOT EXISTS we_native_h3_presence_owner_device_idx ON we_native_h3_presence(owner_id, device_id);
