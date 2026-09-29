-- v8_046 · 生产迁移账本 + 应用月订阅到期字段
-- 1) we_schema_migrations：供 /api/v8/ops/ready 校验 auth 关键迁移 checksum
-- 2) we_installs.subscription_expires_at：monthly 定价续费窗口

CREATE TABLE IF NOT EXISTS we_schema_migrations (
    version           TEXT PRIMARY KEY,
    checksum_sha256   VARCHAR(64) NOT NULL,
    applied_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 以下 checksum 与仓库 platform_v8/migrations 内对应文件 sha256 对齐（2026-08-10）
INSERT INTO we_schema_migrations (version, checksum_sha256) VALUES
    ('v8_033_totp_authenticator.sql', '5752556da1c7ea3066e8baffaa0c9b15d850b41046c8518f24b693b81a7845cc'),
    ('v8_034_auth_sessions.sql', '9b7903ee29d15e777607f5e388282426d0df6c8170ba13160e4e3616cffc8a6e'),
    ('v8_035_trusted_devices.sql', 'be961ce4e4737ad2b6253d46c38894e485ad300b87affa0da7dd5d24f5129896'),
    ('v8_036_auth_hardening.sql', '645e1520e2d9f14999101a4dcbfe760e704f3f49ed1fea640f32ff1162bb5b94')
ON CONFLICT (version) DO UPDATE
    SET checksum_sha256 = EXCLUDED.checksum_sha256;

ALTER TABLE we_installs
    ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN we_installs.subscription_expires_at IS
    'v8_046 · monthly 订阅到期（UTC）；NULL 表示非月订或终身装';
