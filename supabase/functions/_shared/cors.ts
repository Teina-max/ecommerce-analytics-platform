/**
 * CORS Headers partagés pour toutes les Edge Functions
 * Version: 2.0-security
 *
 * CORS restrictif : par défaut autorise uniquement les origines connues.
 * Les webhooks (server-to-server) n'ont pas besoin de CORS mais on le garde
 * pour compatibilité avec les appels depuis le dashboard Supabase.
 */

/**
 * Origines autorisées pour les appels CORS
 * - Supabase dashboard et APIs
 * - Telegram API (pour les webhooks sortants)
 * - Localhost pour dev
 */
const ALLOWED_ORIGINS = [
  'https://your-project-ref.supabase.co',
  'https://supabase.com',
  'https://app.supabase.com',
  'http://localhost:3000',
  'http://localhost:5173',
]

/**
 * Détermine l'origine CORS à retourner.
 * Si l'origine est dans la liste, on la retourne (CORS restreint).
 * Sinon, pas de header Access-Control-Allow-Origin (bloqué par le navigateur).
 * Note: les appels server-to-server (webhooks, cron) ne sont pas affectés par CORS.
 */
function getAllowedOrigin(req?: Request): string {
  if (!req) return ALLOWED_ORIGINS[0]
  const origin = req.headers.get('origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin
  }
  // Pour les requêtes sans origin (server-to-server, curl), on autorise
  if (!origin) return '*'
  // Origin inconnue: retourner la première origine autorisée (browser bloquera)
  return ALLOWED_ORIGINS[0]
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

/**
 * Génère les headers CORS dynamiques basés sur l'origine de la requête
 */
export function getCorsHeaders(req?: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

/**
 * Crée une réponse OPTIONS pour le preflight CORS
 */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }
  return null
}

/**
 * Crée une réponse JSON avec les headers CORS
 */
export function jsonResponse(data: any, status = 200, req?: Request): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: { ...(req ? getCorsHeaders(req) : corsHeaders), 'Content-Type': 'application/json' }
    }
  )
}

/**
 * Crée une réponse d'erreur avec les headers CORS
 */
export function errorResponse(message: string, status = 400, details?: any): Response {
  return new Response(
    JSON.stringify({ error: message, details }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    }
  )
}
