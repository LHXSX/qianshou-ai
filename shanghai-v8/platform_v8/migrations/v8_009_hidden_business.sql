-- ════════════════════════════════════════════════════════════════
-- v8_009 · 平台自营业务基础设施 (IP 代理池 / GEO 监测 / 广告增强 / CDN)
-- 2026-05-26
--
-- 核心: master feature flag + 4 张支撑表
-- 设计原则 (用户决策):
--   1. 节点知情 (UI 看到任务 · 但脱敏只显示通用名)
--   2. 节点 *拿小额 EDG* 补贴 (D 方案 · 摊薄给奖励)
--   3. 补贴单价 admin 可调 (we_subsidy_rules)
--   4. 平台 100% 收入 (we_platform_revenue)
--   5. master flag 默认 OFF · admin 后期一键开
-- ════════════════════════════════════════════════════════════════

-- ── 1. master feature flag ──────────────────────────
-- nce_platform_hidden_business · 总开关 · OFF=后端拒派
-- 各业务子开关 · master 开了才生效
INSERT INTO we_feature_flags (flag_name, enabled, rollout_pct, description, updated_by) VALUES
    ('nce_platform_hidden_business', FALSE, 0,
     '平台自营业务总开关 · OFF=后端不下发任何自营任务给节点 · ON=admin 决定后启用', 'system'),
    ('nce_business_ip_proxy', FALSE, 0,
     'IP 代理池子开关 · master 开了才生效', 'system'),
    ('nce_business_geo_monitor', FALSE, 0,
     'GEO 监测子开关 · master 开了才生效', 'system'),
    ('nce_business_cdn_edge', FALSE, 0,
     'CDN 边缘缓存子开关 · 未来上 · 现 OFF', 'system')
ON CONFLICT (flag_name) DO NOTHING;


-- ── 2. we_subsidy_rules · admin 配补贴单价 ───────────
-- D 方案: 跑系统任务 → 节点拿小额 EDG · 单价 admin 可调
-- 计价方式: per_byte / per_session / per_query / per_impression / per_minute / monthly_flat
CREATE TABLE IF NOT EXISTS we_subsidy_rules (
    id              BIGSERIAL PRIMARY KEY,
    business        VARCHAR(32) NOT NULL,                 -- 'ip_proxy' / 'geo_monitor' / 'ads' / 'cdn'
    basis           VARCHAR(32) NOT NULL,                 -- 计价方式
    unit_price_edg  NUMERIC(20,12) NOT NULL DEFAULT 0,    -- 单价 EDG (per unit)
    min_payout_edg  NUMERIC(20,12) NOT NULL DEFAULT 0,    -- 单次最低发钱阈值 (避免发 1 分钱)
    max_per_day_edg NUMERIC(20,6) NOT NULL DEFAULT 1.0,   -- 单节点每日补贴上限
    budget_daily_edg NUMERIC(20,6) NOT NULL DEFAULT 1000, -- 业务预算池 (每天)
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by      VARCHAR(64) NOT NULL DEFAULT 'system',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business, basis)
);

-- 预置规则 (单价低 · admin 后台再调高)
INSERT INTO we_subsidy_rules (business, basis, unit_price_edg, min_payout_edg, max_per_day_edg, budget_daily_edg) VALUES
    ('ip_proxy',     'per_byte',       0.0000000001, 0.0001, 0.1, 100),   -- 1 GB ≈ 0.1 EDG
    ('ip_proxy',     'per_session',    0.0001,       0.0001, 0.1, 100),
    ('geo_monitor',  'per_query',      0.001,        0.001,  1.0, 1000),
    ('ads',          'per_impression', 0.00001,      0.0001, 0.01, 50),
    ('ads',          'per_click',      0.001,        0.001,  0.1, 100),
    ('cdn_edge',     'per_byte',       0.0000000001, 0.0001, 0.5, 500)
ON CONFLICT (business, basis) DO NOTHING;

COMMENT ON TABLE we_subsidy_rules IS '节点补贴规则 · admin 可调 · 控成本';
COMMENT ON COLUMN we_subsidy_rules.unit_price_edg IS '单价 EDG · per unit · 小数 12 位精度';
COMMENT ON COLUMN we_subsidy_rules.budget_daily_edg IS '业务预算池 · 当天超 → 停发补贴 (业务还跑 · 节点拿 0)';


-- ── 3. we_node_subsidies · 节点补贴流水 ──────────────
CREATE TABLE IF NOT EXISTS we_node_subsidies (
    id              BIGSERIAL PRIMARY KEY,
    worker_id       VARCHAR(64) NOT NULL,
    owner_id        BIGINT,                               -- worker.owner_id (方便按 owner 汇总)
    business        VARCHAR(32) NOT NULL,                 -- 'ip_proxy' / ...
    basis           VARCHAR(32) NOT NULL,                 -- 'per_byte' / ...
    quantity        NUMERIC(20,6) NOT NULL,               -- 计量值 (字节数 / 查询数 / ...)
    unit_price_edg  NUMERIC(20,12) NOT NULL,              -- 当时单价 (历史快照)
    amount_edg      NUMERIC(20,12) NOT NULL,              -- 实付金额 = quantity * unit_price (可能 0)
    ref_id          VARCHAR(64) NOT NULL DEFAULT '',      -- 关联 ID (session_id / query_id / ...)
    paid_to_ledger  BOOLEAN NOT NULL DEFAULT FALSE,       -- 是否已入 ledger (FALSE = 待发)
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subsidies_worker ON we_node_subsidies (worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subsidies_owner ON we_node_subsidies (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subsidies_business ON we_node_subsidies (business, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subsidies_unpaid ON we_node_subsidies (paid_to_ledger, created_at DESC) WHERE paid_to_ledger = FALSE;

COMMENT ON TABLE we_node_subsidies IS '节点补贴流水 · D 方案 · 任务级即时入账';


-- ── 4. we_platform_revenue · 平台收入流水 ────────────
CREATE TABLE IF NOT EXISTS we_platform_revenue (
    id              BIGSERIAL PRIMARY KEY,
    business        VARCHAR(32) NOT NULL,                 -- 'ip_proxy' / 'geo_monitor' / 'ads' / 'cdn'
    client_id       VARCHAR(64) NOT NULL,                 -- 付费客户 (account.id)
    amount_edg      NUMERIC(20,6) NOT NULL,               -- 平台收入 EDG (正数)
    quantity        NUMERIC(20,6) NOT NULL DEFAULT 0,     -- 计量值
    unit            VARCHAR(16) NOT NULL DEFAULT '',      -- 'GB' / 'query' / 'impression' / 'click'
    ref_id          VARCHAR(64) NOT NULL DEFAULT '',      -- 关联 ID
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_revenue_business ON we_platform_revenue (business, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_revenue_client ON we_platform_revenue (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_revenue_ref ON we_platform_revenue (ref_id);

COMMENT ON TABLE we_platform_revenue IS '平台自营业务收入流水 · 100% 归平台 · 跟算力 ledger 独立';


-- ── 5. we_proxy_sessions · IP 代理会话审计 ────────────
CREATE TABLE IF NOT EXISTS we_proxy_sessions (
    id              BIGSERIAL PRIMARY KEY,
    session_id      VARCHAR(64) NOT NULL UNIQUE,
    client_id       VARCHAR(64) NOT NULL,
    worker_id       VARCHAR(64) NOT NULL,
    target_host     VARCHAR(253) NOT NULL,
    target_port     INT NOT NULL,
    bytes_up        BIGINT NOT NULL DEFAULT 0,
    bytes_down      BIGINT NOT NULL DEFAULT 0,
    duration_s      REAL NOT NULL DEFAULT 0,
    reason          VARCHAR(64) NOT NULL DEFAULT '',
    error           TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proxy_sessions_client ON we_proxy_sessions (client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_sessions_worker ON we_proxy_sessions (worker_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_sessions_target ON we_proxy_sessions (target_host, started_at DESC);


-- ── 6. we_proxy_blacklist · 节点黑名单 ────────────────
CREATE TABLE IF NOT EXISTS we_proxy_blacklist (
    worker_id       VARCHAR(64) PRIMARY KEY,
    reason          TEXT NOT NULL DEFAULT '',
    blocked_by      VARCHAR(64) NOT NULL DEFAULT '',
    blocked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE we_proxy_blacklist IS 'admin 手工禁用节点跟 proxy 业务 (节点出问题时用)';
