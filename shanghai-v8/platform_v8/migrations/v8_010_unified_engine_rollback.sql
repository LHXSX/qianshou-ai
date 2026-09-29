-- v8_010_unified_engine_rollback.sql · 2026-05-26 W1 Phase B 回滚
--
-- 用途: W1 上线出问题 · 1 分钟回滚到 W0 状态
-- 安全: 删字段/索引前先确认 mode='oneshot' 的占比 (否则可能丢 PULL/SESSION shard 数据)
--
-- 检查 (回滚前必跑):
--   SELECT mode, COUNT(*) FROM we_shards GROUP BY mode;
--   如果 pull/session 非 0 · 必须先把这些业务流量切到旁路 · 才能回滚

BEGIN;

-- ────────── 1. 把 LEASED 状态强转回 PENDING (回滚前清理 PULL 在跑状态) ──────────
UPDATE we_shards
SET status = 'PENDING',
    lease_by_node = NULL,
    lease_expires_at = NULL
WHERE status = 'LEASED';

-- ────────── 2. 删索引 ──────────
DROP INDEX IF EXISTS idx_shards_pull_pending;
DROP INDEX IF EXISTS idx_shards_lease_expires;
DROP INDEX IF EXISTS idx_shards_lease_by_node;

-- ────────── 3. 删字段 ──────────
ALTER TABLE we_shards DROP COLUMN IF EXISTS mode;
ALTER TABLE we_shards DROP COLUMN IF EXISTS lease_by_node;
ALTER TABLE we_shards DROP COLUMN IF EXISTS lease_expires_at;

COMMIT;

-- 提示: 回滚后必须重启 backend (重新载 enum 定义)
-- 提示: ShardStatus.LEASED 仍在代码里 · 但 DB 已经没这个值 · 不会触发
