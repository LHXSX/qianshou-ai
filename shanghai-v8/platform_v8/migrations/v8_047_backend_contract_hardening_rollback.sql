-- v8_047 rollback · remove durable verification contracts
--
-- This rollback refuses to coerce states that the previous constraints cannot
-- represent.  Drain/reconcile those rows explicitly before retrying.

BEGIN;

LOCK TABLE we_workloads, we_shards IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM we_workloads
        WHERE status IN ('NORMALIZING', 'QUARANTINED')
    ) THEN
        RAISE EXCEPTION
            'v8_047 rollback refused: workloads still use NORMALIZING/QUARANTINED';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM we_shards
        WHERE status IN ('LEASED', 'VERIFYING')
    ) THEN
        RAISE EXCEPTION
            'v8_047 rollback refused: shards still use LEASED/VERIFYING';
    END IF;
END
$$;

DROP TABLE IF EXISTS we_result_verifications;
DROP TABLE IF EXISTS we_verifier_circuits;

DROP INDEX IF EXISTS we_workloads_normalizing_recovery_idx;
ALTER TABLE we_shards DROP COLUMN IF EXISTS progress_at;

ALTER TABLE we_workloads
    DROP CONSTRAINT IF EXISTS we_workloads_status_chk;
ALTER TABLE we_workloads
    ADD CONSTRAINT we_workloads_status_chk CHECK (
        status IN (
            'CREATED', 'PLANNED', 'RUNNING', 'AGGREGATING', 'DONE',
            'FAILED', 'CANCELLED', 'WAITING_FOR_WORKERS'
        )
    );

ALTER TABLE we_shards
    DROP CONSTRAINT IF EXISTS we_shards_status_chk;
ALTER TABLE we_shards
    ADD CONSTRAINT we_shards_status_chk CHECK (
        status IN (
            'PENDING', 'DISPATCHED', 'RUNNING', 'DONE', 'FAILED',
            'CANCELLED'
        )
    );

-- spent is not reversed: v8_047 only copied an authoritative
-- ESCROW_RELEASE.metadata.actual_spend into previously-zero DONE ONESHOT rows.
-- Re-zeroing it would discard valid accounting state.

COMMIT;
