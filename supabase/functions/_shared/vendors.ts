/**
 * Utilitaires pour la gestion des vendeurs
 * Version: 1.0
 *
 * Gère les lookups vendeurs, le mapping cross-API, et les exclusions
 */

import { EXCLUDED_VENDOR_IDS, VENDOR_SECONDARY_TO_PRIMARY } from './constants.ts'

/**
 * Interface Vendor
 */
export interface Vendor {
  id: number
  first_name: string
  last_name: string
  user_name?: string
  email?: string
  store_id?: number
  is_active: boolean
  api_source?: string
  canonical_vendor_id?: number
}

/**
 * Interface pour les stats vendeur
 */
export interface VendorStats {
  vendor_id: number
  vendor_name: string
  total_revenue: number
  total_transactions: number
  avg_basket: number
  stores?: Set<number>
}

/**
 * Cache des vendeurs (évite les requêtes répétées)
 */
let vendorCache: Map<number, Vendor> | null = null
let vendorCacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Charge tous les vendeurs dans le cache (actifs et inactifs pour analyses historiques)
 * Version 2.2
 */
export async function loadVendors(supabase: any, forceRefresh = false, activeOnly = false): Promise<Map<number, Vendor>> {
  const now = Date.now()

  if (!forceRefresh && vendorCache && (now - vendorCacheTimestamp) < CACHE_TTL) {
    return vendorCache
  }

  let query = supabase
    .from('vendors')
    .select('id, first_name, last_name, user_name, email, store_id, is_active, api_source, canonical_vendor_id')

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query

  if (error) throw error

  vendorCache = new Map()
  for (const vendor of data || []) {
    // Exclure les comptes techniques
    if (!EXCLUDED_VENDOR_IDS.includes(vendor.id)) {
      vendorCache.set(vendor.id, vendor)
    }
  }

  vendorCacheTimestamp = now
  console.log(`Loaded ${vendorCache.size} active vendors (excluded ${EXCLUDED_VENDOR_IDS.length} technical accounts)`)

  return vendorCache
}

/**
 * Cherche un vendeur par ID
 */
export async function findVendorById(supabase: any, vendorId: number): Promise<Vendor | null> {
  const cache = await loadVendors(supabase)
  return cache.get(vendorId) || null
}

/**
 * Normalise une chaîne pour la recherche fuzzy
 */
function normalizeForSearch(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Supprimer accents
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Calcule un score de similarité entre deux chaînes
 */
function calculateSimilarity(s1: string, s2: string): number {
  const n1 = normalizeForSearch(s1)
  const n2 = normalizeForSearch(s2)

  if (n1 === n2) return 1.0
  if (n1.includes(n2) || n2.includes(n1)) return 0.9

  const words1 = n1.split(' ')
  const words2 = n2.split(' ')
  const commonWords = words1.filter(w => words2.some(w2 => w2.includes(w) || w.includes(w2)))

  if (commonWords.length > 0 && commonWords.some(w => w.length >= 3)) {
    return 0.5 + (commonWords.length / Math.max(words1.length, words2.length)) * 0.4
  }
  return 0
}

/**
 * Cherche un vendeur par nom (prénom, nom, ou nom complet)
 * Version 2.2 - Recherche tous les vendeurs (actifs et inactifs pour analyses historiques)
 */
export async function findVendorByName(
  supabase: any,
  name: string,
  activeOnly = false // Par défaut: cherche tous les vendeurs pour analyses historiques
): Promise<{ vendor: Vendor | null; error?: string; suggestions?: Vendor[] }> {
  const nameLower = name.toLowerCase().trim()
  const nameParts = nameLower.split(/\s+/)

  // Construire la requête OR pour chaque partie du nom
  let orConditions: string[] = []
  nameParts.forEach(part => {
    if (part.length >= 2) {
      orConditions.push(`first_name.ilike.%${part}%`)
      orConditions.push(`last_name.ilike.%${part}%`)
    }
  })
  // Ajouter aussi le nom complet au cas où
  orConditions.push(`user_name.ilike.%${name}%`)

  // Recherche dans la base - NE FILTRE PAS sur is_active par défaut
  let query = supabase
    .from('vendors')
    .select('id, first_name, last_name, user_name, email, store_id, is_active, api_source, canonical_vendor_id')
    .or(orConditions.join(','))

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query

  if (error) throw error

  // Filtrer les comptes techniques
  const filtered = (data || []).filter((v: Vendor) => !EXCLUDED_VENDOR_IDS.includes(v.id))

  if (filtered.length === 0) {
    // Aucun résultat SQL, essayer recherche fuzzy sur tous les vendeurs (actifs et inactifs)
    let fuzzyQuery = supabase
      .from('vendors')
      .select('id, first_name, last_name, user_name, email, store_id, is_active, api_source, canonical_vendor_id')

    if (activeOnly) {
      fuzzyQuery = fuzzyQuery.eq('is_active', true)
    }

    const { data: allVendors } = await fuzzyQuery

    const suggestions = (allVendors || [])
      .filter((v: Vendor) => !EXCLUDED_VENDOR_IDS.includes(v.id))
      .map((v: Vendor) => ({
        ...v,
        score: Math.max(
          calculateSimilarity(`${v.first_name} ${v.last_name}`, name),
          calculateSimilarity(`${v.last_name} ${v.first_name}`, name)
        )
      }))
      .filter((v: any) => v.score > 0.3)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5)

    if (suggestions.length > 0 && suggestions[0].score > 0.7) {
      // Match assez bon, retourner directement
      return { vendor: suggestions[0] }
    }

    return {
      vendor: null,
      error: `Vendeur "${name}" non trouvé`,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    }
  }

  if (filtered.length === 1) {
    return { vendor: filtered[0] }
  }

  // Plusieurs résultats: calculer le meilleur match
  const scored = filtered.map((v: Vendor) => ({
    ...v,
    score: Math.max(
      calculateSimilarity(`${v.first_name} ${v.last_name}`, name),
      calculateSimilarity(`${v.last_name} ${v.first_name}`, name),
      calculateSimilarity(v.first_name, name),
      calculateSimilarity(v.last_name, name)
    )
  })).sort((a: any, b: any) => b.score - a.score)

  // Si le meilleur score est significativement meilleur, le retourner
  if (scored[0].score > 0.7 && (scored.length === 1 || scored[0].score > scored[1].score + 0.2)) {
    return { vendor: scored[0] }
  }

  // Match exact sur prénom + nom
  const exactMatch = filtered.find((v: Vendor) => {
    const fullName = normalizeForSearch(`${v.first_name} ${v.last_name}`)
    const searchName = normalizeForSearch(name)
    return fullName === searchName ||
           nameParts.every(part => fullName.includes(normalizeForSearch(part)))
  })
  if (exactMatch) {
    return { vendor: exactMatch }
  }

  // Retourner le meilleur match si score > 0.5
  if (scored[0].score > 0.5) {
    return { vendor: scored[0] }
  }

  // Plusieurs correspondances ambiguës
  return {
    vendor: null,
    error: `Plusieurs vendeurs trouvés pour "${name}". Précisez:`,
    suggestions: scored.slice(0, 5)
  }
}

/**
 * Obtient le nom complet d'un vendeur
 */
export function getVendorFullName(vendor: Vendor): string {
  return `${vendor.first_name} ${vendor.last_name}`
}

/**
 * Mappe un vendor_id de l'API secondary vers l'API main
 */
export function mapVendorSecondaryToMain(secondaryId: number): number {
  return VENDOR_SECONDARY_TO_PRIMARY[secondaryId] || secondaryId
}

/**
 * Vérifie si un vendeur est un compte technique
 */
export function isExcludedVendor(vendorId: number): boolean {
  return EXCLUDED_VENDOR_IDS.includes(vendorId)
}

/**
 * Crée un map vendorId -> VendorStats à partir des ventes
 */
export function aggregateVendorStats(
  sales: any[],
  vendorMap: Map<number, Vendor>
): Map<number, VendorStats> {
  const stats = new Map<number, VendorStats>()

  for (const sale of sales) {
    if (!sale.vendor_id) continue

    const vendor = vendorMap.get(sale.vendor_id)
    if (!vendor) continue

    if (!stats.has(sale.vendor_id)) {
      stats.set(sale.vendor_id, {
        vendor_id: sale.vendor_id,
        vendor_name: getVendorFullName(vendor),
        total_revenue: 0,
        total_transactions: 0,
        avg_basket: 0,
        stores: new Set()
      })
    }

    const vendorStats = stats.get(sale.vendor_id)!
    vendorStats.total_revenue += parseFloat(sale.total_amount_with_tax || '0')
    vendorStats.total_transactions += 1
    if (sale.store_id) {
      vendorStats.stores?.add(sale.store_id)
    }
  }

  // Calculer le panier moyen
  for (const [, vendorStats] of stats) {
    if (vendorStats.total_transactions > 0) {
      vendorStats.avg_basket = vendorStats.total_revenue / vendorStats.total_transactions
    }
  }

  return stats
}

/**
 * Résout le canonical_vendor_id pour un vendeur
 * Permet le cross-API reliable
 */
export async function resolveCanonicalVendor(
  supabase: any,
  vendorId: number,
  apiSource: string
): Promise<number | null> {
  // D'abord chercher le vendor
  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, canonical_vendor_id')
    .eq('id', vendorId)
    .single()

  if (!vendor) return null

  // Si canonical_vendor_id est défini, l'utiliser
  if (vendor.canonical_vendor_id) {
    return vendor.canonical_vendor_id
  }

  // Sinon, chercher via le mapping cross-API
  if (apiSource === 'secondary') {
    const mainId = mapVendorSecondaryToMain(vendorId)
    if (mainId !== vendorId) {
      // Chercher le canonical du vendor main
      const { data: mainVendor } = await supabase
        .from('vendors')
        .select('canonical_vendor_id')
        .eq('id', mainId)
        .eq('api_source', 'main')
        .single()

      return mainVendor?.canonical_vendor_id || mainId
    }
  }

  return vendorId
}
