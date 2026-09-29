-- 新建 API Key 默认业务 scopes；存量 [] 继续由应用层解释为 wildcard。
BEGIN;

ALTER TABLE we_api_keys
    ALTER COLUMN scopes
    SET DEFAULT '["files","workloads","results","webhooks"]'::jsonb;

COMMENT ON COLUMN we_api_keys.scopes IS
    'API Key scopes；存量空数组兼容 wildcard，新建默认 files/workloads/results/webhooks';

COMMIT;
