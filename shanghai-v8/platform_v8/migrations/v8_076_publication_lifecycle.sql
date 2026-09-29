-- Keep signed submissions, entitlements, installs and financial audit immutable.
CREATE TABLE IF NOT EXISTS we_task_adapter_publication_lifecycle (
    publication_id VARCHAR(36) PRIMARY KEY REFERENCES we_task_adapter_publications(id),
    state VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (state IN ('active','withdrawn','delisted')),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS we_task_adapter_publication_lifecycle_visibility_idx
    ON we_task_adapter_publication_lifecycle (state,archived);
-- Rollback: restore previous code first. Retain this sidecar table and its audit
-- rows; dropping it would erase the owner's withdrawal and reopen hidden items.
