/**
 * Utilitaires de dates avec timezone Paris
 * Version: 1.0
 *
 * Gère les dates en timezone Paris (UTC+1 hiver, UTC+2 été)
 */

/**
 * Obtient la date d'aujourd'hui en timezone Paris
 * @returns Date au format YYYY-MM-DD
 */
export function getTodayDate(): string {
  const now = new Date()
  // Paris: UTC+1 en hiver, UTC+2 en été
  // On utilise une méthode plus fiable avec Intl
  const parisTime = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)

  return parisTime // Format: YYYY-MM-DD
}

/**
 * Obtient la date et heure actuelle en timezone Paris
 * @returns Date ISO string ajustée pour Paris
 */
export function getNowParis(): Date {
  const now = new Date()
  const parisOffset = getParisOffset()
  return new Date(now.getTime() + parisOffset * 60 * 60 * 1000)
}

/**
 * Interface pour les périodes de dates
 */
export interface DatePeriod {
  startDate: string      // YYYY-MM-DD
  endDate: string        // YYYY-MM-DD
  startDateTime: string  // ISO avec T00:00:00.000Z
  endDateTime: string    // ISO avec T23:59:59.999Z
  days: number
}

/**
 * Calcule une période de dates avec timezone Paris
 * Par défaut: aujourd'hui
 *
 * IMPORTANT: Les dates sont converties en UTC avec le décalage Paris
 * pour que les requêtes SQL matchent correctement les heures Paris.
 *
 * Exemple pour le 22/12/2024 à Paris (UTC+1 hiver):
 * - Début Paris 00:00 = UTC 21/12 23:00
 * - Fin Paris 23:59:59 = UTC 22/12 22:59:59
 *
 * @param startDate - Date de début (optionnel, défaut: aujourd'hui)
 * @param endDate - Date de fin (optionnel, défaut: aujourd'hui)
 * @returns Objet DatePeriod
 */
export function calculatePeriod(startDate?: string | null, endDate?: string | null): DatePeriod {
  const today = getTodayDate()

  const start = startDate || today
  const end = endDate || today

  // Normaliser les dates (enlever la partie temps si présente)
  const startDateOnly = start.includes('T') ? start.split('T')[0] : start
  const endDateOnly = end.includes('T') ? end.split('T')[0] : end

  // Calculer l'offset Paris actuel (1h en hiver, 2h en été)
  const parisOffset = getParisOffset()

  // Convertir minuit Paris en UTC (reculer de l'offset)
  // Ex: 22/12 00:00 Paris (UTC+1) = 21/12 23:00 UTC
  const startParisDate = new Date(`${startDateOnly}T00:00:00`)
  startParisDate.setHours(startParisDate.getHours() - parisOffset)

  // Convertir 23:59:59 Paris en UTC
  // Ex: 22/12 23:59:59 Paris (UTC+1) = 22/12 22:59:59 UTC
  const endParisDate = new Date(`${endDateOnly}T23:59:59.999`)
  endParisDate.setHours(endParisDate.getHours() - parisOffset)

  const startDateTime = startParisDate.toISOString()
  const endDateTime = endParisDate.toISOString()

  // Calculer le nombre de jours
  const days = Math.ceil(
    (new Date(endDateOnly).getTime() - new Date(startDateOnly).getTime()) / (1000 * 60 * 60 * 24)
  ) + 1

  console.log(`[dates] Period ${startDateOnly} -> ${endDateOnly} (Paris UTC+${parisOffset})`)
  console.log(`[dates] UTC range: ${startDateTime} -> ${endDateTime}`)

  return {
    startDate: startDateOnly,
    endDate: endDateOnly,
    startDateTime,
    endDateTime,
    days
  }
}

/**
 * Calcule le décalage horaire de Paris (1 ou 2 selon DST)
 * Exporté pour utilisation dans calculatePeriod
 */
export function getParisOffset(): number {
  // Vérifier si on est en heure d'été ou d'hiver
  // En Europe, l'heure d'été va du dernier dimanche de mars au dernier dimanche d'octobre
  const now = new Date()
  const year = now.getFullYear()

  // Dernier dimanche de mars
  const marchLastSunday = getLastSundayOfMonth(year, 2) // Mars = 2 (0-indexed)

  // Dernier dimanche d'octobre
  const octoberLastSunday = getLastSundayOfMonth(year, 9) // Octobre = 9 (0-indexed)

  // Comparer avec la date actuelle
  if (now >= marchLastSunday && now < octoberLastSunday) {
    return 2 // Heure d'été (CEST)
  }
  return 1 // Heure d'hiver (CET)
}

/**
 * Obtient le dernier dimanche d'un mois donné
 */
function getLastSundayOfMonth(year: number, month: number): Date {
  // Dernier jour du mois
  const lastDay = new Date(year, month + 1, 0)
  // Reculer jusqu'au dimanche
  const dayOfWeek = lastDay.getDay()
  const daysToSubtract = dayOfWeek === 0 ? 0 : dayOfWeek
  lastDay.setDate(lastDay.getDate() - daysToSubtract)
  // Changement à 2h du matin
  lastDay.setHours(2, 0, 0, 0)
  return lastDay
}

/**
 * Calcule la période précédente de même durée
 * Utile pour les comparaisons (évolution %)
 */
export function calculatePreviousPeriod(period: DatePeriod): DatePeriod {
  const duration = new Date(period.endDateTime).getTime() - new Date(period.startDateTime).getTime()

  const previousEnd = new Date(new Date(period.startDateTime).getTime() - 1)
  const previousStart = new Date(previousEnd.getTime() - duration + 1)

  return {
    startDate: previousStart.toISOString().split('T')[0],
    endDate: previousEnd.toISOString().split('T')[0],
    startDateTime: previousStart.toISOString(),
    endDateTime: previousEnd.toISOString(),
    days: period.days
  }
}

/**
 * Obtient le premier jour du mois courant
 */
export function getFirstDayOfMonth(): string {
  const today = getTodayDate()
  return today.substring(0, 8) + '01'
}

/**
 * Obtient le premier jour de la semaine (lundi)
 */
export function getFirstDayOfWeek(): string {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1 // Lundi = 0
  const monday = new Date(now)
  monday.setDate(now.getDate() - diff)
  return monday.toISOString().split('T')[0]
}

/**
 * Parse une date au format français ou ISO
 * Accepte: 20/12, 20/12/2025, 2025-12-20, hier, aujourd'hui
 */
export function parseDate(input: string): string | null {
  if (!input) return null

  const trimmed = input.trim().toLowerCase()
  const today = getTodayDate()

  // Mots-clés
  if (trimmed === 'aujourd\'hui' || trimmed === 'aujourdhui' || trimmed === 'today') {
    return today
  }
  if (trimmed === 'hier' || trimmed === 'yesterday') {
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    return yesterday.toISOString().split('T')[0]
  }

  // Format ISO: 2025-12-20
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }

  // Format FR court: 20/12
  if (/^\d{1,2}\/\d{1,2}$/.test(trimmed)) {
    const [day, month] = trimmed.split('/')
    const year = new Date().getFullYear()
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  // Format FR long: 20/12/2025
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('/')
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  return null
}

/**
 * Formate une date pour affichage (français)
 */
export function formatDateFR(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

/**
 * Formate une date courte pour affichage
 */
export function formatDateShort(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
}
