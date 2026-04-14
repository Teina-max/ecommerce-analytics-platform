-- =============================================================================
-- Migration: Security Phase 2 - Rate Limiting
-- Date: 30 janvier 2026
-- Description: Table et fonction pour rate limiting des Edge Functions
-- =============================================================================

-- 1. Table rate_limits
CREATE TABLE IF NOT EXISTS rate_limits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  function_name text NOT NULL,
  client_ip text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  request_count int NOT NULL DEFAULT 1,
  UNIQUE(function_name, client_ip, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON rate_limits (function_name, client_ip, window_start);

-- RLS: service_role only
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on rate_limits"
  ON rate_limits FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 2. Fonction check_rate_limit (appelée depuis Edge Functions via .rpc())
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_function_name text,
  p_client_ip text,
  p_max_requests int
)
RETURNS jsonb AS $$
DECLARE
  v_window_start timestamptz := date_trunc('minute', now());
  v_count int;
BEGIN
  -- Upsert: incrémente ou crée
  INSERT INTO rate_limits (function_name, client_ip, window_start, request_count)
  VALUES (p_function_name, p_client_ip, v_window_start, 1)
  ON CONFLICT (function_name, client_ip, window_start)
  DO UPDATE SET request_count = rate_limits.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_requests,
    'current_count', v_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Cleanup: purge les entrées > 1h
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM rate_limits WHERE window_start < now() - interval '1 hour';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. pg_cron job: nettoyage toutes les heures
SELECT cron.schedule(
  'hourly-cleanup-rate-limits',
  '0 * * * *',
  $$SELECT cleanup_rate_limits()$$
);
