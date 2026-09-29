-- v8_030_payment.sql · 2026-06-07 · S3-T1
--
-- 商业化必需的 4 张表:支付订单 / 提现申请 / 发票抬头 / 税票
--
-- 现状空白:
--   - 充值: 仅 admin_deposit (admin 给用户充) · 用户无真支付通道
--   - 提现: economy.py:withdraw 直接扣 ledger · 无审批 · 无打款
--   - 发票: enterprise_stub.py invoices 全 501
--
-- 本 migration 提供数据模型骨架,业务代码由 S3-T2/T3/T8 实现。

BEGIN;

-- ── 1. 支付订单(充值) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS we_payment_orders (
  id                BIGSERIAL PRIMARY KEY,
  order_no          VARCHAR(64) NOT NULL UNIQUE,  -- 业务订单号 (前缀 PAY_)
  account_id        BIGINT      NOT NULL REFERENCES we_accounts(id) ON DELETE RESTRICT,
  amount            NUMERIC(18, 4) NOT NULL CHECK (amount > 0),
  currency          VARCHAR(8)  NOT NULL DEFAULT 'CNY',
  -- 支付通道
  gateway           VARCHAR(32) NOT NULL CHECK (gateway IN ('wechat_pay','alipay','bank_transfer','usdt','admin_manual')),
  gateway_order_id  VARCHAR(128),                 -- 支付方系统的订单号
  gateway_tx_id     VARCHAR(128),                 -- 第三方交易流水号 (回调写入)
  -- 状态机
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','paid','failed','cancelled','refunded','expired')),
  -- 关联 ledger (paid 后写入 DEPOSIT)
  ledger_id         UUID,                         -- → we_ledger.id
  -- 元数据
  notify_url        TEXT,                         -- 回调地址
  return_url        TEXT,                         -- 跳转地址
  client_ip         INET,
  user_agent        TEXT,
  remark            TEXT,
  -- 时间
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at           TIMESTAMPTZ,
  expired_at        TIMESTAMPTZ,                  -- 订单超时时刻 (一般 15 分钟)
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_payment_orders_account_created_idx
    ON we_payment_orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_payment_orders_status_idx
    ON we_payment_orders(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS we_payment_orders_gateway_tx_idx
    ON we_payment_orders(gateway, gateway_tx_id) WHERE gateway_tx_id IS NOT NULL;

COMMENT ON TABLE we_payment_orders IS 'S3-T1 · 充值订单 (用户主动支付) · paid 后回调写 DEPOSIT ledger';


-- ── 2. 提现申请 (改 economy.py:withdraw 为 workflow) ────
CREATE TABLE IF NOT EXISTS we_withdraw_requests (
  id                BIGSERIAL PRIMARY KEY,
  request_no        VARCHAR(64) NOT NULL UNIQUE,   -- 业务号 (前缀 WD_)
  account_id        BIGINT      NOT NULL REFERENCES we_accounts(id) ON DELETE RESTRICT,
  amount            NUMERIC(18, 4) NOT NULL CHECK (amount > 0),
  currency          VARCHAR(8)  NOT NULL DEFAULT 'CNY',
  -- 收款账户信息 (JSONB · 支持多种:alipay/wechat/bank/usdt)
  payee_info        JSONB       NOT NULL DEFAULT '{}',  -- {kind, account_no, bank_name, holder_name, ...}
  -- 状态机
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','paid','failed','cancelled')),
  -- 审批
  reviewed_by       BIGINT REFERENCES we_accounts(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  -- 实际打款
  paid_tx_id        VARCHAR(128),                  -- 银行/支付宝流水号
  paid_at           TIMESTAMPTZ,
  ledger_id         UUID,                          -- → we_ledger (WITHDRAW)
  -- KYC (最低限度手工签字)
  kyc_status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (kyc_status IN ('pending','verified','rejected')),
  -- 元数据
  client_ip         INET,
  remark            TEXT,
  -- 时间
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_withdraw_requests_account_idx
    ON we_withdraw_requests(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_withdraw_requests_pending_idx
    ON we_withdraw_requests(status) WHERE status IN ('pending','approved');

COMMENT ON TABLE we_withdraw_requests IS 'S3-T1 · 提现申请 workflow · approved→paid 时写 WITHDRAW ledger';


-- ── 3. 开票抬头 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS we_invoice_titles (
  id                BIGSERIAL PRIMARY KEY,
  account_id        BIGINT      NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
  title_type        VARCHAR(20) NOT NULL CHECK (title_type IN ('personal','company')),
  title_name        VARCHAR(200) NOT NULL,
  tax_id            VARCHAR(50),                   -- 企业税号 (个人可空)
  bank_name         VARCHAR(200),
  bank_account      VARCHAR(64),
  address           VARCHAR(500),
  phone             VARCHAR(50),
  email             VARCHAR(200),
  is_default        BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_invoice_titles_account_idx ON we_invoice_titles(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS we_invoice_titles_account_default_uq
    ON we_invoice_titles(account_id) WHERE is_default = true;

COMMENT ON TABLE we_invoice_titles IS 'S3-T1 · 开票抬头 (替换 enterprise_stub.invoice-titles)';


-- ── 4. 税务发票 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS we_tax_invoices (
  id                BIGSERIAL PRIMARY KEY,
  invoice_no        VARCHAR(64) NOT NULL UNIQUE,   -- 税控系统返的发票号
  account_id        BIGINT      NOT NULL REFERENCES we_accounts(id) ON DELETE RESTRICT,
  title_id          BIGINT REFERENCES we_invoice_titles(id) ON DELETE SET NULL,
  -- 金额
  amount            NUMERIC(18, 4) NOT NULL CHECK (amount > 0),
  tax_rate          NUMERIC(5, 4)  NOT NULL DEFAULT 0.0600,  -- 默认 6%
  -- 关联订单/账单
  business_invoice_id  BIGINT REFERENCES we_business_invoices(id) ON DELETE SET NULL,
  -- 状态
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','issued','sent','voided','failed')),
  -- 税控系统
  provider          VARCHAR(32),                   -- baiwang / nuonuo / manual
  provider_invoice_id  VARCHAR(128),
  pdf_url           TEXT,                          -- 电子发票 PDF
  pdf_sha256        VARCHAR(64),
  -- 邮件发送
  recipient_email   VARCHAR(200),
  sent_at           TIMESTAMPTZ,
  -- 时间
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_tax_invoices_account_idx ON we_tax_invoices(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_tax_invoices_status_idx ON we_tax_invoices(status) WHERE status IN ('pending','failed');

COMMENT ON TABLE we_tax_invoices IS 'S3-T1 · 税务发票 (与 B2B 月度账单 we_business_invoices 不同 · 此为真税票)';


-- ── 5. 扩展 ledger type 含 DEPOSIT/WITHDRAW (如未含) ──
DO $$
BEGIN
  -- 检查现有 CHECK 约束(可能需要 ALTER · 此处仅注释指引 · 实际执行需查 pg_constraint)
  -- 推荐用 ALTER TABLE we_ledger DROP CONSTRAINT we_ledger_type_chk;
  -- ALTER TABLE we_ledger ADD CONSTRAINT we_ledger_type_chk
  --   CHECK (type IN ('ESCROW_HOLD','ESCROW_RELEASE','REWARD','REFUND',
  --                   'DEPOSIT','WITHDRAW','ADMIN_DEPOSIT','ADMIN_DEDUCT',
  --                   'PLATFORM_FEE','RISK_POOL'));
  NULL;
END $$;

COMMIT;
