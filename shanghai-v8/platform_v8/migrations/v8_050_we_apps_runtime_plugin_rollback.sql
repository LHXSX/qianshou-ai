-- rollback v8_050（仅删本迁移新增的运行时字段；display_meta 属 v8_041 保留）
ALTER TABLE we_apps DROP COLUMN IF EXISTS runtime_api;
ALTER TABLE we_apps DROP COLUMN IF EXISTS capabilities;
ALTER TABLE we_apps DROP COLUMN IF EXISTS package_kind;
ALTER TABLE we_apps DROP COLUMN IF EXISTS plugin_package_url;
ALTER TABLE we_apps DROP COLUMN IF EXISTS plugin_manifest_url;
ALTER TABLE we_apps DROP COLUMN IF EXISTS plugin_signature_url;
