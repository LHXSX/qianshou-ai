-- Candidate only. Run through reviewed normal migration, NEVER ad-hoc in production.
CREATE TABLE we_app_submission_requests (
 owner_id BIGINT NOT NULL,
 app_id VARCHAR(100) NOT NULL,
 request_id VARCHAR(100) NOT NULL,
 payload_sha256 CHAR(64) NOT NULL,
 workload_id VARCHAR(100),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,app_id,request_id)
);
-- Keep claims for at least workload/financial retention. Deleting them permits rebilling.
CREATE TABLE we_film_completion_grants (
 token_hash CHAR(64) PRIMARY KEY,
 workload_id VARCHAR(100) NOT NULL UNIQUE,
 owner_id BIGINT NOT NULL,
 request_json TEXT NOT NULL,
 state VARCHAR(16) NOT NULL CHECK(state IN ('issued','calling','done')),
 expires_at BIGINT NOT NULL,
 response_json TEXT
);
-- Tokens only authorize the immutable workload request once; unknown calls are never retried.
-- Treat request/response JSON with the same retention and access policy as workload content.
