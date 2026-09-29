-- v8_053 rollback · QS-16 · 停写：只删触发器与函数。
-- 表 we_shard_events 与已有行 **保留**（上册 §2.2 增-3：一旦有了这张表就不要再删，否则历史断档）。
-- 真要删表是另一次有人签字的操作，不在本文件里。
BEGIN;
DROP TRIGGER IF EXISTS we_shards_transition_trg ON we_shards;
DROP TRIGGER IF EXISTS we_shards_created_trg    ON we_shards;
DROP FUNCTION IF EXISTS we_shards_log_transition();
-- 保留 we_shard_events_immutable_trg：表既然留着，就继续 append-only。
DELETE FROM we_schema_migrations WHERE version = 'v8_053_shard_events.sql';
COMMIT;
