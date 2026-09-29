-- v8_031_api_keys.sql · 2026-06-07 · S3-T8
--
-- 企业 API Key · 真实签发 + 鉴权
-- 替换 enterprise_stub.py 的 api-keys stub
--
-- 设计:
--   - key 明文只在创建时返回一次,DB 只存 sha256
--   - 前缀 qsk_ (qianshou key) + 32 hex
--   - 关联 account · 可设 scopes(预留) · 可吊销

BEGIN;

CREATE TABLE IF NOT EXISTS we_api_keys (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT      NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL DEFAULT '',
  key_prefix    VARCHAR(16) NOT NULL,              -- 展示用前缀 qsk_xxxx (脱敏)
  key_sha256    VARCHAR(64) NOT NULL UNIQUE,        -- 鉴权时比对
  scopes        JSONB       NOT NULL DEFAULT '[]',  -- 预留: ["workloads:submit","economy:read"]
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,                        -- NULL = 永不过期
  revoked       BOOLEAN     NOT NULL DEFAULT false,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_api_keys_account_idx ON we_api_keys(account_id) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS we_api_keys_sha_idx ON we_api_keys(key_sha256) WHERE revoked = false;

COMMENT ON TABLE we_api_keys IS 'S3-T8 · 企业 API Key (替换 enterprise_stub.api-keys) · DB 只存 sha256';

COMMIT;
