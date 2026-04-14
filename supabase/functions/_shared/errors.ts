/**
 * Gestion d'erreurs sécurisée pour toutes les Edge Functions
 * Version: 1.0
 *
 * - Log complet côté serveur (console.error)
 * - Message générique côté client (pas de fuite d'infos)
 * - error_id unique pour traçabilité
 * - JAMAIS de stack trace, table names, column names dans la réponse
 */

import { corsHeaders } from './cors.ts'
import { ValidationError } from './validation.ts'

/**
 * Génère un error_id unique pour tracer l'erreur dans les logs
 */
function generateErrorId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/**
 * Messages génériques par status code (pas de détails techniques)
 */
const GENERIC_MESSAGES: Record<number, string> = {
  400: 'Requête invalide',
  401: 'Non autorisé',
  403: 'Accès refusé',
  404: 'Ressource introuvable',
  429: 'Trop de requêtes',
  500: 'Erreur interne du serveur',
}

/**
 * Crée une réponse d'erreur sécurisée.
 * - Log complet côté serveur
 * - Message générique côté client (sauf ValidationError qui retourne le message exact)
 * - error_id pour traçabilité
 */
export function safeErrorResponse(
  error: unknown,
  functionName: string,
  statusCode = 500
): Response {
  const errorId = generateErrorId()
  const err = error instanceof Error ? error : new Error(String(error))

  // Log complet côté serveur (visible dans Supabase logs)
  console.error(`[${functionName}] Error ${errorId}:`, {
    message: err.message,
    name: err.name,
    stack: err.stack,
  })

  // ValidationError : on retourne le message (c'est safe, on l'a écrit nous-même)
  if (err instanceof ValidationError) {
    return new Response(
      JSON.stringify({
        error: err.message,
        error_id: errorId,
      }),
      {
        status: err.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Toute autre erreur : message générique uniquement
  const genericMessage = GENERIC_MESSAGES[statusCode] || GENERIC_MESSAGES[500]
  return new Response(
    JSON.stringify({
      error: genericMessage,
      error_id: errorId,
    }),
    {
      status: statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
}

/**
 * Vérifie la signature HMAC-SHA256 d'un webhook Hiboutik.
 * Compare le header X-Hiboutik-Hmac-SHA256 avec le hash calculé du body.
 *
 * @returns true si la signature est valide, false sinon
 */
export async function verifyHiboutikHmac(
  rawBody: string,
  receivedHmac: string | null,
  secret: string
): Promise<boolean> {
  if (!receivedHmac || !secret) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody)
  )
  const computedHmac = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Comparaison constant-time via subtle crypto
  return computedHmac === receivedHmac
}
