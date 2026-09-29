ALTER TABLE we_accounts
    ADD COLUMN IF NOT EXISTS totp_last_counter BIGINT;

ALTER TABLE we_auth_sessions
    ADD COLUMN IF NOT EXISTS refresh_jti_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS we_auth_sessions_refresh_expiry_idx
    ON we_auth_sessions (account_id, refresh_expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS we_auth_login_challenges (
    id                      VARCHAR(36) PRIMARY KEY,
    token_hash              VARCHAR(64) NOT NULL UNIQUE,
    account_id              BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    device_id               VARCHAR(36) REFERENCES we_auth_devices(id) ON DELETE SET NULL,
    pending_credential_hash VARCHAR(64),
    device_metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    remember_me             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL,
    consumed_at             TIMESTAMPTZ,
    CONSTRAINT we_auth_login_challenges_device_binding_ck CHECK (
        NOT (device_id IS NOT NULL AND pending_credential_hash IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS we_auth_login_challenges_expiry_idx
    ON we_auth_login_challenges (expires_at);

CREATE INDEX IF NOT EXISTS we_auth_login_challenges_account_idx
    ON we_auth_login_challenges (account_id, created_at DESC);
