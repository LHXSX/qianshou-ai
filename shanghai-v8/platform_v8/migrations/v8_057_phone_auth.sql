-- Reproducible schema for the SMS phone authentication already used by auth.py.
-- Safe to apply to a database where these objects were provisioned manually.
BEGIN;

ALTER TABLE we_accounts ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE we_accounts ADD COLUMN IF NOT EXISTS phone_country VARCHAR(2);
ALTER TABLE we_accounts ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMP WITH TIME ZONE;

-- A phone number may authenticate exactly one owner account.
CREATE UNIQUE INDEX IF NOT EXISTS we_accounts_phone_uniq
    ON we_accounts(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS we_sms_verifications (
    id VARCHAR(36) PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    purpose VARCHAR(16) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    sent_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    consumed_at TIMESTAMP,
    request_ip VARCHAR(45),
    provider_msg_id VARCHAR(64),
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    CONSTRAINT we_sms_verifications_purpose_chk CHECK (purpose IN ('register','login','bind','reset')),
    CONSTRAINT we_sms_verifications_attempts_chk CHECK (attempts >= 0 AND max_attempts > 0)
);
CREATE INDEX IF NOT EXISTS we_sms_verifications_phone_purpose_sent_idx
    ON we_sms_verifications(phone, purpose, sent_at DESC);
CREATE INDEX IF NOT EXISTS we_sms_verifications_phone_idx
    ON we_sms_verifications(phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS we_sms_verifications_sent_at_idx
    ON we_sms_verifications(sent_at DESC);

COMMIT;
