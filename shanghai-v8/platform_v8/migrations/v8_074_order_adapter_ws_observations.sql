-- An authenticated worker WebSocket may report one short-lived randomized
-- challenge result. This is server-observed control metadata, not a disk proof.
CREATE TABLE IF NOT EXISTS we_order_adapter_ws_observations (
    nonce VARCHAR(36) PRIMARY KEY REFERENCES we_order_adapter_remote_challenges(nonce),
    worker_id UUID NOT NULL REFERENCES we_workers(id),
    buyer_id BIGINT NOT NULL REFERENCES we_accounts(id),
    connection_id VARCHAR(36) NOT NULL,
    input_digest VARCHAR(71) NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
    output_digest VARCHAR(71) NOT NULL CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'),
    runtime_digest VARCHAR(71) NOT NULL CHECK (runtime_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_digest VARCHAR(71) NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS we_order_adapter_ws_observations_expiry_idx
    ON we_order_adapter_ws_observations (expires_at);
COMMENT ON TABLE we_order_adapter_ws_observations IS
    'One-use output hash observed on an authenticated online worker WebSocket';
