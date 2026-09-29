-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · NCE (Node Capability Evaluation) · Phase 0 基建
--
-- 版本: v8.4.0
-- 日期: 2026-05-25
-- 作者: Cascade (PRD: 设计_节点能力评估系统_总览_20260525.md)
--
-- 目的: 为 NCE 双维派单 (硬件等级 + 多维信誉) 准备数据基础
--
-- 🛡 安全保证:
--   1. 全部 ALTER ADD COLUMN IF NOT EXISTS · 重复执行幂等
--   2. 所有新字段 DEFAULT 兜底 · 老数据零回归
--   3. 新表独立 · 不动 we_workers/we_ledger 等核心表结构
--   4. 单事务 BEGIN/COMMIT · 失败全部回滚
--   5. 配套 rollback 脚本: v8_004_nce_phase0_rollback.sql
--
-- 使用方法:
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_004_nce_phase0.sql
--
-- 验证 (执行后):
--   \d we_workers       -- 应看到新增的 hw_tier / hw_score / rep_* 字段
--   SELECT * FROM we_feature_flags;  -- 应看到 4 个 flag 全部 enabled=FALSE
--   SELECT COUNT(*) FROM we_workers WHERE hw_tier='B';  -- 应等于现有节点数
--
-- 回滚 (出问题):
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_004_nce_phase0_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. we_workers · 加 NCE 字段 (全部 ADD COLUMN IF NOT EXISTS · 加 DEFAULT)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1.1 硬件等级 (P2 用) ────────────────────────────────────────────────
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS hw_tier         VARCHAR(2) DEFAULT 'B';
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS hw_score        REAL       DEFAULT 50.0;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS hw_evaluated_at TIMESTAMPTZ;
COMMENT ON COLUMN we_workers.hw_tier IS 'NCE 硬件等级: S/A/B/C/D · 默认 B';
COMMENT ON COLUMN we_workers.hw_score IS 'NCE 硬件评分 [0, 100]';

CREATE INDEX IF NOT EXISTS we_workers_hw_tier_idx 
    ON we_workers (hw_tier, status) WHERE status IN ('ONLINE','BUSY');

-- 加 hw_tier CHECK (用 NOT VALID 避免阻塞老数据 · 后续可 VALIDATE)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'we_workers_hw_tier_chk'
    ) THEN
        ALTER TABLE we_workers ADD CONSTRAINT we_workers_hw_tier_chk
            CHECK (hw_tier IN ('S','A','B','C','D')) NOT VALID;
    END IF;
END$$;

-- ─── 1.2 多维信誉 4 子分 (P3 用 · 默认 60 = 白银起步) ───────────────────
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_stability   SMALLINT DEFAULT 60;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_correctness SMALLINT DEFAULT 60;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_speed       SMALLINT DEFAULT 60;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_resource    SMALLINT DEFAULT 60;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_main        SMALLINT DEFAULT 60;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS rep_updated_at  TIMESTAMPTZ;
COMMENT ON COLUMN we_workers.rep_stability IS 'NCE 信誉子分: 稳定性 [0,100] · 占主分 25%';
COMMENT ON COLUMN we_workers.rep_correctness IS 'NCE 信誉子分: 正确性 [0,100] · 占主分 40%';
COMMENT ON COLUMN we_workers.rep_speed IS 'NCE 信誉子分: 速度 [0,100] · 占主分 20%';
COMMENT ON COLUMN we_workers.rep_resource IS 'NCE 信誉子分: 资源诚信 [0,100] · 占主分 15%';
COMMENT ON COLUMN we_workers.rep_main IS 'NCE 主信誉分 [0,100] · 4 子分调和平均 · 跟 reputation (0-1) 并存';

-- 子分范围 CHECK (NOT VALID 防阻塞)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'we_workers_rep_main_chk'
    ) THEN
        ALTER TABLE we_workers ADD CONSTRAINT we_workers_rep_main_chk
            CHECK (rep_main BETWEEN 0 AND 100) NOT VALID;
    END IF;
END$$;

-- 派单索引 (按 hw_tier + rep_main 排序)
CREATE INDEX IF NOT EXISTS we_workers_dispatch_v2_idx 
    ON we_workers (status, hw_tier, rep_main DESC, last_seen)
    WHERE status IN ('ONLINE','BUSY');

-- ─── 1.3 实习状态 (P3 用) ────────────────────────────────────────────────
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS onboarding_status VARCHAR(20) DEFAULT 'active';
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS probation_started_at TIMESTAMPTZ;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS probation_graduated_at TIMESTAMPTZ;
COMMENT ON COLUMN we_workers.onboarding_status IS 'NCE 节点状态: probation (实习) / active (正常) / banned';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'we_workers_onboarding_chk'
    ) THEN
        ALTER TABLE we_workers ADD CONSTRAINT we_workers_onboarding_chk
            CHECK (onboarding_status IN ('probation','active','banned','small_pool')) NOT VALID;
    END IF;
END$$;

-- ─── 1.4 grace period (v1.1 远期 · 字段先备用) ──────────────────────────
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS pending_tier     VARCHAR(2);
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS pending_at       TIMESTAMPTZ;
ALTER TABLE we_workers ADD COLUMN IF NOT EXISTS pending_reason   VARCHAR(40);
COMMENT ON COLUMN we_workers.pending_tier IS 'NCE 待生效档位 (grace period · 暂未启用)';


-- ════════════════════════════════════════════════════════════════════════════
-- 2. we_feature_flags · 功能开关 (核心!)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_feature_flags (
    flag_name       VARCHAR(80)   PRIMARY KEY,
    enabled         BOOLEAN       NOT NULL DEFAULT FALSE,
    rollout_pct     SMALLINT      NOT NULL DEFAULT 0,
    rollout_filter  JSONB         NOT NULL DEFAULT '{}'::jsonb,
    description     TEXT          NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by      VARCHAR(80)   NOT NULL DEFAULT 'system',
    CONSTRAINT we_feature_flags_pct_chk CHECK (rollout_pct BETWEEN 0 AND 100)
);
COMMENT ON TABLE we_feature_flags IS 'NCE feature flag · 灰度开关 · 默认全部 OFF';
COMMENT ON COLUMN we_feature_flags.rollout_pct IS '灰度百分比 [0, 100] · 按 owner_id hash 分桶';
COMMENT ON COLUMN we_feature_flags.rollout_filter IS '可指定 owner_ids / worker_ids 白名单 · {owner_ids:[1,2,3]}';

-- 预置 NCE 相关 flag (全部默认 OFF)
INSERT INTO we_feature_flags (flag_name, enabled, rollout_pct, description, updated_by) VALUES
    ('nce_planner_use_reputation', FALSE, 0, 
     'P1 · planner 把 reputation 加入排序 (修 P0 bug)', 'system'),
    ('nce_planner_shadow_mode', FALSE, 0,
     'P1 · 影子模式 · 算新排序但用旧排序 · 写对照日志', 'system'),
    ('nce_hw_tier_filter', FALSE, 0,
     'P2 · planner 启用硬件等级硬性过滤', 'system'),
    ('nce_hw_score_cron', FALSE, 0,
     'P2 · 每日 cron 重算 hw_score / hw_tier', 'system'),
    ('nce_rep_multi_dim', FALSE, 0,
     'P3 · 启用 4 子分 + 调和平均主分', 'system'),
    ('nce_rep_multi_dim_cron', FALSE, 0,
     'P3 · 每日 cron 重算 4 子分', 'system'),
    ('nce_difficulty_factor', FALSE, 0,
     'P3 · 任务难度因子参与 SUCCESS 加分', 'system'),
    ('nce_api_expose_multi_dim', FALSE, 0,
     'P3 · /api/v8/workers/{id}/reputation 返回 4 子分', 'system')
ON CONFLICT (flag_name) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. we_reputation_events · 信誉事件流水 (数据驱动调参的金矿)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_reputation_events (
    id              BIGSERIAL    PRIMARY KEY,
    worker_id       UUID         NOT NULL,
    event_type      VARCHAR(40)  NOT NULL,
    delta           NUMERIC(6,2) NOT NULL DEFAULT 0,
    before_score    SMALLINT,
    after_score     SMALLINT,
    task_type       VARCHAR(40),
    shard_id        UUID,
    workload_id     UUID,
    duration_sec    INTEGER,
    quality         REAL,
    reason          TEXT,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_shadow       BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE we_reputation_events IS 'NCE 信誉事件流水 · 数据驱动调参 + 节点端事件明细';
COMMENT ON COLUMN we_reputation_events.is_shadow IS '影子模式标记 · TRUE = 算了但没改实际信誉';

CREATE INDEX IF NOT EXISTS we_rep_events_worker_idx 
    ON we_reputation_events (worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_rep_events_type_idx
    ON we_reputation_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS we_rep_events_task_idx 
    ON we_reputation_events (task_type, event_type) WHERE task_type IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. we_hw_score_history · 硬件评分历史 (劣化识别基础)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_hw_score_history (
    id              BIGSERIAL    PRIMARY KEY,
    worker_id       UUID         NOT NULL,
    hw_tier         VARCHAR(2)   NOT NULL,
    hw_score        REAL         NOT NULL,
    sub_scores      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    trigger         VARCHAR(40)  NOT NULL DEFAULT 'cron',
    capabilities_snapshot JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE we_hw_score_history IS 'NCE 硬件评分历史 · 用于趋势分析 / 劣化识别 / 申诉证据';
COMMENT ON COLUMN we_hw_score_history.sub_scores IS '细分: {cpu, ram, gpu, network, storage}';
COMMENT ON COLUMN we_hw_score_history.trigger IS 'cron / onboard / admin_manual / capability_change';

CREATE INDEX IF NOT EXISTS we_hw_history_worker_idx 
    ON we_hw_score_history (worker_id, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════════
-- 5. we_planner_decisions · 派单决策审计 (影子模式 + 灰度对照核心)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_planner_decisions (
    id              BIGSERIAL    PRIMARY KEY,
    shard_id        UUID         NOT NULL,
    workload_id     UUID         NOT NULL,
    task_type       VARCHAR(40),
    -- 算法版本
    algo_version    VARCHAR(20)  NOT NULL,
    -- 选中的节点
    chosen_worker_id UUID,
    chosen_score    REAL,
    -- 候选池摘要 (Top 5)
    candidates      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- 影子模式: 新算法选了谁 vs 旧算法实际派的
    shadow_chosen_id UUID,
    shadow_score    REAL,
    match_old       BOOLEAN,
    -- 性能
    decision_ms     INTEGER,
    candidate_count INTEGER,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE we_planner_decisions IS 'NCE 派单决策审计 · 灰度对照 + 性能分析 + 客诉追溯';
COMMENT ON COLUMN we_planner_decisions.match_old IS '影子模式: TRUE = 新旧算法选了同一节点';

CREATE INDEX IF NOT EXISTS we_planner_dec_workload_idx 
    ON we_planner_decisions (workload_id, created_at);
CREATE INDEX IF NOT EXISTS we_planner_dec_algo_idx 
    ON we_planner_decisions (algo_version, created_at DESC);


-- ════════════════════════════════════════════════════════════════════════════
-- 6. Backfill · 给现有 13 个节点补值 (覆盖 ALTER DEFAULT 漏掉的列)
-- ════════════════════════════════════════════════════════════════════════════

-- ALTER ADD COLUMN ... DEFAULT 已经会给老行填值
-- 这里再做一次显式 backfill 以防万一 · 同时记一次 history
UPDATE we_workers 
SET 
    hw_tier         = COALESCE(hw_tier, 'B'),
    hw_score        = COALESCE(hw_score, 50.0),
    rep_stability   = COALESCE(rep_stability, 60),
    rep_correctness = COALESCE(rep_correctness, 60),
    rep_speed       = COALESCE(rep_speed, 60),
    rep_resource    = COALESCE(rep_resource, 60),
    rep_main        = COALESCE(rep_main, 60),
    onboarding_status = COALESCE(onboarding_status, 'active'),
    hw_evaluated_at = COALESCE(hw_evaluated_at, NOW()),
    rep_updated_at  = COALESCE(rep_updated_at, NOW())
WHERE hw_tier IS NULL 
   OR rep_main IS NULL 
   OR onboarding_status IS NULL;

-- 给现有节点写一条 hw_score 历史 (trigger=phase0_backfill)
INSERT INTO we_hw_score_history (worker_id, hw_tier, hw_score, sub_scores, trigger)
SELECT 
    id, 
    hw_tier, 
    hw_score, 
    '{"note":"phase0_backfill_default"}'::jsonb,
    'phase0_backfill'
FROM we_workers
WHERE NOT EXISTS (
    SELECT 1 FROM we_hw_score_history h WHERE h.worker_id = we_workers.id
);


-- ════════════════════════════════════════════════════════════════════════════
-- 7. 收尾 · 打印验证信息
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    worker_count INT;
    flag_count INT;
    history_count INT;
BEGIN
    SELECT COUNT(*) INTO worker_count FROM we_workers WHERE hw_tier IS NOT NULL;
    SELECT COUNT(*) INTO flag_count FROM we_feature_flags WHERE flag_name LIKE 'nce_%';
    SELECT COUNT(*) INTO history_count FROM we_hw_score_history WHERE trigger = 'phase0_backfill';
    
    RAISE NOTICE '════════════════════════════════════════════════════════════';
    RAISE NOTICE '  NCE Phase 0 migration · 完成';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
    RAISE NOTICE '  已补值节点数:       %', worker_count;
    RAISE NOTICE '  NCE feature flag 数: % (全部 OFF)', flag_count;
    RAISE NOTICE '  hw_score 历史记录数: %', history_count;
    RAISE NOTICE '────────────────────────────────────────────────────────────';
    RAISE NOTICE '  下一步: ';
    RAISE NOTICE '    1. 验证 \\d we_workers (看新字段)';
    RAISE NOTICE '    2. SELECT * FROM we_feature_flags WHERE flag_name LIKE ''nce_%%''';
    RAISE NOTICE '    3. 等 Cascade 进 P1 (改 planner.py)';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
END$$;

COMMIT;
