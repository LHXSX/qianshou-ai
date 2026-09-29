-- v8_023 · 2026-05-26 · 广告位招商 · 广告主线索表
--
-- 广告主 (耐克 / 阿里云 / 京东商家 等) 在 web-portal /advertising 页提交申请
-- admin 在后台看到 + 联系 + 排期 + 转化成 we_op_slots 真实广告

CREATE TABLE IF NOT EXISTS we_advertising_leads (
    id              BIGSERIAL PRIMARY KEY,
    company         TEXT        NOT NULL,
    contact         TEXT        NOT NULL,
    phone           TEXT        NOT NULL DEFAULT '',
    email           TEXT        NOT NULL DEFAULT '',
    wechat          TEXT        NOT NULL DEFAULT '',
    industry        TEXT        NOT NULL DEFAULT '',  -- 行业 (云服务/电商/教育/招聘/金融...)
    budget_range    TEXT        NOT NULL DEFAULT '',  -- 预算档位 (1w 以下 / 1-5w / 5-20w / 20w+)
    slot_keys       TEXT[]      NOT NULL DEFAULT '{}',  -- 感兴趣的位 (splash/banner/notice/activity)
    target_audience JSONB       NOT NULL DEFAULT '{}',  -- 期望受众 ({gpu:true, region:["cn"], os:["mac","win"]})
    duration_days   INTEGER     NOT NULL DEFAULT 7,     -- 投放周期 (天)
    creative_url    TEXT        NOT NULL DEFAULT '',    -- 已有素材 URL (可选)
    note            TEXT        NOT NULL DEFAULT '',    -- 需求备注

    status          TEXT        NOT NULL DEFAULT 'new'  -- new / contacting / negotiating / won / lost / archived
                    CHECK (status IN ('new','contacting','negotiating','won','lost','archived')),
    admin_note      TEXT        NOT NULL DEFAULT '',
    contacted_by    BIGINT      REFERENCES we_accounts(id) ON DELETE SET NULL,
    contacted_at    TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,

    -- 关联到实际成交的 op_slots (转化追踪)
    converted_slot_ids BIGINT[] NOT NULL DEFAULT '{}',
    deal_amount     NUMERIC(18,4) NOT NULL DEFAULT 0,   -- 成交金额 (元)

    source          TEXT        NOT NULL DEFAULT 'advertising-partner-page',
    source_ip       TEXT        NOT NULL DEFAULT '',
    user_agent      TEXT        NOT NULL DEFAULT '',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_advertising_leads_status_idx
    ON we_advertising_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS we_advertising_leads_created_idx
    ON we_advertising_leads (created_at DESC);

COMMENT ON TABLE we_advertising_leads IS '广告位招商 · 广告主提交的合作意向线索';
