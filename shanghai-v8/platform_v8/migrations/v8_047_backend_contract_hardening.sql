-- v8_047 · durable backend state and verification contracts
--
-- This migration is deliberately PostgreSQL-only.  Application tests mirror
-- the objects with SQLAlchemy metadata and SQLite; production schema changes
-- continue to be applied only through migrations.

BEGIN;

-- Keep database constraints aligned with the complete Python enums.  Dropping
-- and recreating the named constraints is idempotent and also repairs installs
-- where an older migration left the original v8_001 definition in place.
ALTER TABLE we_workloads
    DROP CONSTRAINT IF EXISTS we_workloads_status_chk;
ALTER TABLE we_workloads
    ADD CONSTRAINT we_workloads_status_chk CHECK (
        status IN (
            'NORMALIZING', 'CREATED', 'PLANNED', 'RUNNING', 'AGGREGATING',
            'DONE', 'QUARANTINED', 'FAILED', 'CANCELLED',
            'WAITING_FOR_WORKERS'
        )
    );

ALTER TABLE we_shards
    DROP CONSTRAINT IF EXISTS we_shards_status_chk;
ALTER TABLE we_shards
    ADD CONSTRAINT we_shards_status_chk CHECK (
        status IN (
            'PENDING', 'DISPATCHED', 'LEASED', 'RUNNING', 'VERIFYING',
            'DONE', 'FAILED', 'CANCELLED'
        )
    );

ALTER TABLE we_shards
    ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ;

COMMENT ON COLUMN we_shards.progress_at IS
    'Latest durable worker progress/heartbeat timestamp; cleared on reassignment';

-- Archive normalization recovery scans only this small durable queue.
CREATE INDEX IF NOT EXISTS we_workloads_normalizing_recovery_idx
    ON we_workloads (created_at, id)
    WHERE status = 'NORMALIZING';

CREATE TABLE IF NOT EXISTS we_result_verifications (
    id                BIGSERIAL PRIMARY KEY,
    shard_id          UUID         NOT NULL
        REFERENCES we_shards(id) ON DELETE CASCADE,
    workload_id       UUID         NOT NULL
        REFERENCES we_workloads(id) ON DELETE CASCADE,
    worker_id         UUID
        REFERENCES we_workers(id) ON DELETE SET NULL,
    attempt           INTEGER      NOT NULL,
    requested_policy  VARCHAR(40)  NOT NULL,
    state             VARCHAR(24)  NOT NULL DEFAULT 'PENDING',
    disposition       VARCHAR(40),
    verifier_key      VARCHAR(160) NOT NULL,
    content_sha256    VARCHAR(64),
    artifact          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    evidence          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    retry_count       INTEGER      NOT NULL DEFAULT 0,
    max_retries       INTEGER      NOT NULL DEFAULT 3,
    next_retry_at     TIMESTAMPTZ,
    lease_until       TIMESTAMPTZ,
    error             TEXT         NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT we_result_verifications_shard_attempt_uq
        UNIQUE (shard_id, attempt),
    CONSTRAINT we_result_verifications_attempt_chk
        CHECK (attempt >= 0),
    CONSTRAINT we_result_verifications_state_chk
        CHECK (state IN (
            'PENDING', 'LEASED', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED'
        )),
    CONSTRAINT we_result_verifications_retry_chk
        CHECK (
            retry_count >= 0
            AND max_retries >= 0
            AND retry_count <= max_retries
        ),
    CONSTRAINT we_result_verifications_digest_chk
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT we_result_verifications_policy_chk
        CHECK (requested_policy IN ('semantic', 'artifact', 'quarantine')),
    CONSTRAINT we_result_verifications_disposition_chk
        CHECK (
            disposition IS NULL OR disposition IN (
                'VERIFIED', 'ARTIFACT_VERIFIED', 'QUARANTINED',
                'REJECTED', 'INFRASTRUCTURE_FAILED'
            )
        ),
    CONSTRAINT we_result_verifications_success_chk
        CHECK (
            state <> 'SUCCEEDED' OR (
                content_sha256 IS NOT NULL
                AND (
                    (requested_policy = 'semantic' AND disposition = 'VERIFIED')
                    OR (
                        requested_policy = 'artifact'
                        AND disposition = 'ARTIFACT_VERIFIED'
                    )
                )
            )
        )
);

-- CREATE TABLE IF NOT EXISTS does not repair constraints on an interrupted
-- prior run, so re-assert the settlement checks explicitly.
ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_policy_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_policy_chk
    CHECK (requested_policy IN ('semantic', 'artifact', 'quarantine'));
ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_disposition_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_disposition_chk
    CHECK (
        disposition IS NULL OR disposition IN (
            'VERIFIED', 'ARTIFACT_VERIFIED', 'QUARANTINED',
            'REJECTED', 'INFRASTRUCTURE_FAILED'
        )
    );
ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_success_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_success_chk
    CHECK (
        state <> 'SUCCEEDED' OR (
            content_sha256 IS NOT NULL
            AND (
                (requested_policy = 'semantic' AND disposition = 'VERIFIED')
                OR (
                    requested_policy = 'artifact'
                    AND disposition = 'ARTIFACT_VERIFIED'
                )
            )
        )
    );

CREATE INDEX IF NOT EXISTS we_result_verifications_retry_claim_idx
    ON we_result_verifications (next_retry_at, updated_at)
    WHERE state IN ('PENDING', 'RETRY_SCHEDULED');
CREATE INDEX IF NOT EXISTS we_result_verifications_lease_reap_idx
    ON we_result_verifications (lease_until)
    WHERE state = 'LEASED';
CREATE INDEX IF NOT EXISTS we_result_verifications_workload_state_idx
    ON we_result_verifications (workload_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS we_verifier_circuits (
    verifier_key          VARCHAR(160) PRIMARY KEY,
    state                 VARCHAR(16) NOT NULL DEFAULT 'closed',
    consecutive_failures  INTEGER     NOT NULL DEFAULT 0,
    opened_until          TIMESTAMPTZ,
    probe_lease_until     TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT we_verifier_circuits_state_chk
        CHECK (state IN ('closed', 'open', 'half_open')),
    CONSTRAINT we_verifier_circuits_failures_chk
        CHECK (consecutive_failures >= 0)
);

CREATE INDEX IF NOT EXISTS we_verifier_circuits_opened_idx
    ON we_verifier_circuits (opened_until)
    WHERE state = 'open';

-- Conservative historical repair:
--   * only DONE workloads made exclusively of ONESHOT shards;
--   * only rows whose current spent is still zero;
--   * exactly one ESCROW_RELEASE row;
--   * only the structured metadata.actual_spend written by escrow_release().
-- Notes, reward sums, budget, or hold amounts are intentionally not guessed.
WITH release_metadata AS (
    SELECT
        workload_id,
        count(*) AS release_count,
        max(metadata->>'actual_spend') AS actual_spend_text
    FROM we_ledger
    WHERE type = 'ESCROW_RELEASE'
      AND workload_id IS NOT NULL
    GROUP BY workload_id
),
parsed_release AS (
    SELECT
        workload_id,
        CASE
            WHEN release_count = 1
             AND actual_spend_text ~ '^[0-9]{1,14}(\.[0-9]{1,4})?$'
            THEN actual_spend_text::NUMERIC(18,4)
            ELSE NULL
        END AS actual_spend
    FROM release_metadata
)
UPDATE we_workloads AS workload
SET spent = parsed.actual_spend,
    updated_at = now()
FROM parsed_release AS parsed
WHERE workload.id = parsed.workload_id
  AND workload.status = 'DONE'
  AND workload.spent = 0
  AND parsed.actual_spend IS NOT NULL
  AND parsed.actual_spend >= 0
  AND EXISTS (
      SELECT 1
      FROM we_shards AS shard
      WHERE shard.workload_id = workload.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM we_shards AS shard
      WHERE shard.workload_id = workload.id
        AND shard.mode <> 'oneshot'
  );

COMMIT;
