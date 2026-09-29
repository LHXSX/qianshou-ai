-- v8_050 · RT-B 商店插件 / 运行时字段
-- we_apps: runtime_api · capabilities · package_kind · plugin_* URLs
-- 详情 GET /marketplace/apps/{slug} 须回传上述字段

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS runtime_api TEXT;

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS package_kind TEXT NOT NULL DEFAULT 'app';

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS plugin_package_url TEXT;

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS plugin_manifest_url TEXT;

ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS plugin_signature_url TEXT;

-- display_meta 若历史环境缺失则补列（v8_041 已有；幂等）
ALTER TABLE we_apps
    ADD COLUMN IF NOT EXISTS display_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN we_apps.runtime_api IS 'RT-B · 运行时契约版本，如 1.0.0';
COMMENT ON COLUMN we_apps.capabilities IS 'RT-B · 应用所需能力 string[] 或 {name,version}[]';
COMMENT ON COLUMN we_apps.package_kind IS 'RT-B · app|plugin|bundle 等包类型';
COMMENT ON COLUMN we_apps.plugin_package_url IS 'RT-B · 插件包下载 URL';
COMMENT ON COLUMN we_apps.plugin_manifest_url IS 'RT-B · 插件 manifest URL';
COMMENT ON COLUMN we_apps.plugin_signature_url IS 'RT-B · 插件签名 URL';
