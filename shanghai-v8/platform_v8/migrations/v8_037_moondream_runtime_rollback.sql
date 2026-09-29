-- rollback v8_037 · 恢复 image_caption 到通用 vision-ai tier

DELETE FROM v8_runtime_tiers
WHERE tier_name = 'moondream';

UPDATE v8_runtime_tiers
SET task_types = CASE
        WHEN 'image_caption' = ANY(task_types) THEN task_types
        ELSE array_append(task_types, 'image_caption')
    END,
    updated_at = NOW()
WHERE tier_name = 'vision-ai';
