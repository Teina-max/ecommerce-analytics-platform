-- Drop unused tables that are no longer needed
-- These tables have been replaced by denormalized data in sale_items

-- Drop vendor cross-API mapping table (vendor mapping now handled in Edge Functions)
DROP TABLE IF EXISTS vendor_cross_api_mapping CASCADE;

-- Drop category mapping tables (categories now use direct hiboutik IDs)
DROP TABLE IF EXISTS category_mappings CASCADE;
DROP TABLE IF EXISTS canonical_categories CASCADE;

-- Verify tables are dropped
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'vendor_cross_api_mapping') THEN
        RAISE EXCEPTION 'vendor_cross_api_mapping still exists';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'category_mappings') THEN
        RAISE EXCEPTION 'category_mappings still exists';
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'canonical_categories') THEN
        RAISE EXCEPTION 'canonical_categories still exists';
    END IF;
    RAISE NOTICE 'All unused tables successfully dropped';
END $$;
