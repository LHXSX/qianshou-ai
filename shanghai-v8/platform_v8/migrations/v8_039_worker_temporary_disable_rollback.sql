BEGIN;

DROP INDEX IF EXISTS we_workers_disabled_until_idx;

ALTER TABLE we_workers
    DROP COLUMN IF EXISTS disabled_reason,
    DROP COLUMN IF EXISTS disabled_by,
    DROP COLUMN IF EXISTS disabled_at,
    DROP COLUMN IF EXISTS disabled_until;

COMMIT;
