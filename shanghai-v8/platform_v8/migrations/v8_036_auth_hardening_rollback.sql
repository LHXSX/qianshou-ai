DROP TABLE IF EXISTS we_auth_login_challenges;

DROP INDEX IF EXISTS we_auth_sessions_refresh_expiry_idx;

ALTER TABLE we_auth_sessions
    DROP COLUMN IF EXISTS remember_me,
    DROP COLUMN IF EXISTS refresh_expires_at,
    DROP COLUMN IF EXISTS refresh_jti_hash;

ALTER TABLE we_accounts
    DROP COLUMN IF EXISTS totp_last_counter;
