CREATE TABLE IF NOT EXISTS we_auth_sessions (
    id              VARCHAR(36) PRIMARY KEY,
    account_id      BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    device_name     VARCHAR(120) NOT NULL DEFAULT '',
    device_type     VARCHAR(32) NOT NULL DEFAULT 'unknown',
    browser         VARCHAR(64) NOT NULL DEFAULT '',
    os              VARCHAR(64) NOT NULL DEFAULT '',
    user_agent      TEXT NOT NULL DEFAULT '',
    client_ip       VARCHAR(45),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS we_auth_sessions_account_last_seen_idx
    ON we_auth_sessions (account_id, last_seen_at DESC);
