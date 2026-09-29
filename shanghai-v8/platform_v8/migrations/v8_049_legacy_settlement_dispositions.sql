-- Explicit legacy settlement outcomes; no result may masquerade as semantic.
ALTER TABLE we_assignment_deliveries
    ADD COLUMN IF NOT EXISTS assignment_manifest JSONB
    NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE we_assignment_deliveries
    DROP CONSTRAINT IF EXISTS we_assignment_deliveries_manifest_chk;
ALTER TABLE we_assignment_deliveries
    ADD CONSTRAINT we_assignment_deliveries_manifest_chk CHECK (
        jsonb_typeof(assignment_manifest) = 'object'
    );

ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_disposition_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_disposition_chk CHECK (
        disposition IS NULL OR disposition IN (
            'VERIFIED',
            'ARTIFACT_VERIFIED',
            'LEGACY_ARTIFACT_VERIFIED',
            'QUARANTINED',
            'REJECTED',
            'INFRASTRUCTURE_FAILED'
        )
    );
ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_success_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_success_chk CHECK (
        state <> 'SUCCEEDED' OR (
            content_sha256 IS NOT NULL
            AND (
                (requested_policy = 'semantic' AND disposition = 'VERIFIED')
                OR (
                    requested_policy = 'semantic'
                    AND disposition = 'LEGACY_ARTIFACT_VERIFIED'
                )
                OR (
                    requested_policy = 'artifact'
                    AND disposition = 'ARTIFACT_VERIFIED'
                )
                OR disposition = 'QUARANTINED'
            )
        )
    );
