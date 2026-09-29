-- v8_029_timezone_utc_rollback.sql · 2026-06-07
--
-- 回滚 v8_029:把所有 backfill 的 timestamptz 列向后偏移 +8h,还原"+08 错误"状态。
-- 同时 **必须** 回退 platform_v8/storage/db.py 的 `SET TIME ZONE 'UTC'` event listener。
-- 仅在新数据已被 UTC 正确写入但需回到旧状态时使用 — 通常不需要。

BEGIN;

UPDATE we_workers
   SET last_seen = last_seen + INTERVAL '8 hours'
 WHERE last_seen IS NOT NULL;
UPDATE we_workers SET registered_at = registered_at + INTERVAL '8 hours';
UPDATE we_workers SET hw_evaluated_at = hw_evaluated_at + INTERVAL '8 hours' WHERE hw_evaluated_at IS NOT NULL;
UPDATE we_workers SET rep_updated_at = rep_updated_at + INTERVAL '8 hours' WHERE rep_updated_at IS NOT NULL;

UPDATE we_workloads
   SET created_at = created_at + INTERVAL '8 hours',
       updated_at = updated_at + INTERVAL '8 hours'
 WHERE created_at > '2026-04-01';
UPDATE we_workloads SET started_at = started_at + INTERVAL '8 hours' WHERE started_at IS NOT NULL AND started_at > '2026-04-01';
UPDATE we_workloads SET completed_at = completed_at + INTERVAL '8 hours' WHERE completed_at IS NOT NULL AND completed_at > '2026-04-01';

UPDATE we_shards SET dispatched_at = dispatched_at + INTERVAL '8 hours' WHERE dispatched_at IS NOT NULL AND dispatched_at > '2026-04-01';
UPDATE we_shards SET started_at = started_at + INTERVAL '8 hours' WHERE started_at IS NOT NULL AND started_at > '2026-04-01';
UPDATE we_shards SET completed_at = completed_at + INTERVAL '8 hours' WHERE completed_at IS NOT NULL AND completed_at > '2026-04-01';
UPDATE we_shards SET lease_expires_at = lease_expires_at + INTERVAL '8 hours' WHERE lease_expires_at IS NOT NULL;

UPDATE we_accounts
   SET created_at = created_at + INTERVAL '8 hours',
       updated_at = updated_at + INTERVAL '8 hours';
UPDATE we_accounts SET last_login_at = last_login_at + INTERVAL '8 hours' WHERE last_login_at IS NOT NULL;

UPDATE we_ledger SET created_at = created_at + INTERVAL '8 hours';

UPDATE we_audit SET created_at = created_at + INTERVAL '8 hours' WHERE created_at > '2026-04-01';

COMMIT;
