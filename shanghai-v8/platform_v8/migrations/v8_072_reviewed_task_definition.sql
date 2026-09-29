-- Machine-readable candidate contract comes from a signed source package.
-- It is only a proposal until independent package, sample and contract review.
ALTER TABLE we_task_adapter_publications
    ADD COLUMN IF NOT EXISTS task_definition JSONB;
