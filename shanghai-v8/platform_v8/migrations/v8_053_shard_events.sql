-- v8_053 · QS-16 · shard 级不可变事件表 + we_shards 转移触发器
-- 目的：回答「这一片派给谁 / 换过几次节点 / 何时被回收 / 为什么失败」——今天 we_shards 只有终值 worker_id，无历史。
-- 形态：append-only 专表（上册 §2.2 增-3 裁定，不塞 we_audit）。写入点 = we_shards 的状态/归属转移（触发器覆盖 repo.py 全部 24 处 UPDATE）。
-- 不变量：本表只 INSERT；UPDATE/DELETE 被触发器拒绝。一旦上线不要 DROP TABLE（历史断档）；停写 = 跑 _rollback（只删触发器）。
-- 成本：we_shards 44 天 26,279 次 UPDATE（≈600/天），WHEN 过滤掉 progress_at 心跳后更少。
BEGIN;

CREATE TABLE IF NOT EXISTS we_shard_events (
    id           BIGSERIAL PRIMARY KEY,
    shard_id     UUID        NOT NULL,
    workload_id  UUID        NOT NULL,
    action       VARCHAR(32) NOT NULL,   -- shard.created | shard.dispatch | shard.reassign | shard.reclaim | shard.retry
                                         -- | shard.done | shard.failed | shard.cancelled | shard.transition | shard.late_result(QS-20 应用侧)
    from_status  VARCHAR(20),
    to_status    VARCHAR(20),
    from_worker  UUID,                   -- COALESCE(OLD.worker_id, OLD.lease_by_node)：oneshot 与 pull 两种归属统一
    to_worker    UUID,                   -- COALESCE(NEW.worker_id, NEW.lease_by_node)
    attempt      INTEGER,                -- NEW.attempts
    reason_code  VARCHAR(64),            -- 变化了的 failure_class；应用侧事件自带
    detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source       VARCHAR(16) NOT NULL DEFAULT 'trigger',   -- trigger | app
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 无 FK：we_shards 随 we_workloads ON DELETE CASCADE；事件必须活过它们。

CREATE INDEX IF NOT EXISTS we_shard_events_shard_time_idx  ON we_shard_events (shard_id, created_at);
CREATE INDEX IF NOT EXISTS we_shard_events_action_time_idx ON we_shard_events (action, created_at DESC);
CREATE INDEX IF NOT EXISTS we_shard_events_to_worker_idx   ON we_shard_events (to_worker, created_at DESC) WHERE to_worker IS NOT NULL;
CREATE INDEX IF NOT EXISTS we_shard_events_workload_idx    ON we_shard_events (workload_id);

-- append-only 落实到库层
CREATE OR REPLACE FUNCTION we_shard_events_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'we_shard_events is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER IF EXISTS we_shard_events_immutable_trg ON we_shard_events;
CREATE TRIGGER we_shard_events_immutable_trg
    BEFORE UPDATE OR DELETE ON we_shard_events
    FOR EACH ROW EXECUTE FUNCTION we_shard_events_reject_mutation();

-- we_shards → 事件
CREATE OR REPLACE FUNCTION we_shards_log_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_from_worker UUID;
    v_to_worker   UUID := COALESCE(NEW.worker_id, NEW.lease_by_node);
    v_action      TEXT;
    v_reason      TEXT;
    v_detail      JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO we_shard_events (shard_id, workload_id, action, from_status, to_status, from_worker, to_worker, attempt, reason_code, detail)
        VALUES (NEW.id, NEW.workload_id, 'shard.created', NULL, NEW.status, NULL, v_to_worker, NEW.attempts, NULL,
                jsonb_build_object('mode', NEW.mode, 'index', NEW.index, 'total', NEW.total, 'max_attempts', NEW.max_attempts));
        RETURN NULL;
    END IF;

    v_from_worker := COALESCE(OLD.worker_id, OLD.lease_by_node);
    IF NEW.status = 'DONE' AND OLD.status <> 'DONE' THEN
        v_action := 'shard.done';
    ELSIF NEW.status = 'FAILED' AND OLD.status <> 'FAILED' THEN
        v_action := 'shard.failed';
    ELSIF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' THEN
        v_action := 'shard.cancelled';
    ELSIF v_from_worker IS NOT NULL AND v_to_worker IS NOT NULL AND v_from_worker <> v_to_worker THEN
        v_action := 'shard.reassign';   -- 换人：第一次成为可查询的动作
    ELSIF v_from_worker IS NULL AND v_to_worker IS NOT NULL THEN
        v_action := 'shard.dispatch';
    ELSIF v_from_worker IS NOT NULL AND v_to_worker IS NULL THEN
        v_action := 'shard.reclaim';    -- reset_pending / release_lease / reaper 清归属
    ELSIF NEW.attempts > OLD.attempts THEN
        v_action := 'shard.retry';
    ELSE
        v_action := 'shard.transition'; -- 仅 status 变（PENDING→RUNNING→VERIFYING 等）
    END IF;

    v_reason := CASE WHEN NEW.failure_class IS DISTINCT FROM OLD.failure_class THEN NEW.failure_class END;
    v_detail := jsonb_strip_nulls(jsonb_build_object(
        'mode', NEW.mode,
        'attempts_delta', NEW.attempts - OLD.attempts,
        'lease_expires_at', NEW.lease_expires_at,
        'error', CASE WHEN NEW.error <> '' AND NEW.error IS DISTINCT FROM OLD.error THEN left(NEW.error, 200) END
    ));
    INSERT INTO we_shard_events (shard_id, workload_id, action, from_status, to_status, from_worker, to_worker, attempt, reason_code, detail)
    VALUES (NEW.id, NEW.workload_id, v_action, OLD.status, NEW.status, v_from_worker, v_to_worker, NEW.attempts, v_reason, v_detail);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS we_shards_created_trg ON we_shards;
CREATE TRIGGER we_shards_created_trg
    AFTER INSERT ON we_shards
    FOR EACH ROW EXECUTE FUNCTION we_shards_log_transition();

DROP TRIGGER IF EXISTS we_shards_transition_trg ON we_shards;
CREATE TRIGGER we_shards_transition_trg
    AFTER UPDATE ON we_shards
    FOR EACH ROW
    WHEN (OLD.status        IS DISTINCT FROM NEW.status
       OR OLD.worker_id     IS DISTINCT FROM NEW.worker_id
       OR OLD.lease_by_node IS DISTINCT FROM NEW.lease_by_node
       OR OLD.attempts      IS DISTINCT FROM NEW.attempts)
    EXECUTE FUNCTION we_shards_log_transition();

COMMIT;
