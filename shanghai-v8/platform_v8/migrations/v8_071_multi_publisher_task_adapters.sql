-- A task type is a customer-facing capability, not a single seller slot.
-- Every approved publication remains individually bound to its author,
-- signed package, reviewed contract and runtime digest. Worker admission
-- selects the exact publication installed on that device.
DROP INDEX IF EXISTS we_task_adapter_publications_one_approved_task_uq;

CREATE INDEX IF NOT EXISTS we_task_adapter_publications_approved_task_owner_idx
    ON we_task_adapter_publications (task_type, owner_id, reviewed_at DESC)
    WHERE status = 'approved';
