-- 官网 BetaProgram 企业咨询。先迁移再挂载 /api/v8/leads/enterprise。
-- 独立于广告位招商 we_advertising_leads；客户咨询不应混入广告投放漏斗。
BEGIN;

CREATE TABLE IF NOT EXISTS we_enterprise_leads (
    id                  BIGSERIAL PRIMARY KEY,
    company             TEXT NOT NULL CHECK (char_length(company) BETWEEN 2 AND 120),
    contact             TEXT NOT NULL CHECK (char_length(contact) BETWEEN 1 AND 60),
    contact_channel     TEXT NOT NULL CHECK (char_length(contact_channel) BETWEEN 3 AND 120),
    company_size        TEXT NOT NULL DEFAULT ''
                        CHECK (company_size IN ('', '1-10', '11-50', '51-200', '200+')),
    use_case            TEXT NOT NULL
                        CHECK (use_case IN ('3d-render', 'ai-inference', 'data-eng', 'research', 'other')),
    budget              TEXT NOT NULL DEFAULT ''
                        CHECK (budget IN ('', 'lt-1k', '1k-5k', '5k-30k', '30k+')),
    note                TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
    source              TEXT NOT NULL CHECK (source = 'beta-program-page'),
    client_submitted_at TIMESTAMPTZ NOT NULL,
    source_ip           TEXT NOT NULL,
    user_agent          TEXT NOT NULL DEFAULT '',
    dedupe_key          CHAR(64) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacting', 'closed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_enterprise_leads_dedupe_idx
    ON we_enterprise_leads (dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS we_enterprise_leads_created_idx
    ON we_enterprise_leads (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS we_enterprise_leads_status_idx
    ON we_enterprise_leads (status, created_at DESC);

COMMENT ON TABLE we_enterprise_leads IS '官网 BetaProgram 企业咨询线索；仅管理员可读取个人联系方式';
COMMENT ON COLUMN we_enterprise_leads.contact_channel IS '官网历史字段 phone，实际可填手机、微信或邮箱';
COMMENT ON COLUMN we_enterprise_leads.client_submitted_at IS '客户端参考时间，created_at 才是服务端权威提交时间';

COMMIT;
