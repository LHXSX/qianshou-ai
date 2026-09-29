-- Rollback is fail-closed: legacy/quarantined successes must be cleared first.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM we_result_verifications
        WHERE state = 'SUCCEEDED'
          AND disposition IN ('LEGACY_ARTIFACT_VERIFIED', 'QUARANTINED')
    ) THEN
        RAISE EXCEPTION
            'cannot rollback v8_049 while legacy/quarantined verification rows exist';
    END IF;
END
$$;

ALTER TABLE we_result_verifications
    DROP CONSTRAINT IF EXISTS we_result_verifications_disposition_chk;
ALTER TABLE we_result_verifications
    ADD CONSTRAINT we_result_verifications_disposition_chk CHECK (
        disposition IS NULL OR disposition IN (
            'VERIFIED',
            'ARTIFACT_VERIFIED',
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
                    requested_policy = 'artifact'
                    AND disposition = 'ARTIFACT_VERIFIED'
                )
            )
        )
    );
