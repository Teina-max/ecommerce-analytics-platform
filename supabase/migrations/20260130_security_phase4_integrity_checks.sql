-- =============================================================================
-- Migration: Security Phase 4 - Renforcement Intégrité Données
-- Date: 30 janvier 2026
-- Description: Nouveaux checks d'intégrité + auto-fix brand + alertes critiques
-- =============================================================================

-- ============================================================================
-- 4.1 - Mise à jour run_data_integrity_checks() avec 3 nouveaux checks
-- ============================================================================

-- Drop existing functions with incompatible signatures
DROP FUNCTION IF EXISTS run_data_integrity_checks();
DROP FUNCTION IF EXISTS smart_fix_category_mismatches();
DROP FUNCTION IF EXISTS smart_fix_category_mismatches(integer);
DROP FUNCTION IF EXISTS smart_fix_brand_mismatches();
DROP FUNCTION IF EXISTS run_all_auto_fixes();
DROP FUNCTION IF EXISTS notify_critical_anomalies();

CREATE OR REPLACE FUNCTION run_data_integrity_checks()
RETURNS TABLE(check_name text, status text, affected_count integer) AS $$
DECLARE
  v_count integer;
BEGIN
  -- CHECK 1: orphan_store_id (sale_items avec store_id inexistant)
  SELECT COUNT(*) INTO v_count
  FROM sale_items si
  LEFT JOIN stores s ON si.store_id = s.id
  WHERE si.sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND s.id IS NULL AND si.store_id IS NOT NULL;

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('orphan_store_id', 'critical', 'sale_items', v_count,
      'sale_items avec store_id inexistant dans la table stores',
      'Vérifier la synchronisation des magasins via sync-master-data');
  END IF;

  check_name := 'orphan_store_id'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 2: missing_category_id (sale_items sans category_id)
  SELECT COUNT(*) INTO v_count
  FROM sale_items
  WHERE sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND category_id IS NULL AND category_name IS NOT NULL;

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('missing_category_id', 'warning', 'sale_items', v_count,
      'sale_items avec category_name mais sans category_id',
      'SELECT smart_fix_category_mismatches()');
  END IF;

  check_name := 'missing_category_id'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 3: category_id_mismatch (category_id ne correspond pas à category_name)
  SELECT COUNT(*) INTO v_count
  FROM sale_items si
  JOIN categories c ON si.category_id = c.id
  WHERE si.sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND si.category_id IS NOT NULL
  AND UPPER(TRIM(si.category_name)) != UPPER(TRIM(c.category_name));

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('category_id_mismatch', 'warning', 'sale_items', v_count,
      'category_id ne correspond pas à category_name',
      'SELECT smart_fix_category_mismatches()');
  END IF;

  check_name := 'category_id_mismatch'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 4: missing_vendor (sale_items sans vendor_id mappé)
  SELECT COUNT(*) INTO v_count
  FROM sale_items
  WHERE sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND vendor_name IS NULL;

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('missing_vendor', 'warning', 'sale_items', v_count,
      'sale_items sans vendor_name',
      'Vérifier le mapping vendeurs via sync-master-data');
  END IF;

  check_name := 'missing_vendor'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 5: missing_product_id (sale_items sans product_id)
  SELECT COUNT(*) INTO v_count
  FROM sale_items
  WHERE sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND product_id IS NULL AND product_name IS NOT NULL;

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('missing_product_id', 'warning', 'sale_items', v_count,
      'sale_items avec product_name mais sans product_id',
      'Vérifier auto-enrichissement webhook');
  END IF;

  check_name := 'missing_product_id'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 6: duplicate_sale_items (doublons hiboutik_sale_id + hiboutik_line_item_id)
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT hiboutik_sale_id, hiboutik_line_item_id, api_source, COUNT(*) as cnt
    FROM sale_items
    WHERE sale_date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY hiboutik_sale_id, hiboutik_line_item_id, api_source
    HAVING COUNT(*) > 1
  ) dupes;

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('duplicate_sale_items', 'critical', 'sale_items', v_count,
      'Doublons détectés (même sale_id + line_item_id + api_source)',
      'Utiliser data-reconciliation avec fix_duplicates=true');
  END IF;

  check_name := 'duplicate_sale_items'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- ============================================================
  -- NOUVEAUX CHECKS (Phase 4 - Janvier 2026)
  -- ============================================================

  -- CHECK 7: brand_id_mismatch (brand_id ne correspond pas à brand_name)
  SELECT COUNT(*) INTO v_count
  FROM sale_items si
  JOIN brands b ON si.brand_id = b.id
  WHERE si.sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND si.brand_id IS NOT NULL
  AND UPPER(TRIM(si.brand_name)) != UPPER(TRIM(b.brand_name));

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('brand_id_mismatch', 'warning', 'sale_items', v_count,
      'brand_id ne correspond pas à brand_name',
      'SELECT smart_fix_brand_mismatches()');
  END IF;

  check_name := 'brand_id_mismatch'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 8: parent_category_name_mismatch
  SELECT COUNT(*) INTO v_count
  FROM sale_items si
  JOIN categories c ON si.parent_category_id = c.id
  WHERE si.sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND si.parent_category_id IS NOT NULL
  AND si.parent_category_name IS NOT NULL
  AND UPPER(TRIM(si.parent_category_name)) != UPPER(TRIM(c.category_name));

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('parent_category_name_mismatch', 'warning', 'sale_items', v_count,
      'parent_category_name ne correspond pas à la table categories',
      'UPDATE sale_items SET parent_category_name = c.category_name FROM categories c WHERE sale_items.parent_category_id = c.id');
  END IF;

  check_name := 'parent_category_name_mismatch'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  -- CHECK 9: grandparent_category_name_mismatch
  SELECT COUNT(*) INTO v_count
  FROM sale_items si
  JOIN categories c ON si.grandparent_category_id = c.id
  WHERE si.sale_date >= CURRENT_DATE - INTERVAL '7 days'
  AND si.grandparent_category_id IS NOT NULL
  AND si.grandparent_category_name IS NOT NULL
  AND UPPER(TRIM(si.grandparent_category_name)) != UPPER(TRIM(c.category_name));

  IF v_count > 0 THEN
    INSERT INTO data_anomalies (anomaly_type, severity, affected_table, affected_count,
      description, suggested_fix)
    VALUES ('grandparent_category_name_mismatch', 'warning', 'sale_items', v_count,
      'grandparent_category_name ne correspond pas à la table categories',
      'UPDATE sale_items SET grandparent_category_name = c.category_name FROM categories c WHERE sale_items.grandparent_category_id = c.id');
  END IF;

  check_name := 'grandparent_category_name_mismatch'; status := CASE WHEN v_count = 0 THEN 'OK' ELSE 'FAIL' END; affected_count := v_count;
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 4.1 - smart_fix_brand_mismatches()
-- ============================================================================

CREATE OR REPLACE FUNCTION smart_fix_brand_mismatches()
RETURNS TABLE(strategy text, fixed_count integer) AS $$
DECLARE
  v_fixed integer;
BEGIN
  -- STRATEGIE 1: Lookup par brand_id → corriger brand_name depuis brands
  UPDATE sale_items si
  SET brand_name = b.brand_name, last_sync_at = NOW()
  FROM brands b
  WHERE si.brand_id = b.id
  AND si.brand_id IS NOT NULL
  AND UPPER(TRIM(si.brand_name)) != UPPER(TRIM(b.brand_name))
  AND si.sale_date >= CURRENT_DATE - INTERVAL '30 days';

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'brand_id_to_name'; fixed_count := v_fixed;
  RETURN NEXT;

  -- STRATEGIE 2: Lookup par brand_name → corriger brand_id
  UPDATE sale_items si
  SET brand_id = b.id, last_sync_at = NOW()
  FROM brands b
  WHERE si.brand_id IS NULL
  AND si.brand_name IS NOT NULL
  AND UPPER(TRIM(si.brand_name)) = UPPER(TRIM(b.brand_name))
  AND si.sale_date >= CURRENT_DATE - INTERVAL '30 days';

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'name_to_brand_id'; fixed_count := v_fixed;
  RETURN NEXT;

  -- STRATEGIE 3: Lookup par hiboutik_brand_id + api_source
  UPDATE sale_items si
  SET brand_id = b.id, brand_name = b.brand_name, last_sync_at = NOW()
  FROM brands b
  WHERE si.hiboutik_brand_id = b.hiboutik_brand_id
  AND si.api_source = b.api_source
  AND si.brand_id IS NULL
  AND si.hiboutik_brand_id IS NOT NULL
  AND si.sale_date >= CURRENT_DATE - INTERVAL '30 days';

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'hiboutik_brand_id_lookup'; fixed_count := v_fixed;
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 4.2 - Mise à jour smart_fix_category_mismatches() avec p_days_back
-- ============================================================================

CREATE OR REPLACE FUNCTION smart_fix_category_mismatches(
  p_days_back INTEGER DEFAULT 30
)
RETURNS TABLE(strategy text, fixed_count integer) AS $$
DECLARE
  v_fixed integer;
BEGIN
  -- STRATEGIE 1: category_id → corriger category_name
  UPDATE sale_items si
  SET category_name = c.category_name, last_sync_at = NOW()
  FROM categories c
  WHERE si.category_id = c.id
  AND si.category_id IS NOT NULL
  AND UPPER(TRIM(si.category_name)) != UPPER(TRIM(c.category_name))
  AND si.sale_date >= CURRENT_DATE - (p_days_back || ' days')::interval;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'category_id_to_name'; fixed_count := v_fixed;
  RETURN NEXT;

  -- STRATEGIE 2: category_name → corriger category_id (via api_source='main')
  UPDATE sale_items si
  SET category_id = c.id, last_sync_at = NOW()
  FROM categories c
  WHERE si.category_id IS NULL
  AND si.category_name IS NOT NULL
  AND UPPER(TRIM(si.category_name)) = UPPER(TRIM(c.category_name))
  AND c.api_source = 'main'
  AND si.sale_date >= CURRENT_DATE - (p_days_back || ' days')::interval;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'name_to_category_id'; fixed_count := v_fixed;
  RETURN NEXT;

  -- STRATEGIE 3: parent_category_id → corriger parent_category_name
  UPDATE sale_items si
  SET parent_category_name = c.category_name, last_sync_at = NOW()
  FROM categories c
  WHERE si.parent_category_id = c.id
  AND si.parent_category_id IS NOT NULL
  AND si.parent_category_name IS NOT NULL
  AND UPPER(TRIM(si.parent_category_name)) != UPPER(TRIM(c.category_name))
  AND si.sale_date >= CURRENT_DATE - (p_days_back || ' days')::interval;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'parent_category_name_fix'; fixed_count := v_fixed;
  RETURN NEXT;

  -- STRATEGIE 4: grandparent_category_id → corriger grandparent_category_name
  UPDATE sale_items si
  SET grandparent_category_name = c.category_name, last_sync_at = NOW()
  FROM categories c
  WHERE si.grandparent_category_id = c.id
  AND si.grandparent_category_id IS NOT NULL
  AND si.grandparent_category_name IS NOT NULL
  AND UPPER(TRIM(si.grandparent_category_name)) != UPPER(TRIM(c.category_name))
  AND si.sale_date >= CURRENT_DATE - (p_days_back || ' days')::interval;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  strategy := 'grandparent_category_name_fix'; fixed_count := v_fixed;
  RETURN NEXT;

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 4.1 - Intégrer smart_fix_brand_mismatches() dans run_all_auto_fixes()
-- ============================================================================

CREATE OR REPLACE FUNCTION run_all_auto_fixes()
RETURNS TABLE(fix_name text, records_fixed integer) AS $$
DECLARE
  rec RECORD;
BEGIN
  -- 1. Fix category mismatches (30 jours par défaut)
  FOR rec IN SELECT * FROM smart_fix_category_mismatches(30) LOOP
    fix_name := 'category_' || rec.strategy;
    records_fixed := rec.fixed_count;
    RETURN NEXT;
  END LOOP;

  -- 2. Fix brand mismatches
  FOR rec IN SELECT * FROM smart_fix_brand_mismatches() LOOP
    fix_name := 'brand_' || rec.strategy;
    records_fixed := rec.fixed_count;
    RETURN NEXT;
  END LOOP;

  -- 3. Fix vendor duplicates (returns TABLE(records_fixed, details), not (strategy, fixed_count))
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'smart_fix_vendor_duplicates') THEN
    FOR rec IN SELECT * FROM smart_fix_vendor_duplicates() LOOP
      fix_name := 'vendor_duplicates';
      records_fixed := rec.records_fixed;
      RETURN NEXT;
    END LOOP;
  END IF;

  -- Marquer les anomalies résolues
  UPDATE data_anomalies
  SET is_resolved = true, resolved_at = NOW(), resolution_notes = 'Auto-fixed by run_all_auto_fixes()'
  WHERE auto_fixed = false
  AND is_resolved = false
  AND anomaly_type IN ('category_id_mismatch', 'missing_category_id', 'brand_id_mismatch',
    'parent_category_name_mismatch', 'grandparent_category_name_mismatch')
  AND detected_at >= CURRENT_DATE - INTERVAL '1 day';

  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 4.3 - Alerte Telegram sur anomalies critiques
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_critical_anomalies()
RETURNS integer AS $$
DECLARE
  v_anomaly RECORD;
  v_message text := '';
  v_count integer := 0;
  v_url text;
  v_service_key text;
BEGIN
  -- Récupérer les anomalies critiques non notifiées
  FOR v_anomaly IN
    SELECT anomaly_type, severity, affected_table, affected_count, description, suggested_fix
    FROM data_anomalies
    WHERE severity = 'critical'
    AND is_notified = false
    AND is_resolved = false
    ORDER BY detected_at DESC
    LIMIT 10
  LOOP
    v_count := v_count + 1;
    v_message := v_message || E'\n\n' ||
      '🚨 ' || UPPER(v_anomaly.anomaly_type) || E'\n' ||
      'Table: ' || v_anomaly.affected_table || E'\n' ||
      'Affectés: ' || v_anomaly.affected_count || ' lignes' || E'\n' ||
      'Fix: ' || COALESCE(v_anomaly.suggested_fix, 'Manuel');
  END LOOP;

  IF v_count > 0 THEN
    -- Construire le message complet
    v_message := '🚨 ANOMALIES CRITIQUES DETECTEES (' || v_count || ')' || v_message;

    -- Envoyer via pg_net si disponible, sinon log
    v_url := current_setting('app.settings.supabase_url', true);
    v_service_key := current_setting('app.settings.service_role_key', true);

    IF v_url IS NOT NULL AND v_service_key IS NOT NULL THEN
      -- Appel vers telegram-notify Edge Function via pg_net
      PERFORM net.http_post(
        url := v_url || '/functions/v1/telegram-notify',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key
        ),
        body := jsonb_build_object(
          'type', 'alert',
          'message', v_message
        )
      );
    ELSE
      RAISE NOTICE 'Cannot send Telegram alert: missing app.settings. Message: %', v_message;
    END IF;

    -- Marquer comme notifiées
    UPDATE data_anomalies
    SET is_notified = true, notified_at = NOW()
    WHERE severity = 'critical'
    AND is_notified = false
    AND is_resolved = false;
  END IF;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 4.4 - Cron hebdomadaire pour scan étendu (90 jours)
-- ============================================================================

-- Le cron quotidien utilise 30 jours (défaut)
-- Ajouter un cron hebdomadaire avec fenêtre 90 jours
SELECT cron.schedule(
  'weekly-extended-integrity-fix',
  '0 3 * * 0',  -- Dimanche à 3h UTC (4h Paris)
  $$SELECT * FROM smart_fix_category_mismatches(90)$$
);
