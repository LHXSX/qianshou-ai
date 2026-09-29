-- ════════════════════════════════════════════════════════════════
-- v8_012 · we_workloads 加 spent 字段 (W2 + W3 共用)
-- 2026-05-26
--
-- 背景:
--   W2 GEO 监测 (orders.py / admin_geo.py) 用 w.spent 查"已花" → PG 报列不存在
--   W3 IP 代理池 close_session 时要累加 spent (per byte 计费)
--   两业务都需要 · 一次加上
--
-- 设计:
--   - spent NUMERIC(18,4) NOT NULL DEFAULT 0 (跟 budget 同精度)
--   - 业务 increment 用 UPDATE ... SET spent = spent + :delta (并发安全)
--   - admin/客户列表/详情查 budget + spent → 算剩余
-- ════════════════════════════════════════════════════════════════

ALTER TABLE we_workloads
    ADD COLUMN IF NOT EXISTS spent NUMERIC(18,4) NOT NULL DEFAULT 0;

-- 高 spent 查询索引 (admin 看 top 消耗任务)
CREATE INDEX IF NOT EXISTS idx_workloads_spent
    ON we_workloads (owner_id, spent DESC)
    WHERE spent > 0;

COMMENT ON COLUMN we_workloads.spent IS 'session 业务累加结算 / oneshot 业务任务结束写一次 · 跟 budget 配对算余额';
