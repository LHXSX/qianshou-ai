-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · NCE Phase 0 · 回滚脚本
--
-- 配套: v8_004_nce_phase0.sql
-- 日期: 2026-05-25
--
-- 🚨 使用前提:
--   - 仅在 Phase 0 上线后 24h 内、未启用任何 NCE feature flag 时使用
--   - 启用 flag 后 (尤其 nce_planner_use_reputation) · 不能简单回滚
--     · 因为 Python 代码已读 hw_tier · 字段没了会报错
--   - 必须先把所有 nce_* flag 设为 enabled=FALSE 再回滚
--
-- 数据安全:
--   - 回滚会删除 we_workers 上的 NCE 字段 (数据丢)
--   - 删除 we_feature_flags / we_reputation_events / we_hw_score_history /
--     we_planner_decisions 4 张新表
--   - 不动 reputation / capability_score 等老字段
--
-- 使用方法:
--   1. 关所有 flag: UPDATE we_feature_flags SET enabled=FALSE WHERE flag_name LIKE 'nce_%';
--   2. 重启 backend (确保 Python 没缓存 flag)
--   3. psql -U admin -d edge_compute -f platform_v8/migrations/v8_004_nce_phase0_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. 关所有 NCE flag (防 Python 还在用) ──────────────────────────────
UPDATE we_feature_flags 
SET enabled = FALSE, rollout_pct = 0, updated_at = NOW(), updated_by = 'rollback'
WHERE flag_name LIKE 'nce_%';

-- ─── 2. 删 NCE 字段 (we_workers) ─────────────────────────────────────────
ALTER TABLE we_workers DROP COLUMN IF EXISTS hw_tier;
ALTER TABLE we_workers DROP COLUMN IF EXISTS hw_score;
ALTER TABLE we_workers DROP COLUMN IF EXISTS hw_evaluated_at;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_stability;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_correctness;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_speed;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_resource;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_main;
ALTER TABLE we_workers DROP COLUMN IF EXISTS rep_updated_at;
ALTER TABLE we_workers DROP COLUMN IF EXISTS onboarding_status;
ALTER TABLE we_workers DROP COLUMN IF EXISTS probation_started_at;
ALTER TABLE we_workers DROP COLUMN IF EXISTS probation_graduated_at;
ALTER TABLE we_workers DROP COLUMN IF EXISTS pending_tier;
ALTER TABLE we_workers DROP COLUMN IF EXISTS pending_at;
ALTER TABLE we_workers DROP COLUMN IF EXISTS pending_reason;

-- 删 NCE 索引 (有些会随 column 自动删 · 加 IF EXISTS 防错)
DROP INDEX IF EXISTS we_workers_hw_tier_idx;
DROP INDEX IF EXISTS we_workers_dispatch_v2_idx;

-- ─── 3. 删 NCE 表 (倒序删 · 防外键问题) ─────────────────────────────────
DROP TABLE IF EXISTS we_planner_decisions   CASCADE;
DROP TABLE IF EXISTS we_hw_score_history    CASCADE;
DROP TABLE IF EXISTS we_reputation_events   CASCADE;
DROP TABLE IF EXISTS we_feature_flags       CASCADE;

-- ─── 4. 收尾 ────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE '════════════════════════════════════════════════════════════';
    RAISE NOTICE '  NCE Phase 0 · 回滚完成';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
    RAISE NOTICE '  系统已恢复到 NCE Phase 0 上线前状态';
    RAISE NOTICE '  老链路 (reputation / capability_score / planner) 完全不动';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
END$$;

COMMIT;
