-- v8_065 · 保存作者提交的插件配置/版本报价快照（仅审核材料，不是验签回执）
-- v8_060 曾用于本地未发布候选；移到 065 避开已上线的 059 支付迁移分叉。
-- v8_050 的 we_apps 插件列在早期库可能未执行，幂等补齐以匹配 ORM。
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS runtime_api TEXT;
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS package_kind VARCHAR(20) NOT NULL DEFAULT 'app';
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS plugin_package_url TEXT;
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS plugin_manifest_url TEXT;
ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS plugin_signature_url TEXT;

ALTER TABLE we_app_versions ADD COLUMN IF NOT EXISTS manifest JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE we_app_versions ADD COLUMN IF NOT EXISTS config_schema JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE we_app_versions ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE we_app_versions ADD COLUMN IF NOT EXISTS version_summary TEXT;

COMMENT ON COLUMN we_app_versions.manifest IS '作者提交的版本 manifest；不能充当已验包凭据';
COMMENT ON COLUMN we_app_versions.config_schema IS '作者提交的配置字段说明，不得包含用户密钥值';
COMMENT ON COLUMN we_app_versions.pricing_snapshot IS '提交时报价草案；未完成真实购买结算验收前不得上架付费应用';
COMMENT ON COLUMN we_app_versions.version_summary IS '版本功能摘要';
