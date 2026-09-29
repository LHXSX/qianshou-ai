-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · 脚本目录 (Script Catalog) Schema
--
-- 版本: v8.6.0 (2026-05-24 · 完善计划第二阶段)
-- 功能: 脚本元数据后台管理
--   - we_script_catalog: admin 可维护的脚本展示信息 (name/desc/category/status/tags/version)
--
-- 应用 (启动时 ensure_table() 已自动幂等执行 · 此 SQL 仅做备份和手动恢复):
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_006_script_catalog.sql
--
-- 设计要点:
--   1. 不影响节点拉脚本 (节点仍走 /api/v8/scripts/{name} · 直接读文件系统)
--   2. catalog 是元数据层 · 用于企业端 ScriptMarket.vue 展示 · admin 后台维护
--   3. 不存源代码 · 只存 code_url (指向 /api/v8/scripts/{name} 或外部 URL)
--   4. status: active / disabled / archived · disabled 在企业端不展示但仍可调用
--   5. source_kind: builtin (文件系统脚本) / uploaded (后台上传) / external (外部 URL)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_script_catalog (
    id              BIGSERIAL PRIMARY KEY,
    task_type       TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    category        TEXT        NOT NULL DEFAULT 'general',
    status          TEXT        NOT NULL DEFAULT 'active',
        -- active / disabled / archived
    source_kind     TEXT        NOT NULL DEFAULT 'builtin',
        -- builtin / uploaded / external
    code_url        TEXT        NOT NULL,
    version         TEXT        NOT NULL DEFAULT '1.0.0',
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    tags            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    pricing_ref     TEXT        DEFAULT NULL,
        -- 未来关联 we_task_pricing.task_type · 留 nullable 不强引用
    used_count      BIGINT      NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ DEFAULT NULL,
    created_by      BIGINT      REFERENCES we_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_script_catalog_status_idx
    ON we_script_catalog (status, category)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS we_script_catalog_category_idx
    ON we_script_catalog (category);
