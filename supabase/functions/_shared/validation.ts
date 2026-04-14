/**
 * Validation partagée pour toutes les Edge Functions
 * Version: 1.0
 *
 * Fonctions de validation qui throw sur input invalide.
 * Utilisées pour bounds checking et sanitisation des paramètres.
 */

/** Store IDs valides dans le système */
const VALID_STORE_IDS = [1, 2, 3, 5, 6, 39]

/** Sources API valides */
const VALID_API_SOURCES = ['main', 'secondary', 'both']

/** Date minimale acceptée (début des données) */
const MIN_DATE = '2024-01-01'

/** Range max pour recover-missing-sales */
const MAX_SALE_ID_RANGE = 1000

/** Max jours pour data-reconciliation */
const MAX_DAYS_RANGE = 90

/**
 * Valide un store_id parmi les valeurs autorisées [1,2,3,5,6,39]
 * @throws Error si invalide
 */
export function validateStoreId(id: unknown): number {
  const num = Number(id)
  if (!Number.isInteger(num) || !VALID_STORE_IDS.includes(num)) {
    throw new ValidationError(
      `store_id invalide: ${id}. Valeurs autorisées: ${VALID_STORE_IDS.join(', ')}`
    )
  }
  return num
}

/**
 * Valide une date au format YYYY-MM-DD, bornée entre MIN_DATE et aujourd'hui
 * @throws Error si invalide
 */
export function validateDateRange(date: unknown): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`Format de date invalide: ${date}. Attendu: YYYY-MM-DD`)
  }
  const parsed = new Date(date + 'T00:00:00Z')
  if (isNaN(parsed.getTime())) {
    throw new ValidationError(`Date invalide: ${date}`)
  }
  const minDate = new Date(MIN_DATE + 'T00:00:00Z')
  const today = new Date()
  today.setUTCHours(23, 59, 59, 999)
  if (parsed < minDate || parsed > today) {
    throw new ValidationError(
      `Date hors limites: ${date}. Doit être entre ${MIN_DATE} et aujourd'hui`
    )
  }
  return date
}

/**
 * Valide un entier dans un range [min, max]
 * @throws Error si invalide ou hors limites
 */
export function validateIntRange(value: unknown, min: number, max: number, paramName = 'valeur'): number {
  const num = Number(value)
  if (!Number.isInteger(num)) {
    throw new ValidationError(`${paramName} doit être un entier: ${value}`)
  }
  if (num < min || num > max) {
    throw new ValidationError(`${paramName} hors limites: ${num}. Doit être entre ${min} et ${max}`)
  }
  return num
}

/**
 * Valide un range de sale_id (max MAX_SALE_ID_RANGE IDs d'écart)
 * @throws Error si range invalide ou trop large
 */
export function validateSaleIdRange(startId: number, endId: number): void {
  if (!Number.isInteger(startId) || !Number.isInteger(endId)) {
    throw new ValidationError('start_id et end_id doivent être des entiers')
  }
  if (startId <= 0 || endId <= 0) {
    throw new ValidationError('start_id et end_id doivent être positifs')
  }
  if (startId > endId) {
    throw new ValidationError('start_id doit être inférieur ou égal à end_id')
  }
  if (endId - startId > MAX_SALE_ID_RANGE) {
    throw new ValidationError(
      `Range trop large: ${endId - startId} IDs. Maximum autorisé: ${MAX_SALE_ID_RANGE}`
    )
  }
}

/**
 * Valide la source API (main, secondary, both)
 * @throws Error si invalide
 */
export function validateApiSource(api: unknown): 'main' | 'secondary' | 'both' {
  if (typeof api !== 'string' || !VALID_API_SOURCES.includes(api)) {
    throw new ValidationError(
      `api source invalide: ${api}. Valeurs autorisées: ${VALID_API_SOURCES.join(', ')}`
    )
  }
  return api as 'main' | 'secondary' | 'both'
}

/**
 * Valide le nombre de jours (pour data-reconciliation)
 * @throws Error si invalide
 */
export function validateDaysRange(days: unknown, max = MAX_DAYS_RANGE): number {
  return validateIntRange(days, 1, max, 'days')
}

/**
 * Classe d'erreur de validation avec status HTTP 400
 */
export class ValidationError extends Error {
  public readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
