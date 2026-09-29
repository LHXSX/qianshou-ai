-- v8_037 · Marketplace 核心表（we_apps 等）
--
-- 说明：历史上 we_apps / we_app_versions / we_reviews / we_installs /
-- we_lending_* 仅存在于 storage/repo.py（sqlite create_all），
-- 无独立 SQL migration；v8_040+ 又 REFERENCES we_apps。
-- 本文件用 CREATE TABLE IF NOT EXISTS 补齐绿场基线，已部署库可幂等跳过。
-- 编号与 v8_037_developer_tasks / v8_037_moondream_runtime 并列（仓库惯例允许多文件同前缀）。

CREATE TABLE IF NOT EXISTS we_apps (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    author_id BIGINT REFERENCES we_accounts(id) ON DELETE SET NULL,
    author_name VARCHAR(100),
    category VARCHAR(50) NOT NULL DEFAULT 'other',
    description TEXT,
    icon_url TEXT,
    pricing_model VARCHAR(20) NOT NULL DEFAULT 'free',
    price NUMERIC(10, 2) NOT NULL DEFAULT 0,
    free_trials INT NOT NULL DEFAULT 0,
    task_type VARCHAR(100),
    input_kind VARCHAR(50) DEFAULT 'single_file',
    accept_formats JSONB NOT NULL DEFAULT '[]'::jsonb,
    tiers JSONB NOT NULL DEFAULT '[]'::jsonb,
    min_memory_mb INT NOT NULL DEFAULT 1024,
    gpu_required BOOLEAN NOT NULL DEFAULT false,
    sandbox_network VARCHAR(20) NOT NULL DEFAULT 'none',
    launch_kind VARCHAR(20) NOT NULL DEFAULT 'workload',
    deep_link_url TEXT,
    rating_avg NUMERIC(3, 2) NOT NULL DEFAULT 0,
    rating_count INT NOT NULL DEFAULT 0,
    install_count INT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    verified_author BOOLEAN NOT NULL DEFAULT false,
    platform_share_pct NUMERIC(5, 2) NOT NULL DEFAULT 20,
    display_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS we_app_versions (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    app_id BIGINT NOT NULL REFERENCES we_apps(id) ON DELETE CASCADE,
    version VARCHAR(20) NOT NULL,
    script_bundle_url TEXT,
    model_bundle_url TEXT,
    changelog TEXT,
    sha256 VARCHAR(64),
    size_bytes BIGINT NOT NULL DEFAULT 0,
    signed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT we_app_versions_app_ver_uq UNIQUE (app_id, version)
);

CREATE TABLE IF NOT EXISTS we_reviews (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    app_id BIGINT NOT NULL REFERENCES we_apps(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    rating INT NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT we_reviews_app_user_uq UNIQUE (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS we_installs (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    app_id BIGINT NOT NULL REFERENCES we_apps(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    version VARCHAR(20),
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    use_count INT NOT NULL DEFAULT 0,
    subscription_expires_at TIMESTAMPTZ,
    CONSTRAINT we_installs_app_user_uq UNIQUE (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS we_lending_nodes (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    worker_id UUID NOT NULL UNIQUE REFERENCES we_workers(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    max_cpu_cores INT NOT NULL DEFAULT 2,
    max_memory_mb INT NOT NULL DEFAULT 4096,
    schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
    pricing_mode VARCHAR(10) NOT NULL DEFAULT 'auto',
    manual_price NUMERIC(10, 2),
    allow_third_party BOOLEAN NOT NULL DEFAULT false,
    total_earned NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_hours NUMERIC(10, 1) NOT NULL DEFAULT 0,
    rep_score INT NOT NULL DEFAULT 50,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS we_lending_earnings (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    node_id BIGINT NOT NULL REFERENCES we_lending_nodes(id) ON DELETE CASCADE,
    task_id UUID,
    hours NUMERIC(5, 2) NOT NULL DEFAULT 0,
    rate NUMERIC(10, 2) NOT NULL DEFAULT 0,
    earned NUMERIC(10, 2) NOT NULL DEFAULT 0,
    platform_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE we_apps IS 'v8_037 · Marketplace 应用主表（回流补齐）';
COMMENT ON TABLE we_app_versions IS 'v8_037 · 应用版本与制品元数据';
COMMENT ON TABLE we_reviews IS 'v8_037 · 应用评价';
COMMENT ON TABLE we_installs IS 'v8_037 · 用户安装库';
COMMENT ON TABLE we_lending_nodes IS 'v8_037 · 算力出借节点配置';
COMMENT ON TABLE we_lending_earnings IS 'v8_037 · 出借收益流水';
