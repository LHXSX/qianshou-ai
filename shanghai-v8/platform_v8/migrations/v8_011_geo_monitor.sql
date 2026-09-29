-- v8_011_geo_monitor.sql · 2026-05-26 W2 · GEO 监测业务接入统一引擎
--
-- 设计原则 (跟旧爬虫子系统区别):
--   ❌ 不建 we_geo_orders (订单 = workload · 用 we_workloads · 加 metadata['business']='geo')
--   ❌ 不建 we_geo_subtasks (子任务 = shard · 用 we_shards · mode=pull)
--   ✅ 只建 GEO *辅助* 表:
--      - we_geo_llm_configs   · 6 LLM 端点 + auth 配置 (admin 维护)
--      - we_geo_brands        · 客户品牌库 (一个客户多品牌)
--      - we_geo_observations  · NLP 分析后的观察数据 (时序大表)
--
-- 调度链路 (复用统一引擎):
--   客户提 workload (task_type=geo_query · mode=PULL · spec.params 含 brand_id + keywords + llm_codes)
--     → lifecycle.start · slice 成 N shards (每个 shard = 一个 query · 一个 brand×keyword×llm)
--     → 节点 PullRequest 抢 shard
--     → 节点跑 scripts/tasks/geo_query.py · 调 LLM API · 返结果
--     → aggregator on_shard_done · 调 NLP 分析 · 写 we_geo_observations
--     → 全 done · workload DONE · reward 走 ledger (跟算力一样的协议)
--
-- 商业价值 · 统一架构带来:
--   · 客户在 admin 看一个统一 workload 列表 (跟其他业务并列)
--   · 计费/反作弊/审计走同一套 ledger / planner
--   · 节点能同时抢算力 + GEO + (未来) 爬虫 · 不分流量分组
--
-- 安全: ALTER ADD COLUMN IF NOT EXISTS · 重复跑无害
-- 回滚: v8_011_geo_monitor_rollback.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════
-- 1. we_geo_llm_configs · LLM 端点配置 (admin 维护)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS we_geo_llm_configs (
    id BIGSERIAL PRIMARY KEY,
    llm_code VARCHAR(32) NOT NULL UNIQUE,
    display_name VARCHAR(64) NOT NULL,
    api_endpoint VARCHAR(256) NOT NULL,
    auth_type VARCHAR(32) NOT NULL DEFAULT 'bearer',
    auth_secret_ref VARCHAR(128) NOT NULL,
    rate_limit_per_min INT NOT NULL DEFAULT 60,
    avg_latency_ms INT NOT NULL DEFAULT 3000,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE we_geo_llm_configs IS 'GEO 监测 · 6 LLM 端点配置 · admin 维护';
COMMENT ON COLUMN we_geo_llm_configs.llm_code IS '稳定标识 kimi/doubao/deepseek/gpt-4/claude/wenxin';
COMMENT ON COLUMN we_geo_llm_configs.auth_secret_ref IS '引用 env / vault 的 key · 不存明文';

-- 预置 6 LLM (admin 后台配 secret 值)
INSERT INTO we_geo_llm_configs (llm_code, display_name, api_endpoint, auth_type, auth_secret_ref, avg_latency_ms)
VALUES
    ('kimi',     'Kimi (月之暗面)',     'https://api.moonshot.cn/v1/chat/completions',                          'bearer', 'KIMI_API_KEY', 4000),
    ('doubao',   '豆包 (字节)',         'https://ark.cn-beijing.volces.com/api/v3/chat/completions',           'bearer', 'DOUBAO_API_KEY', 3500),
    ('deepseek', 'DeepSeek',           'https://api.deepseek.com/chat/completions',                          'bearer', 'DEEPSEEK_API_KEY', 5000),
    ('gpt-4',    'GPT-4 (OpenAI)',     'https://api.openai.com/v1/chat/completions',                          'bearer', 'OPENAI_API_KEY', 6000),
    ('claude',   'Claude (Anthropic)', 'https://api.anthropic.com/v1/messages',                              'api_key', 'ANTHROPIC_API_KEY', 5500),
    ('wenxin',   '文心一言 (百度)',     'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions', 'bearer', 'BAIDU_API_KEY', 4500)
ON CONFLICT (llm_code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- 2. we_geo_brands · 客户品牌库
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS we_geo_brands (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL,            -- account_id · 客户 (GEO 服务商或品牌方)
    brand_name VARCHAR(128) NOT NULL,
    brand_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["Apple", "苹果", "iPhone 厂商"]
    category VARCHAR(64),                   -- "phone" / "auto" / "food" / ...
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id, brand_name)
);

CREATE INDEX IF NOT EXISTS idx_geo_brands_customer ON we_geo_brands(customer_id);

COMMENT ON TABLE we_geo_brands IS 'GEO 监测 · 客户品牌库 · 多个 brand 共用同一个客户 account';

-- ════════════════════════════════════════════════════════════════
-- 3. we_geo_observations · NLP 分析后的观察数据 (时序大表)
-- ════════════════════════════════════════════════════════════════
-- 每个 shard 完成 → aggregator 跑 NLP → 写入 N 条 observations
-- 一条 observation = 一次具体查询的结构化结果
CREATE TABLE IF NOT EXISTS we_geo_observations (
    id BIGSERIAL PRIMARY KEY,
    workload_id VARCHAR(36) NOT NULL,       -- 反向引用统一引擎 workload (we_workloads.id 是 String(36))
    shard_id VARCHAR(36) NOT NULL,          -- 反向引用 shard
    brand_id BIGINT NOT NULL REFERENCES we_geo_brands(id),
    keyword VARCHAR(256) NOT NULL,
    llm_code VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- ── NLP 分析指标 ────────────────────────
    mention_count INT NOT NULL DEFAULT 0,    -- 品牌被提及次数
    rank_position INT,                       -- 排名 (1=第一个被提及 · NULL=未提及)
    sentiment NUMERIC(4,3),                  -- -1.0 ~ 1.0 (情感倾向)
    recommended BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否被推荐
    competitors JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 同响应里其他被提及品牌
    raw_excerpt TEXT,                        -- 响应里相关片段 (摘录 · 节省存储)
    response_oss_url VARCHAR(512),           -- 完整原始响应 (上 OSS · 大响应不进 DB)
    response_hash VARCHAR(64),               -- 响应 SHA256 (跨副本反作弊比对)
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_geo_obs_brand_time ON we_geo_observations(brand_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_geo_obs_workload ON we_geo_observations(workload_id);
CREATE INDEX IF NOT EXISTS idx_geo_obs_llm_time ON we_geo_observations(llm_code, observed_at DESC);

COMMENT ON TABLE we_geo_observations IS 'GEO 监测 · NLP 分析后的观察数据 · 时序大表 · 客户报表数据源';

COMMIT;

-- ════════════════════════════════════════════════════════════════
-- 验证
-- ════════════════════════════════════════════════════════════════
-- \d+ we_geo_llm_configs
-- SELECT llm_code, display_name, enabled FROM we_geo_llm_configs;
-- \d+ we_geo_brands
-- \d+ we_geo_observations
