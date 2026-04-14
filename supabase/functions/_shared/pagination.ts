/**
 * Utilitaires de pagination pour Supabase
 * Version: 1.1
 *
 * Gère la limite de 1000 lignes par requête de Supabase
 *
 * ⚠️ ATTENTION: La query DOIT avoir .order('id') pour une pagination stable !
 * Sans ORDER BY, .range() peut retourner des lignes en double entre les pages.
 * Bug identifié en janvier 2026: vendor_ranking retournait des montants doublés.
 */

/**
 * Récupère toutes les lignes avec pagination automatique
 * Contourne la limite de 1000 lignes de Supabase
 *
 * ⚠️ CRITIQUE: La query DOIT avoir .order('id') ou un autre ORDER BY stable !
 * Exemple:
 *   ❌ supabase.from('sale_items').select('*').gte('sale_date', startDate)
 *   ✅ supabase.from('sale_items').select('*').gte('sale_date', startDate).order('id')
 *
 * @param query - Query Supabase (DOIT avoir .order() pour pagination stable)
 * @param pageSize - Taille de page (défaut: 1000)
 * @param maxRows - Limite max de lignes (défaut: 50000 pour sécurité)
 * @returns Array de toutes les lignes
 */
export async function fetchAllRows<T = any>(
  query: any,
  pageSize = 1000,
  maxRows = 50000
): Promise<T[]> {
  let allData: T[] = []
  let from = 0
  let hasMore = true

  while (hasMore && allData.length < maxRows) {
    const { data, error } = await query.range(from, from + pageSize - 1)

    if (error) throw error

    if (data && data.length > 0) {
      allData = allData.concat(data)
      from += pageSize
      hasMore = data.length === pageSize
    } else {
      hasMore = false
    }
  }

  return allData
}

/**
 * Récupère les données par chunks (pour les requêtes avec IN)
 * Utile quand on a une liste d'IDs à filtrer
 *
 * @param ids - Liste d'IDs à filtrer
 * @param fetchFn - Fonction qui prend un chunk d'IDs et retourne les données
 * @param chunkSize - Taille de chunk (défaut: 500)
 * @returns Array de toutes les lignes
 */
export async function fetchByChunks<T = any>(
  ids: (number | string)[],
  fetchFn: (chunkIds: (number | string)[]) => Promise<T[]>,
  chunkSize = 500
): Promise<T[]> {
  let allData: T[] = []

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const data = await fetchFn(chunk)
    allData = allData.concat(data)
  }

  return allData
}

/**
 * Récupère les données paginées depuis une table Supabase
 * Version simplifiée avec gestion d'erreur intégrée
 *
 * @param supabase - Client Supabase
 * @param table - Nom de la table
 * @param select - Colonnes à sélectionner
 * @param filters - Filtres à appliquer (optionnel)
 * @param orderBy - Colonne de tri (optionnel)
 * @param pageSize - Taille de page (défaut: 1000)
 */
export async function fetchPaginated<T = any>(
  supabase: any,
  table: string,
  select: string,
  filters?: { column: string; value: any; operator?: string }[],
  orderBy?: { column: string; ascending?: boolean },
  pageSize = 1000
): Promise<T[]> {
  let query = supabase.from(table).select(select)

  // Appliquer les filtres
  if (filters) {
    for (const filter of filters) {
      const op = filter.operator || 'eq'
      switch (op) {
        case 'eq':
          query = query.eq(filter.column, filter.value)
          break
        case 'neq':
          query = query.neq(filter.column, filter.value)
          break
        case 'gt':
          query = query.gt(filter.column, filter.value)
          break
        case 'gte':
          query = query.gte(filter.column, filter.value)
          break
        case 'lt':
          query = query.lt(filter.column, filter.value)
          break
        case 'lte':
          query = query.lte(filter.column, filter.value)
          break
        case 'like':
          query = query.like(filter.column, filter.value)
          break
        case 'ilike':
          query = query.ilike(filter.column, filter.value)
          break
        case 'in':
          query = query.in(filter.column, filter.value)
          break
      }
    }
  }

  // Appliquer le tri (obligatoire pour pagination stable)
  if (orderBy) {
    query = query.order(orderBy.column, { ascending: orderBy.ascending ?? true })
  } else {
    query = query.order('id', { ascending: true })
  }

  return fetchAllRows<T>(query, pageSize)
}
