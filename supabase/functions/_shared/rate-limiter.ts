/**
 * Rate Limiter pour Edge Functions
 * Version: 1.0
 *
 * Vérifie le nombre de requêtes par IP par minute pour une fonction donnée.
 * Utilise la table `rate_limits` dans Supabase.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/** Limites par défaut par fonction (requêtes par minute) */
const RATE_LIMITS: Record<string, number> = {
  'unified-analytics': 60,
  'recover-missing-sales': 10,
  'webhook-hiboutik-sale': 100,
  'db-query': 5,
  'data-reconciliation': 10,
  'sync-master-data': 5,
  'sync-customers': 10,
  'import-z-reports': 10,
  'get-stock-alerts': 30,
  'refresh-supply-prices': 5,
  'sync-supply-prices': 5,
  'data-quality-check': 10,
  'telegram-webhook': 30,
  'telegram-notify': 30,
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds?: number
}

/**
 * Vérifie et incrémente le compteur de rate limit.
 * @returns {allowed: true} si la requête est autorisée, {allowed: false, retryAfterSeconds} sinon
 */
export async function checkRateLimit(
  functionName: string,
  clientIp: string
): Promise<RateLimitResult> {
  const maxRequests = RATE_LIMITS[functionName] || 30 // default: 30/min

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const windowStart = new Date()
    windowStart.setUTCSeconds(0, 0) // Début de la minute courante

    // Upsert: incrémente le compteur ou crée une nouvelle entrée
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_function_name: functionName,
      p_client_ip: clientIp,
      p_max_requests: maxRequests,
    })

    if (error) {
      // En cas d'erreur DB, on laisse passer (fail-open) pour ne pas bloquer le service
      console.error('[rate-limiter] DB error, allowing request:', error.message)
      return { allowed: true, remaining: maxRequests }
    }

    // data retourne { allowed: boolean, current_count: number }
    if (data && !data.allowed) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 60 - new Date().getUTCSeconds(),
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - (data?.current_count || 0)),
    }
  } catch (err) {
    // Fail-open: si le rate limiter est down, on laisse passer
    console.error('[rate-limiter] Error, allowing request:', err)
    return { allowed: true, remaining: maxRequests }
  }
}

/**
 * Extrait l'IP client depuis les headers de la requête.
 * Supabase Edge Functions passent l'IP dans x-forwarded-for ou x-real-ip.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

/**
 * Crée une réponse HTTP 429 Too Many Requests.
 */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: 'Trop de requêtes. Réessayez plus tard.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    }
  )
}
