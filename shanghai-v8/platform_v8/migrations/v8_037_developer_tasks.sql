BEGIN;

CREATE TABLE IF NOT EXISTS we_developer_idempotency (
    account_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    workload_id UUID REFERENCES we_workloads(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS we_developer_idempotency_workload_idx
    ON we_developer_idempotency(workload_id);

CREATE TABLE IF NOT EXISTS we_developer_webhooks (
    workload_id UUID PRIMARY KEY REFERENCES we_workloads(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    callback_url TEXT NOT NULL,
    callback_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_developer_webhooks_account_idx
    ON we_developer_webhooks(account_id);

CREATE TABLE IF NOT EXISTS we_developer_webhook_deliveries (
    id VARCHAR(36) PRIMARY KEY,
    workload_id UUID NOT NULL REFERENCES we_workloads(id) ON DELETE CASCADE,
    event VARCHAR(40) NOT NULL,
    attempt INTEGER NOT NULL,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    status_code INTEGER,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_developer_webhook_delivery_workload_idx
    ON we_developer_webhook_deliveries(workload_id, created_at);

COMMIT;
