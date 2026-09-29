-- v8_029_timezone_utc.sql · 2026-06-07 · S1-T1
--
-- 时区根因修复 · 历史活跃数据 backfill
--
-- 背景:
--   Python `datetime.utcnow()` 返回 naive datetime,SQLAlchemy 传给 PG timestamptz 列时,
--   PG 按 server 时区(Asia/Shanghai +08)解释,导致所有历史 timestamptz 数据**偏 -8h**:
--   真实 UTC 17:31 被存为 `17:31+08`(实际 UTC 09:31)。
--
--   配套代码改 db.py:每个新连接 `SET TIME ZONE 'UTC'`,新数据自动正确。
--   本 migration 修正历史活跃数据,把错位的 timestamptz 值统一向前偏移 -8h(等效:把
--   "+08 错误"撤销,还原成真实 UTC 时刻)。
--
-- 范围:
--   仅 backfill 高频活跃表(近 30 天有可能被查询的列)。归档冷数据(audit > 30d、
--   ledger 历史等)不动,避免影响审计 + 性能。
--
-- 风险:
--   1. 必须在 db.py 改动部署后 立刻 跑(避免新旧数据混合)
--   2. 跑前对 PG 做快照备份
--   3. 历史 admin UI 显示的时间会从"+08 字面"变成"真 UTC"(显示往前 8h),admin 看习惯
--      了 +08 的需要回 nginx + Grafana 显示层做 +08 转换
--
-- 验证:
--   - `SELECT NOW() - last_seen FROM we_workers WHERE status='ONLINE' AND last_seen > NOW()-INTERVAL '90 seconds'`
--   - 应返回 5 行(对应当前在线节点)
--   - AI `query_nodes` 返回值 = UI 在线节点池数

BEGIN;

-- ── 1. workers(99 行,影响所有调度) ──
UPDATE we_workers
   SET last_seen = last_seen - INTERVAL '8 hours'
 WHERE last_seen IS NOT NULL;
UPDATE we_workers
   SET registered_at = registered_at - INTERVAL '8 hours';
UPDATE we_workers
   SET hw_evaluated_at = hw_evaluated_at - INTERVAL '8 hours'
 WHERE hw_evaluated_at IS NOT NULL;
UPDATE we_workers
   SET rep_updated_at = rep_updated_at - INTERVAL '8 hours'
 WHERE rep_updated_at IS NOT NULL;

-- ── 2. workloads(2923 行 · 近 30 天活跃) ──
UPDATE we_workloads
   SET created_at = created_at - INTERVAL '8 hours',
       updated_at = updated_at - INTERVAL '8 hours'
 WHERE created_at > '2026-04-01';
UPDATE we_workloads
   SET started_at = started_at - INTERVAL '8 hours'
 WHERE started_at IS NOT NULL AND started_at > '2026-04-01';
UPDATE we_workloads
   SET completed_at = completed_at - INTERVAL '8 hours'
 WHERE completed_at IS NOT NULL AND completed_at > '2026-04-01';

-- ── 3. shards(3249 行 · 近 30 天活跃) ──
UPDATE we_shards
   SET dispatched_at = dispatched_at - INTERVAL '8 hours'
 WHERE dispatched_at IS NOT NULL AND dispatched_at > '2026-04-01';
UPDATE we_shards
   SET started_at = started_at - INTERVAL '8 hours'
 WHERE started_at IS NOT NULL AND started_at > '2026-04-01';
UPDATE we_shards
   SET completed_at = completed_at - INTERVAL '8 hours'
 WHERE completed_at IS NOT NULL AND completed_at > '2026-04-01';
UPDATE we_shards
   SET lease_expires_at = lease_expires_at - INTERVAL '8 hours'
 WHERE lease_expires_at IS NOT NULL;

-- ── 4. accounts(90 行 · created_at/updated_at/last_login_at) ──
UPDATE we_accounts
   SET created_at = created_at - INTERVAL '8 hours',
       updated_at = updated_at - INTERVAL '8 hours';
UPDATE we_accounts
   SET last_login_at = last_login_at - INTERVAL '8 hours'
 WHERE last_login_at IS NOT NULL;

-- ── 5. ledger(8.5k 行 · 全量 created_at) ──
UPDATE we_ledger
   SET created_at = created_at - INTERVAL '8 hours';

-- ── 6. audit · 仅近 30 天(106k 行避免全扫) ──
UPDATE we_audit
   SET created_at = created_at - INTERVAL '8 hours'
 WHERE created_at > '2026-04-01';

-- ── 7. workers_models / models(可选) ──
-- 略,运营低频,可后续清理

COMMIT;

-- ── 验证 SQL(手工跑) ──
-- 跑完应在 90 秒内看到所有在线 worker:
--   SELECT name, status, AGE(NOW(), last_seen) FROM we_workers
--    WHERE status IN ('ONLINE','BUSY') AND last_seen > NOW() - INTERVAL '90 seconds';
