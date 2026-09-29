-- v8_010_unified_engine.sql · 2026-05-26 W1 Phase B
-- 
-- 统一引擎重构 · 给 we_shards 加调度模式 + PULL 模式 lease 字段
-- 配套 platform_v8/core/enums.py 的 ShardMode + ShardStatus.LEASED
-- 
-- 跨业务模型:
--   - mode=oneshot  · 现有 53 task · broker push (向后兼容 · default)
--   - mode=session  · IP 代理 / CDN · session_dispatcher.open_tunnel
--   - mode=pull     · 爬虫 / GEO · 节点抢 (FOR UPDATE SKIP LOCKED)
-- 
-- 安全保证:
--   - 所有列 ADD COLUMN IF NOT EXISTS · 重复跑无害
--   - DEFAULT 'oneshot' 让现有 53 task 零回归
--   - 索引仅为 mode=pull AND status=pending 的 hot path 建 (体积小)
-- 
-- 回滚: v8_010_unified_engine_rollback.sql

BEGIN;

-- ────────── 1. we_shards 加 3 列 ──────────
ALTER TABLE we_shards
    ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'oneshot';

ALTER TABLE we_shards
    ADD COLUMN IF NOT EXISTS lease_by_node UUID;

ALTER TABLE we_shards
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- ────────── 2. 索引 ──────────
-- 索引 A: PULL 模式 hot path (节点 lease 时频繁查这个)
-- 部分索引 · 只索引 mode=pull AND status=pending · 体积小
CREATE INDEX IF NOT EXISTS idx_shards_pull_pending
    ON we_shards (mode, status, score DESC)
    WHERE mode = 'pull' AND status = 'PENDING';

-- 索引 B: lease 超时 reaper 用 (找过期 LEASED)
CREATE INDEX IF NOT EXISTS idx_shards_lease_expires
    ON we_shards (lease_expires_at)
    WHERE status = 'LEASED' AND lease_expires_at IS NOT NULL;

-- 索引 C: 按 lease_by_node 查 (节点端"我在跑什么" / admin "节点积压")
CREATE INDEX IF NOT EXISTS idx_shards_lease_by_node
    ON we_shards (lease_by_node)
    WHERE lease_by_node IS NOT NULL;

-- ────────── 3. 注释 ──────────
COMMENT ON COLUMN we_shards.mode IS '调度模式 oneshot/session/pull · W1 引入 · default oneshot 向后兼容';
COMMENT ON COLUMN we_shards.lease_by_node IS 'PULL 模式 · 当前 lease 的节点 ID (worker_id)';
COMMENT ON COLUMN we_shards.lease_expires_at IS 'PULL 模式 · lease 过期时刻 · 过期未跑则回 PENDING';

-- ────────── 4. 默认 task_type → mode 映射回填 (可选 · 慢启动) ──────────
-- 现有 we_workloads 全部 spec.task_type 都属于 ONESHOT (mode=oneshot 已是 default)
-- 之后的爬虫 / GEO / IP 代理由业务模块在创建 shard 时显式 set mode

COMMIT;

-- ════════════════════════════════════════════════════════════════
-- 验证
-- ════════════════════════════════════════════════════════════════
-- 检查列已加 + default 正确:
--   \d+ we_shards
--   SELECT mode, COUNT(*) FROM we_shards GROUP BY mode;
-- 
-- 检查索引已建:
--   \di we_shards*
-- 
-- 检查现有数据不破:
--   SELECT id, status, mode, lease_by_node, lease_expires_at 
--   FROM we_shards LIMIT 5;
