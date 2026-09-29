-- TOTP 身份验证器：密钥仅以 Fernet 密文保存
ALTER TABLE we_accounts
    ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
