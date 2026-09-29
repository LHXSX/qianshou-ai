-- One author submission and one human approval publish a verified skill product.
ALTER TABLE we_task_adapter_publications
    ADD COLUMN IF NOT EXISTS sale_price_yuan NUMERIC(12, 2);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'we_task_adapter_publication_sale_price_ck') THEN
        ALTER TABLE we_task_adapter_publications ADD CONSTRAINT we_task_adapter_publication_sale_price_ck
            CHECK (sale_price_yuan IS NULL OR (sale_price_yuan >= 0 AND sale_price_yuan <= 100000));
    END IF;
END $$;
COMMENT ON COLUMN we_task_adapter_publications.sale_price_yuan IS
    'Optional immutable one-time CNY listing price; human publication approval also verifies and publishes the archive product';
