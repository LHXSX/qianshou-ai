-- ════════════════════════════════════════════════════════════════
-- v8_013 · B2B 客户合约 (W7 · 2026-05-26)
--
-- 背景 (用户原话):
--   "ip池 的作用是承包给其他大厂 吊用我们的"
--   = 我们做 IP 代理池 *基础设施* · 批发给 GEO 服务商 / 爬虫 SaaS / AI 数据公司
--   不做散户 B2C · 只对接 B2B 大客户 · 月度承包 + SLA
--
-- 设计:
--   - 一个 business 账号 (we_accounts.role='business') 可有 0..N 个合约
--   - 一个合约定义 (配额 / 单价 / SLA / 时段)
--   - proxy gateway 用 active 合约的 quota_bytes_per_month 做配额检查
--   - 月度账单从 we_ledger WHERE workload_id LIKE 'proxy_%' 聚合 (W7-phase2)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_business_contracts (
    id                       BIGSERIAL    PRIMARY KEY,
    account_id               BIGINT       NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    name                     VARCHAR(120) NOT NULL,                          -- 合约名 · 如 "豆包-2026Q2"
    business_type            VARCHAR(40)  NOT NULL DEFAULT 'ip_proxy',       -- ip_proxy / crawl / geo_monitor 三选一
    -- 配额
    quota_bytes_per_month    BIGINT       NOT NULL DEFAULT 0,                -- 0 = 不限 · 否则月配额
    quota_concurrent_sessions INT         NOT NULL DEFAULT 100,              -- 并发 session 上限
    -- 计价
    price_per_gb_edg         NUMERIC(18,6) NOT NULL DEFAULT 0.01,            -- 单价 · 默认 0.01 EDG/GB
    discount_pct             NUMERIC(5,2) NOT NULL DEFAULT 0,                -- 折扣百分比 (大客户谈下来的)
    -- SLA
    sla_uptime_pct           NUMERIC(5,2) NOT NULL DEFAULT 99.0,             -- SLA 可用性 · 默认 99%
    sla_support_tier         VARCHAR(20)  NOT NULL DEFAULT 'standard',       -- standard / premium / enterprise
    -- 状态机
    status                   VARCHAR(20)  NOT NULL DEFAULT 'active',         -- active / suspended / expired / draft
    -- 时段
    start_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    end_at                   TIMESTAMPTZ  NULL,                              -- NULL = 长期 · 否则到期失效
    -- 备注
    notes                    TEXT         NOT NULL DEFAULT '',
    metadata                 JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- 自由字段 (合同 PDF URL / 销售代表 / 等)
    -- 审计
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by               BIGINT       NULL REFERENCES we_accounts(id) ON DELETE SET NULL  -- admin id
);

-- 索引: 按 account_id 查活跃合约 (proxy gateway 高频查)
CREATE INDEX IF NOT EXISTS idx_business_contracts_account_active
    ON we_business_contracts (account_id, status)
    WHERE status = 'active';

-- 索引: admin 列表 (按状态 + 业务类型 + 时间排)
CREATE INDEX IF NOT EXISTS idx_business_contracts_admin_list
    ON we_business_contracts (status, business_type, created_at DESC);

-- 注释
COMMENT ON TABLE we_business_contracts IS 'B2B 大客户合约 · W7 · 2026-05-26 · IP 代理池/爬虫/GEO 共用';
COMMENT ON COLUMN we_business_contracts.business_type IS 'ip_proxy / crawl / geo_monitor';
COMMENT ON COLUMN we_business_contracts.quota_bytes_per_month IS '月配额 (字节) · 0=不限';
COMMENT ON COLUMN we_business_contracts.price_per_gb_edg IS '单价 EDG/GB · 跟实际计费走 (覆盖默认 PROXY_PRICE_PER_BYTE)';
COMMENT ON COLUMN we_business_contracts.status IS 'active=生效 · suspended=临时停 · expired=过期 · draft=未生效';
