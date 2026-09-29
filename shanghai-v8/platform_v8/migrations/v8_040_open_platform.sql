-- v8_040 · 开放平台（应用即 API · 卖调用次数）
-- 引擎零改 · 复用 we_api_keys(v8_031) 做鉴权 · we_ledger 做扣款分账
-- 设计: docs 见 apps/eco-client/docs/七步_次世代生态客户端_2026-08-07/08_生态扩展蓝图_开放平台与收益深化.md

-- 1. 套餐 SKU
CREATE TABLE IF NOT EXISTS we_api_packs (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    calls INT NOT NULL CHECK (calls > 0),
    price_edg NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_edg >= 0),
    -- NULL = 通用包（全应用可用，收入归平台）；非 NULL = 应用专属包（作者分成 80%）
    app_id BIGINT REFERENCES we_apps(id) ON DELETE CASCADE,
    -- 体验包防刷：每账户限购一次
    once_per_account BOOLEAN NOT NULL DEFAULT false,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. 配额账户（account × app 维度，app_id NULL = 通用配额）
CREATE TABLE IF NOT EXISTS we_api_quotas (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    account_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    app_id BIGINT REFERENCES we_apps(id) ON DELETE CASCADE,
    remaining INT NOT NULL DEFAULT 0 CHECK (remaining >= 0),
    total_purchased INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- app_id 可空，唯一性用表达式索引（NULL 归一成 0）
CREATE UNIQUE INDEX IF NOT EXISTS we_api_quotas_acct_app_uq
    ON we_api_quotas (account_id, COALESCE(app_id, 0));

-- 3. 购买流水（对账 + once_per_account 判定）
CREATE TABLE IF NOT EXISTS we_api_pack_orders (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    account_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    pack_id BIGINT NOT NULL REFERENCES we_api_packs(id) ON DELETE CASCADE,
    calls INT NOT NULL,
    price_edg NUMERIC(10,2) NOT NULL,
    author_share_edg NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS we_api_pack_orders_acct_idx ON we_api_pack_orders (account_id, created_at DESC);

-- 4. 调用流水（append-only · 对账三方：配额扣减 = usage 行数 = workload 数）
CREATE TABLE IF NOT EXISTS we_api_usage (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    key_id BIGINT REFERENCES we_api_keys(id) ON DELETE SET NULL,
    account_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    app_id BIGINT REFERENCES we_apps(id) ON DELETE SET NULL,
    workload_id UUID,
    status VARCHAR(20) NOT NULL DEFAULT 'submitted',
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS we_api_usage_acct_time_idx ON we_api_usage (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_api_usage_app_idx ON we_api_usage (app_id, created_at DESC);

-- 5. 种子套餐（通用包：体验/标准/专业）
INSERT INTO we_api_packs (name, description, calls, price_edg, app_id, once_per_account, active)
SELECT '开发者体验包', '新开发者免费体验：100 次通用调用，每账户限领一次', 100, 0, NULL, true, true
WHERE NOT EXISTS (SELECT 1 FROM we_api_packs WHERE name = '开发者体验包');

INSERT INTO we_api_packs (name, description, calls, price_edg, app_id, once_per_account, active)
SELECT '标准包 1K', '1,000 次通用调用，全应用可用', 1000, 8, NULL, false, true
WHERE NOT EXISTS (SELECT 1 FROM we_api_packs WHERE name = '标准包 1K');

INSERT INTO we_api_packs (name, description, calls, price_edg, app_id, once_per_account, active)
SELECT '专业包 10K', '10,000 次通用调用，批量价约 75 折', 10000, 60, NULL, false, true
WHERE NOT EXISTS (SELECT 1 FROM we_api_packs WHERE name = '专业包 10K');

COMMENT ON TABLE we_api_packs IS 'v8_040 · 开放平台调用套餐 SKU';
COMMENT ON TABLE we_api_quotas IS 'v8_040 · 开发者调用配额（app 专属优先于通用）';
COMMENT ON TABLE we_api_usage IS 'v8_040 · API 调用流水 append-only';
