-- ════════════════════════════════════════════════════════════════
-- v8_014 · B2B 客户月度账单 (W7-phase2 · 2026-05-26)
--
-- 背景:
--   W7 已有 we_business_contracts (合约)
--   W7-phase2 加 we_business_invoices (按月生成账单 · admin 标已付 / 客户下载)
--
-- 数据流:
--   admin 每月 1 号 (或手工) 触发 generate_invoice
--   → billing.py 从 we_ledger WHERE workload_id LIKE 'proxy_%' 聚合本月所有 transfer
--   → 按 account_id × period_yyyymm 写一条 invoice (幂等键防重)
--   → admin/客户 查 invoice 列表 + 明细
--   → admin 标 status=paid (链下转账完成后)
--
-- 一个客户一个月通常一张账单 (period_yyyymm + account_id 唯一)
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_business_invoices (
    id                  BIGSERIAL    PRIMARY KEY,
    account_id          BIGINT       NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    contract_id         BIGINT       NULL REFERENCES we_business_contracts(id) ON DELETE SET NULL,
    period_yyyymm       VARCHAR(7)   NOT NULL,                          -- "2026-05"
    business_type       VARCHAR(40)  NOT NULL DEFAULT 'ip_proxy',
    -- 用量 (从 ledger 聚合)
    total_bytes         BIGINT       NOT NULL DEFAULT 0,
    session_count       INT          NOT NULL DEFAULT 0,
    -- 计费
    amount_edg          NUMERIC(18, 6) NOT NULL DEFAULT 0,              -- 客户应付 (ESCROW_HOLD 绝对值)
    node_paid_edg       NUMERIC(18, 6) NOT NULL DEFAULT 0,              -- 节点拿到
    platform_fee_edg    NUMERIC(18, 6) NOT NULL DEFAULT 0,              -- 平台抽成
    -- 状态机
    status              VARCHAR(20)  NOT NULL DEFAULT 'draft',          -- draft / issued / paid / cancelled
    -- 时间
    generated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    issued_at           TIMESTAMPTZ  NULL,
    paid_at             TIMESTAMPTZ  NULL,
    due_at              TIMESTAMPTZ  NULL,
    -- 元数据
    notes               TEXT         NOT NULL DEFAULT '',
    metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- 链下流水号 / 发票号
    -- 审计
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- 防重: 同客户同月份同业务最多一张
    CONSTRAINT we_business_invoices_unique_period
        UNIQUE (account_id, period_yyyymm, business_type)
);

CREATE INDEX IF NOT EXISTS idx_invoices_account_period
    ON we_business_invoices (account_id, period_yyyymm DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status
    ON we_business_invoices (status, created_at DESC);

COMMENT ON TABLE we_business_invoices IS 'B2B 月度账单 · W7-phase2 · 2026-05-26';
COMMENT ON COLUMN we_business_invoices.period_yyyymm IS '账期 "YYYY-MM" · 从 ledger 聚合该月';
COMMENT ON COLUMN we_business_invoices.amount_edg IS '客户应付 (ledger ESCROW_HOLD 绝对值)';
COMMENT ON COLUMN we_business_invoices.status IS 'draft=草稿 · issued=已发账单 · paid=已收款 · cancelled=作废';
