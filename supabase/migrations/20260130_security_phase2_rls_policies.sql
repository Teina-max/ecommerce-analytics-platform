-- =============================================================================
-- Migration: Security Phase 2 - RLS Policies Restrictives
-- Date: 30 janvier 2026
-- Description: Renforce les RLS policies pour restreindre l'accès aux tables sensibles
-- =============================================================================

-- ============================================================================
-- TABLES SENSIBLES → service_role uniquement (pas d'accès anon/authenticated)
-- ============================================================================

-- sale_items: données de vente (table principale)
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on sale_items" ON sale_items;
CREATE POLICY "Service role full access on sale_items"
  ON sale_items FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- customers: PII (données personnelles)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on customers" ON customers;
CREATE POLICY "Service role full access on customers"
  ON customers FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- webhook_raw_payloads: données brutes sensibles
ALTER TABLE webhook_raw_payloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on webhook_raw_payloads" ON webhook_raw_payloads;
CREATE POLICY "Service role full access on webhook_raw_payloads"
  ON webhook_raw_payloads FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- data_anomalies: données système internes
ALTER TABLE data_anomalies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on data_anomalies" ON data_anomalies;
CREATE POLICY "Service role full access on data_anomalies"
  ON data_anomalies FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- sync_logs: audit trail système
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on sync_logs" ON sync_logs;
CREATE POLICY "Service role full access on sync_logs"
  ON sync_logs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- reference_snapshots: snapshots internes
ALTER TABLE reference_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on reference_snapshots" ON reference_snapshots;
CREATE POLICY "Service role full access on reference_snapshots"
  ON reference_snapshots FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- vendor_mapping: mapping interne
ALTER TABLE vendor_mapping ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on vendor_mapping" ON vendor_mapping;
CREATE POLICY "Service role full access on vendor_mapping"
  ON vendor_mapping FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================================
-- TABLES NON SENSIBLES → lecture publique autorisée (données catalogue)
-- ============================================================================

-- products: catalogue public
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on products" ON products;
CREATE POLICY "Public read on products"
  ON products FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on products" ON products;
CREATE POLICY "Service role full access on products"
  ON products FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- brands: marques publiques
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on brands" ON brands;
CREATE POLICY "Public read on brands"
  ON brands FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on brands" ON brands;
CREATE POLICY "Service role full access on brands"
  ON brands FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- categories: catégories publiques
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on categories" ON categories;
CREATE POLICY "Public read on categories"
  ON categories FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on categories" ON categories;
CREATE POLICY "Service role full access on categories"
  ON categories FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- vendors: vendeurs (noms publics)
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on vendors" ON vendors;
CREATE POLICY "Public read on vendors"
  ON vendors FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on vendors" ON vendors;
CREATE POLICY "Service role full access on vendors"
  ON vendors FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- stores: magasins (info publique)
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on stores" ON stores;
CREATE POLICY "Public read on stores"
  ON stores FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on stores" ON stores;
CREATE POLICY "Service role full access on stores"
  ON stores FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- stock: niveaux de stock (service_role + lecture authentifiée)
ALTER TABLE stock ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read on stock" ON stock;
CREATE POLICY "Authenticated read on stock"
  ON stock FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Service role full access on stock" ON stock;
CREATE POLICY "Service role full access on stock"
  ON stock FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- product_variants: variantes publiques
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on product_variants" ON product_variants;
CREATE POLICY "Public read on product_variants"
  ON product_variants FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on product_variants" ON product_variants;
CREATE POLICY "Service role full access on product_variants"
  ON product_variants FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- product_quantity_rules: règles publiques
ALTER TABLE product_quantity_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read on product_quantity_rules" ON product_quantity_rules;
CREATE POLICY "Public read on product_quantity_rules"
  ON product_quantity_rules FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access on product_quantity_rules" ON product_quantity_rules;
CREATE POLICY "Service role full access on product_quantity_rules"
  ON product_quantity_rules FOR ALL TO service_role
  USING (true) WITH CHECK (true);
