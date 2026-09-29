-- Control metadata only. Existing we_workloads/ledger remain authoritative.
BEGIN;
CREATE TABLE IF NOT EXISTS we_media_requests (
 workload_id VARCHAR(36) PRIMARY KEY, owner_id BIGINT NOT NULL,
 request_id VARCHAR(128) NOT NULL, spec_sha256 VARCHAR(64) NOT NULL,
 quote_id VARCHAR(64) NOT NULL, authorization_id VARCHAR(36) NOT NULL,
 "authorization" JSON NOT NULL,
 CONSTRAINT we_media_request_owner_uq UNIQUE(owner_id, request_id)
);
CREATE TABLE IF NOT EXISTS we_media_attempts (
 attempt_id VARCHAR(36) PRIMARY KEY, task_id VARCHAR(36) NOT NULL UNIQUE,
 worker_id VARCHAR(36) NOT NULL, device_id VARCHAR(128) NOT NULL,
 worker_owner_id BIGINT NOT NULL, connection_epoch BIGINT NOT NULL,
 lease_epoch INTEGER NOT NULL, lease_expires_at BIGINT NOT NULL,
 envelope JSON NOT NULL, state VARCHAR(32) NOT NULL,
 event_sequence BIGINT NOT NULL DEFAULT 0, result_revision VARCHAR(128)
);
CREATE TABLE IF NOT EXISTS we_media_outbox (
 id VARCHAR(128) PRIMARY KEY, attempt_id VARCHAR(36) NOT NULL,
 operation VARCHAR(24) NOT NULL, payload JSON NOT NULL,
 state VARCHAR(24) NOT NULL DEFAULT 'pending', claimed_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS we_media_events (
 sequence BIGINT PRIMARY KEY, event_sha256 VARCHAR(64) NOT NULL,
 payload JSON NOT NULL, disposition VARCHAR(32) NOT NULL
);
CREATE TABLE IF NOT EXISTS we_media_settlements (
 workload_id VARCHAR(36) PRIMARY KEY, attempt_id VARCHAR(36) NOT NULL UNIQUE,
 result_revision VARCHAR(128) NOT NULL, billable_result_revision VARCHAR(64) NOT NULL UNIQUE,
 verdict_sha256 VARCHAR(64) NOT NULL, receipt JSON NOT NULL
);
CREATE TABLE IF NOT EXISTS we_media_objects (
 id VARCHAR(128) PRIMARY KEY, account_id BIGINT NOT NULL, asset_id VARCHAR(36) NOT NULL,
 purpose VARCHAR(24) NOT NULL, object_key VARCHAR(1024) NOT NULL UNIQUE,
 sha256 VARCHAR(64) NOT NULL, size_bytes BIGINT NOT NULL, content_type VARCHAR(64) NOT NULL,
 declaration JSON NOT NULL, object_version_id VARCHAR(200), retention_until BIGINT NOT NULL
);
COMMIT;
