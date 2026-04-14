-- Migration: Suppression des tables doublons
-- Date: 2025-12-22
-- Description: Nettoyage des tables vides qui font doublon avec les tables actives

-- ============================================
-- SUPPRESSION DES TABLES DOUBLONS
-- ============================================

-- product_stock → doublon de stock
DROP TABLE IF EXISTS public.product_stock CASCADE;

-- hiboutik_products → doublon de products
DROP TABLE IF EXISTS public.hiboutik_products CASCADE;

-- hiboutik_sales → doublon de sales
DROP TABLE IF EXISTS public.hiboutik_sales CASCADE;

-- hiboutik_customers → doublon de customers
DROP TABLE IF EXISTS public.hiboutik_customers CASCADE;

-- inventory → doublon de stock
DROP TABLE IF EXISTS public.inventory CASCADE;

-- z_reports → doublon de daily_z_reports
DROP TABLE IF EXISTS public.z_reports CASCADE;

-- ============================================
-- OPTIMISATION
-- ============================================

-- Mettre à jour les statistiques des tables
ANALYZE public.stores;
ANALYZE public.vendors;
ANALYZE public.sales;
ANALYZE public.sale_items;
ANALYZE public.products;
ANALYZE public.categories;
ANALYZE public.brands;
ANALYZE public.stock;
ANALYZE public.daily_z_reports;
ANALYZE public.sync_logs;
ANALYZE public.vendor_cross_api_mapping;

-- Note: VACUUM FULL nécessite un accès exclusif et doit être fait manuellement si nécessaire
-- VACUUM ANALYZE; -- Décommentez si besoin
