-- =============================================================================
-- Migration: Security Phase 3 - Security Audit Log
-- Date: 30 janvier 2026
-- Description: Table de logs de sécurité pour traçabilité des événements
-- =============================================================================

-- Table security_audit_log
CREATE TABLE IF NOT EXISTS security_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,           -- 'auth_failure', 'rate_limited', 'invalid_input', 'webhook_rejected'
  function_name text NOT NULL,
  client_ip text,
  details jsonb,
  created_at timestamptz DEFAULT now()
);

-- Index pour recherche par type d'événement et date
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON security_audit_log (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_function ON security_audit_log (function_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_ip ON security_audit_log (client_ip, created_at DESC);

-- RLS: service_role uniquement
ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on security_audit_log"
  ON security_audit_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Fonction pour logger les événements de sécurité (appelée depuis Edge Functions via .rpc())
CREATE OR REPLACE FUNCTION log_security_event(
  p_event_type text,
  p_function_name text,
  p_client_ip text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS void AS $$
BEGIN
  INSERT INTO security_audit_log (event_type, function_name, client_ip, details)
  VALUES (p_event_type, p_function_name, p_client_ip, p_details);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup: purge les entrées > 90 jours
CREATE OR REPLACE FUNCTION cleanup_security_audit_log()
RETURNS void AS $$
BEGIN
  DELETE FROM security_audit_log WHERE created_at < now() - interval '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ajouter au cleanup quotidien existant
-- (sera appelé dans cleanup_old_backups ou via cron séparé)
