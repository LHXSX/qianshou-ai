-- This rollback is deliberately non-destructive. It refuses to restore the
-- old single-seller constraint if more than one approved seller exists.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM we_task_adapter_publications
        WHERE status = 'approved'
        GROUP BY task_type HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot restore single-publisher index while multiple approved publications exist';
    END IF;
END $$;

DROP INDEX IF EXISTS we_task_adapter_publications_approved_task_owner_idx;
CREATE UNIQUE INDEX IF NOT EXISTS we_task_adapter_publications_one_approved_task_uq
    ON we_task_adapter_publications (task_type) WHERE status = 'approved';
