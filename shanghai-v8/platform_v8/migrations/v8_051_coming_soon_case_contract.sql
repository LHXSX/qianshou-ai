-- v8_051: 案例摘要 / 智能合同审查 → 即将上线
BEGIN;
UPDATE we_apps
SET display_meta = coalesce(display_meta, '{}'::jsonb) || '{"coming_soon": true}'::jsonb,
    updated_at = now()
WHERE slug IN ('case-digest', 'contract-review');
COMMIT;
