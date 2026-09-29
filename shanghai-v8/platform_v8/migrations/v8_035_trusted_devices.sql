CREATE TABLE IF NOT EXISTS we_auth_devices (
    id                      VARCHAR(36) PRIMARY KEY,
    credential_hash         VARCHAR(64) NOT NULL UNIQUE,
    account_id              BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trusted_at              TIMESTAMPTZ,
    trusted_until           TIMESTAMPTZ,
    trust_permanent         BOOLEAN NOT NULL DEFAULT FALSE,
    trust_revoked_at        TIMESTAMPTZ,
    last_trusted_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS we_auth_devices_account_last_seen_idx
    ON we_auth_devices (account_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS we_auth_devices_account_trust_idx
    ON we_auth_devices (account_id, trust_revoked_at, trusted_until);

ALTER TABLE we_auth_sessions
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(36)
    REFERENCES we_auth_devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS we_auth_sessions_device_idx
    ON we_auth_sessions (device_id);
