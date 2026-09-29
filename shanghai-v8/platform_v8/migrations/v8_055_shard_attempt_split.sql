-- v8_055 · W-05 · we_shards 加可空 dispatch_attempts / exec_attempts
-- 加法：旧行保持 NULL（从未按新语义计过）。attempts / max_attempts 列定义一字不动。
-- 回滚：停写这两列（代码回 orig）；列可留——DROP COLUMN 会改表形，本单不做。

BEGIN;

ALTER TABLE we_shards ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER;
ALTER TABLE we_shards ADD COLUMN IF NOT EXISTS exec_attempts INTEGER;

COMMIT;
