/**
 * Utilitaires pour la gestion des catégories
 * Version: 3.0 - Utilise category_hierarchy_mapping (nouveau référentiel)
 *
 * IMPORTANT: Les catégories avec noms similaires ont des parents différents !
 * - "Fruité" (50 ML) vs "Fruités" (10 ML)
 * - "Gourmand" (50 ML) vs "Gourmands" (10 ML)
 * - "Batterie Intégrée" (Kits) vs "Batterie Intégrée" (Boxs Mods)
 *
 * Utilise la table category_hierarchy_mapping pour:
 * - Résolution de hiérarchie (parent, grandparent)
 * - Recherche intelligente (trouve toutes les sous-catégories d'un parent)
 * - Désambiguïsation par parent
 */

import { VIRTUAL_CATEGORY_IDS } from './constants.ts'

/**
 * Interface pour les catégories du mapping hiérarchique
 */
export interface HierarchyCategory {
  hiboutik_category_id: number
  category_name: string
  normalized_name: string
  parent_id: number | null
  parent_name: string | null
  grandparent_id: number | null
  grandparent_name: string | null
  level: number
  api_source: string
  is_virtual: boolean
}

/**
 * Interface pour les résultats de recherche
 */
export interface CategoryMatch {
  hiboutik_category_id: number
  category_name: string
  parent_name: string | null
  grandparent_name: string | null
  level: number
  match_type: 'exact' | 'partial' | 'parent' | 'children'
}

/**
 * Interface pour le résultat de resolveCategoryByName
 */
export interface ResolvedCategory {
  found: boolean
  id: number | null
  name: string | null
  parent_name: string | null
  grandparent_name: string | null
  level: number
}

/**
 * Cache des catégories
 */
let hierarchyCache: Map<number, HierarchyCategory> | null = null
let hierarchyCacheTimestamp = 0
const CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Charge toutes les catégories depuis category_hierarchy_mapping
 */
export async function loadHierarchyMapping(
  supabase: any,
  forceRefresh = false
): Promise<Map<number, HierarchyCategory>> {
  const now = Date.now()

  if (!forceRefresh && hierarchyCache && (now - hierarchyCacheTimestamp) < CACHE_TTL) {
    return hierarchyCache
  }

  const { data, error } = await supabase
    .from('category_hierarchy_mapping')
    .select('*')

  if (error) throw error

  hierarchyCache = new Map()
  for (const cat of data || []) {
    hierarchyCache.set(cat.hiboutik_category_id, cat)
  }

  hierarchyCacheTimestamp = now
  console.log(`[categories] Loaded ${hierarchyCache.size} categories from hierarchy mapping`)

  return hierarchyCache
}

/**
 * Résout une catégorie par son nom
 * Retourne la première correspondance exacte trouvée
 *
 * @param supabase - Client Supabase
 * @param categoryName - Nom de la catégorie à rechercher
 * @param parentFilter - Optionnel: filtrer par parent pour désambiguïser
 * @returns ResolvedCategory avec found=true si trouvée
 */
export async function resolveCategoryByName(
  supabase: any,
  categoryName: string,
  parentFilter?: string
): Promise<ResolvedCategory> {
  if (!categoryName || categoryName.trim() === '') {
    return { found: false, id: null, name: null, parent_name: null, grandparent_name: null, level: 0 }
  }

  const mapping = await loadHierarchyMapping(supabase)
  const searchTerm = categoryName.toLowerCase().trim()
  const parentTerm = parentFilter?.toLowerCase().trim()

  // Chercher correspondance exacte
  for (const [id, cat] of mapping) {
    const catNameLower = cat.category_name.toLowerCase()
    const normalizedLower = cat.normalized_name?.toLowerCase() || catNameLower

    if (catNameLower === searchTerm || normalizedLower === searchTerm) {
      // Si parent spécifié, vérifier
      if (parentTerm) {
        const parentLower = cat.parent_name?.toLowerCase()
        const grandparentLower = cat.grandparent_name?.toLowerCase()
        if (parentLower !== parentTerm && grandparentLower !== parentTerm) {
          continue
        }
      }

      return {
        found: true,
        id: id,
        name: cat.category_name,
        parent_name: cat.parent_name,
        grandparent_name: cat.grandparent_name,
        level: cat.level
      }
    }
  }

  // Si pas de correspondance exacte, chercher partiel
  for (const [id, cat] of mapping) {
    const catNameLower = cat.category_name.toLowerCase()

    if (catNameLower.includes(searchTerm) || searchTerm.includes(catNameLower)) {
      if (parentTerm) {
        const parentLower = cat.parent_name?.toLowerCase()
        const grandparentLower = cat.grandparent_name?.toLowerCase()
        if (parentLower !== parentTerm && grandparentLower !== parentTerm) {
          continue
        }
      }

      return {
        found: true,
        id: id,
        name: cat.category_name,
        parent_name: cat.parent_name,
        grandparent_name: cat.grandparent_name,
        level: cat.level
      }
    }
  }

  return { found: false, id: null, name: null, parent_name: null, grandparent_name: null, level: 0 }
}

/**
 * FONCTION PRINCIPALE: Recherche intelligente de catégories
 *
 * Supporte:
 * - Recherche par nom exact: "Fruités" → catégorie 97
 * - Recherche par parent: "CBD" → retourne TOUTES les sous-catégories (Fleurs, Résines, etc.)
 * - Recherche combinée: "Batterie Intégrée" + parentFilter="Kits" → catégorie 134
 * - Recherche multiple: "Fleurs, Résines" → retourne les deux catégories
 *
 * @param query - Terme de recherche (peut contenir virgules pour OR)
 * @param supabase - Client Supabase
 * @param options - Options de recherche
 * @returns Liste des catégories trouvées
 */
export async function findCategories(
  query: string,
  supabase: any,
  options: {
    parentFilter?: string       // Filtrer par parent (ex: "10 ML", "Kits")
    includeChildren?: boolean   // Si true, inclut les enfants d'une catégorie parent
    exactMatch?: boolean        // Si true, correspondance exacte uniquement
  } = {}
): Promise<CategoryMatch[]> {
  const { parentFilter, includeChildren = true, exactMatch = false } = options

  if (!query || query.trim() === '') {
    return []
  }

  const mapping = await loadHierarchyMapping(supabase)
  const results: CategoryMatch[] = []
  const seenIds = new Set<number>()

  // Support recherche multiple: "Fleurs, Résines" ou "Fleurs + Résines"
  const terms = query.split(/\s*[,+]\s*/).map(t => t.trim().toLowerCase()).filter(Boolean)

  for (const term of terms) {
    // 1. Chercher correspondance exacte sur category_name
    for (const [id, cat] of mapping) {
      if (seenIds.has(id)) continue

      const catNameLower = cat.category_name.toLowerCase()
      const normalizedLower = cat.normalized_name?.toLowerCase() || catNameLower

      // Correspondance exacte
      if (catNameLower === term || normalizedLower === term) {
        // Vérifier le filtre parent si spécifié
        if (parentFilter) {
          const parentLower = parentFilter.toLowerCase()
          if (cat.parent_name?.toLowerCase() !== parentLower &&
              cat.grandparent_name?.toLowerCase() !== parentLower) {
            continue
          }
        }

        results.push({
          hiboutik_category_id: id,
          category_name: cat.category_name,
          parent_name: cat.parent_name,
          grandparent_name: cat.grandparent_name,
          level: cat.level,
          match_type: 'exact'
        })
        seenIds.add(id)
      }
    }

    // 2. Si pas de correspondance exacte et pas exactMatch, chercher partiel
    if (results.length === 0 && !exactMatch) {
      for (const [id, cat] of mapping) {
        if (seenIds.has(id)) continue

        const catNameLower = cat.category_name.toLowerCase()

        if (catNameLower.includes(term) || term.includes(catNameLower)) {
          if (parentFilter) {
            const parentLower = parentFilter.toLowerCase()
            if (cat.parent_name?.toLowerCase() !== parentLower &&
                cat.grandparent_name?.toLowerCase() !== parentLower) {
              continue
            }
          }

          results.push({
            hiboutik_category_id: id,
            category_name: cat.category_name,
            parent_name: cat.parent_name,
            grandparent_name: cat.grandparent_name,
            level: cat.level,
            match_type: 'partial'
          })
          seenIds.add(id)
        }
      }
    }

    // 3. Chercher les enfants si c'est une catégorie parent
    if (includeChildren && results.length === 0) {
      for (const [id, cat] of mapping) {
        if (seenIds.has(id)) continue

        const parentLower = cat.parent_name?.toLowerCase()
        const grandparentLower = cat.grandparent_name?.toLowerCase()

        if (parentLower === term || grandparentLower === term) {
          results.push({
            hiboutik_category_id: id,
            category_name: cat.category_name,
            parent_name: cat.parent_name,
            grandparent_name: cat.grandparent_name,
            level: cat.level,
            match_type: 'children'
          })
          seenIds.add(id)
        }
      }
    }
  }

  return results
}

/**
 * Trouve toutes les sous-catégories d'une catégorie parent
 * Ex: getChildCategories("CBD") → [Fleurs, Résines, Headshop, Épicerie, ...]
 */
export async function getChildCategories(
  parentName: string,
  supabase: any
): Promise<CategoryMatch[]> {
  const mapping = await loadHierarchyMapping(supabase)
  const results: CategoryMatch[] = []
  const parentLower = parentName.toLowerCase()

  for (const [id, cat] of mapping) {
    if (cat.parent_name?.toLowerCase() === parentLower ||
        cat.grandparent_name?.toLowerCase() === parentLower) {
      results.push({
        hiboutik_category_id: id,
        category_name: cat.category_name,
        parent_name: cat.parent_name,
        grandparent_name: cat.grandparent_name,
        level: cat.level,
        match_type: 'children'
      })
    }
  }

  return results
}

/**
 * Construit un filtre SQL pour Supabase basé sur les catégories trouvées
 * @param categories - Catégories trouvées par findCategories()
 * @returns Clause IN pour hiboutik_category_id
 */
export function buildCategoryIdFilter(categories: CategoryMatch[]): number[] {
  return categories.map(c => c.hiboutik_category_id)
}

/**
 * Construit un filtre par noms de catégories
 */
export function buildCategoryNameFilter(categories: CategoryMatch[]): string[] {
  return [...new Set(categories.map(c => c.category_name))]
}

/**
 * Vérifie si une catégorie est virtuelle (à exclure des analytics)
 */
export function isVirtualCategory(categoryId: number | null): boolean {
  if (!categoryId) return false
  return VIRTUAL_CATEGORY_IDS.includes(categoryId)
}

/**
 * Filtre les items pour exclure les catégories virtuelles
 */
export function filterVirtualItems<T extends {
  hiboutik_category_id?: number;
  is_virtual_category?: boolean
}>(items: T[]): T[] {
  return items.filter(item => {
    if (item.is_virtual_category) return false
    if (item.hiboutik_category_id && VIRTUAL_CATEGORY_IDS.includes(item.hiboutik_category_id)) {
      return false
    }
    return true
  })
}

/**
 * Normalise une chaîne pour recherche (minuscules, sans accents)
 */
function normalizeForSearch(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/**
 * Recherche flexible de catégorie sur les 3 niveaux d'un item
 * Retourne true si le terme correspond à category_name, parent ou grandparent
 */
export function matchCategoryFlexible(
  item: { category_name?: string; parent_category_name?: string; grandparent_category_name?: string },
  searchTerm: string
): { matched: boolean; field: string } {
  const termNormalized = normalizeForSearch(searchTerm)

  if (item.category_name && normalizeForSearch(item.category_name) === termNormalized) {
    return { matched: true, field: 'category_name' }
  }

  if (item.parent_category_name && normalizeForSearch(item.parent_category_name) === termNormalized) {
    return { matched: true, field: 'parent_category_name' }
  }

  if (item.grandparent_category_name && normalizeForSearch(item.grandparent_category_name) === termNormalized) {
    return { matched: true, field: 'grandparent_category_name' }
  }

  return { matched: false, field: '' }
}

/**
 * Filtre les items par catégorie avec correspondance EXACTE
 * Supporte:
 * - Format "categorie|parent" pour désambiguïsation
 * - Multi-catégories OR: "Fleurs et Résines", "Fleurs, Résines", "Fleurs ou Résines"
 */
export function filterItemsByCategory<T extends {
  category_name?: string;
  parent_category_name?: string;
  grandparent_category_name?: string
}>(
  items: T[],
  categorySearch: string,
  parentSearch?: string
): T[] {
  let searchTerms: string[] = []
  let parentTerm = parentSearch

  // Support format "categorie|parent"
  let categoryPart = categorySearch
  if (categorySearch.includes('|') && !parentSearch) {
    const parts = categorySearch.split('|')
    categoryPart = parts[0].trim()
    parentTerm = parts[1]?.trim()
  }

  // Support multi-catégories OR: virgule, " et ", " ou ", " and ", " or "
  searchTerms = categoryPart
    .split(/[,]|\s+et\s+|\s+ou\s+|\s+and\s+|\s+or\s+/i)
    .map(t => normalizeForSearch(t.trim()))
    .filter(t => t.length > 0)

  if (searchTerms.length === 0) {
    return items
  }

  const parentNormalized = parentTerm ? normalizeForSearch(parentTerm) : null

  console.log(`[filterItemsByCategory] Terms (OR): ${searchTerms.join(' | ')}${parentNormalized ? `, parent: ${parentNormalized}` : ''}`)

  return items.filter(item => {
    const catNorm = item.category_name ? normalizeForSearch(item.category_name) : ''
    const parentNorm = item.parent_category_name ? normalizeForSearch(item.parent_category_name) : ''
    const grandparentNorm = item.grandparent_category_name ? normalizeForSearch(item.grandparent_category_name) : ''

    // OR logic: match si au moins un terme correspond
    const matchesAnyTerm = searchTerms.some(term => {
      // Correspondance exacte sur category_name, parent ou grandparent
      return catNorm === term || parentNorm === term || grandparentNorm === term
    })

    if (!matchesAnyTerm) return false

    // Si parent spécifié, vérifier aussi
    if (parentNormalized) {
      return parentNorm === parentNormalized || grandparentNorm === parentNormalized
    }

    return true
  })
}

/**
 * Agrège les items par nom de catégorie
 */
export function aggregateByCategoryName(
  items: any[],
  categoryField: 'category_name' | 'parent_category_name' = 'category_name'
): Map<string, { quantity: number; revenue: number; itemCount: number }> {
  const stats = new Map<string, { quantity: number; revenue: number; itemCount: number }>()

  for (const item of items) {
    const catName = item[categoryField]
    if (!catName) continue

    const key = catName
    if (!stats.has(key)) {
      stats.set(key, { quantity: 0, revenue: 0, itemCount: 0 })
    }

    const catStats = stats.get(key)!
    catStats.quantity += item.quantity || 0
    catStats.revenue += parseFloat(item.total_line || '0')
    catStats.itemCount += 1
  }

  return stats
}
