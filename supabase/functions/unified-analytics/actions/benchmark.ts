/**
 * Action: vendor_benchmark
 * Benchmark complet d'un vendeur vs équipe/magasin/historique
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import type { ExecutionContext, AnalyticsResult } from '../types.ts'
import { fetchAllRows } from '../../_shared/pagination.ts'
import { calculatePreviousPeriod } from '../../_shared/dates.ts'

const VERSION = '2.3-pagination-fix'

// Fonction de normalisation pour recherche fuzzy
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Supprimer les accents
    .replace(/\s+/g, ' ')  // Normaliser les espaces multiples
    .trim()
}

// Calcul de similarité (Levenshtein simplifié)
function similarity(s1: string, s2: string): number {
  const n1 = normalizeString(s1)
  const n2 = normalizeString(s2)

  // Correspondance exacte normalisée
  if (n1 === n2) return 1.0

  // Un contient l'autre
  if (n1.includes(n2) || n2.includes(n1)) return 0.9

  // Mots communs
  const words1 = n1.split(' ')
  const words2 = n2.split(' ')
  const commonWords = words1.filter(w => words2.some(w2 => w2.includes(w) || w.includes(w2)))

  // Si au moins un mot en commun ET assez long
  if (commonWords.length > 0 && commonWords.some(w => w.length >= 3)) {
    return 0.5 + (commonWords.length / Math.max(words1.length, words2.length)) * 0.4
  }

  return 0
}

// Vendeurs techniques à exclure
const EXCLUDED_VENDOR_IDS = [1, 1068]

/**
 * Handler pour vendor_benchmark
 * Benchmark complet d'un vendeur avec multiples dimensions
 *
 * Paramètres:
 * - vendor_id ou vendor_name: vendeur à analyser (requis)
 * - benchmark_against: 'team' | 'store' | 'all' | 'historical' - défaut: 'team'
 * - store_id: filtrer par magasin
 * - historical_days: jours historiques pour comparaison - défaut: 30
 * - include_categories: inclure ventilation par catégorie - défaut: false
 * - include_daily: inclure ventilation quotidienne - défaut: false
 */
export async function handleVendorBenchmark(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod, startTime } = context

  const vendorId = (params as any).vendor_id
  const vendorName = (params as any).vendor_name
  const benchmarkAgainst = (params as any).benchmark_against || 'team'
  const storeId = params.store_id
  const historicalDays = (params as any).historical_days || 30
  const includeCategories = (params as any).include_categories || false
  const includeDaily = (params as any).include_daily || false

  if (!vendorId && !vendorName) {
    return {
      success: false,
      action: 'vendor_benchmark' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: { error: 'vendor_id ou vendor_name requis' }
    }
  }

  // ============================================
  // 1. RÉSOUDRE LE VENDEUR
  // ============================================
  let targetVendor: any = null
  let linkedVendorIds: number[] = []

  // Ne pas filtrer sur is_active car tous les vendeurs peuvent avoir des ventes historiques
  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, first_name, last_name, user_name, store_id, canonical_vendor_id')

  const vendorMap: any = {}
  const canonicalMap: any = {}

  vendors?.forEach((v: any) => {
    if (EXCLUDED_VENDOR_IDS.includes(v.id)) return
    vendorMap[v.id] = v
    const canonicalId = v.canonical_vendor_id || v.id
    if (!canonicalMap[canonicalId]) {
      canonicalMap[canonicalId] = {
        id: canonicalId,
        name: `${v.first_name} ${v.last_name}`,
        linked_ids: [],
        store_id: v.store_id
      }
    }
    canonicalMap[canonicalId].linked_ids.push(v.id)
  })

  // Trouver le vendeur cible
  if (vendorId) {
    const vendor = vendorMap[vendorId]
    if (vendor) {
      targetVendor = vendor
      const canonicalId = vendor.canonical_vendor_id || vendor.id
      linkedVendorIds = canonicalMap[canonicalId]?.linked_ids || [vendorId]
    }
  } else if (vendorName) {
    // CORRECTION v2.1: Recherche fuzzy améliorée
    let bestMatch: { vendor: any; score: number } | null = null

    for (const v of Object.values(vendorMap) as any) {
      const fullName = `${v.first_name} ${v.last_name}`
      const reverseName = `${v.last_name} ${v.first_name}`  // Essayer aussi prénom/nom inversé
      const userName = v.user_name || ''

      // Calculer la meilleure similarité
      const scores = [
        similarity(fullName, vendorName),
        similarity(reverseName, vendorName),
        similarity(userName, vendorName),
        similarity(v.first_name || '', vendorName),
        similarity(v.last_name || '', vendorName)
      ]
      const maxScore = Math.max(...scores)

      if (maxScore > 0.5 && (!bestMatch || maxScore > bestMatch.score)) {
        bestMatch = { vendor: v, score: maxScore }
      }
    }

    if (bestMatch) {
      targetVendor = bestMatch.vendor
      const canonicalId = bestMatch.vendor.canonical_vendor_id || bestMatch.vendor.id
      linkedVendorIds = canonicalMap[canonicalId]?.linked_ids || [bestMatch.vendor.id]
    }
  }

  if (!targetVendor) {
    // CORRECTION v2.1: Suggérer les vendeurs les plus proches
    const suggestions = Object.values(vendorMap)
      .map((v: any) => ({
        name: `${v.first_name} ${v.last_name}`,
        id: v.id,
        score: vendorName ? similarity(`${v.first_name} ${v.last_name}`, vendorName) : 0
      }))
      .filter((v: any) => v.score > 0.2)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5)
      .map((v: any) => `${v.name} (id: ${v.id})`)

    return {
      success: false,
      action: 'vendor_benchmark' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: {
        error: `Vendeur non trouvé: ${vendorId || vendorName}`,
        suggestions: suggestions.length > 0 ? suggestions : ['Aucune suggestion - vérifiez l\'orthographe']
      }
    }
  }

  const targetCanonicalId = targetVendor.canonical_vendor_id || targetVendor.id

  // ============================================
  // 2. RÉCUPÉRER LES ITEMS PÉRIODE ACTUELLE (dénormalisé)
  // Utilise canonical_vendor_id directement depuis sale_items
  // ============================================
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, canonical_vendor_id, canonical_vendor_name, store_id, sale_date, total_line')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const currentItems = await fetchAllRows(itemsQuery.order('id'))

  // Agréger par vente unique - utilise canonical_vendor_id directement
  const currentSalesMap = new Map<number, { canonical_vendor_id: number; canonical_vendor_name: string; store_id: number; total: number; sale_date: string }>()
  currentItems.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId || !item.canonical_vendor_id) return
    if (!currentSalesMap.has(saleId)) {
      currentSalesMap.set(saleId, {
        canonical_vendor_id: item.canonical_vendor_id,
        canonical_vendor_name: item.canonical_vendor_name || `Vendeur ${item.canonical_vendor_id}`,
        store_id: item.store_id,
        total: 0,
        sale_date: item.sale_date
      })
    }
    currentSalesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const currentSales = Array.from(currentSalesMap.entries()).map(([id, data]) => ({
    id,
    canonical_vendor_id: data.canonical_vendor_id,
    canonical_vendor_name: data.canonical_vendor_name,
    store_id: data.store_id,
    total_amount_with_tax: data.total.toString(),
    sale_date: data.sale_date
  }))

  // ============================================
  // 3. RÉCUPÉRER L'HISTORIQUE (dénormalisé)
  // Utilise canonical_vendor_id directement depuis sale_items
  // ============================================
  const historicalStart = new Date(new Date(period.startDateTime).getTime() - historicalDays * 24 * 60 * 60 * 1000)
  const historicalEnd = new Date(period.startDateTime)

  let histItemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, canonical_vendor_id, canonical_vendor_name, store_id, sale_date, total_line')
    .gte('sale_date', historicalStart.toISOString())
    .lt('sale_date', historicalEnd.toISOString())

  if (storeId) histItemsQuery = histItemsQuery.eq('store_id', storeId)

  const historicalItems = await fetchAllRows(histItemsQuery.order('id'))

  // Agréger par vente unique - utilise canonical_vendor_id directement
  const histSalesMap = new Map<number, { canonical_vendor_id: number; canonical_vendor_name: string; store_id: number; total: number; sale_date: string }>()
  historicalItems.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId || !item.canonical_vendor_id) return
    if (!histSalesMap.has(saleId)) {
      histSalesMap.set(saleId, {
        canonical_vendor_id: item.canonical_vendor_id,
        canonical_vendor_name: item.canonical_vendor_name || `Vendeur ${item.canonical_vendor_id}`,
        store_id: item.store_id,
        total: 0,
        sale_date: item.sale_date
      })
    }
    histSalesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const historicalSales = Array.from(histSalesMap.entries()).map(([id, data]) => ({
    id,
    canonical_vendor_id: data.canonical_vendor_id,
    canonical_vendor_name: data.canonical_vendor_name,
    store_id: data.store_id,
    total_amount_with_tax: data.total.toString(),
    sale_date: data.sale_date
  }))

  // ============================================
  // 4. CALCULER LES STATS PAR VENDEUR (CANONICAL)
  // Utilise canonical_vendor_id directement depuis les ventes agrégées
  // ============================================
  const currentStats = aggregateByCanonical(currentSales)
  const historicalStats = aggregateByCanonical(historicalSales)

  // Stats du vendeur cible
  const targetCurrent = currentStats[targetCanonicalId] || {
    revenue: 0, transactions: 0, daily: {}
  }
  const targetHistorical = historicalStats[targetCanonicalId] || {
    revenue: 0, transactions: 0, daysWorked: 0
  }

  // ============================================
  // 5. CALCULER LES BENCHMARKS
  // ============================================
  const allVendorStats = Object.values(currentStats).filter((v: any) => v.transactions > 0)

  // Moyenne équipe
  const teamTotalRevenue = allVendorStats.reduce((sum: number, v: any) => sum + v.revenue, 0)
  const teamTotalTransactions = allVendorStats.reduce((sum: number, v: any) => sum + v.transactions, 0)
  const teamAvgRevenue = allVendorStats.length > 0 ? teamTotalRevenue / allVendorStats.length : 0
  const teamAvgTransactions = allVendorStats.length > 0 ? teamTotalTransactions / allVendorStats.length : 0
  const teamAvgBasket = teamTotalTransactions > 0 ? teamTotalRevenue / teamTotalTransactions : 0

  // Panier moyen du vendeur
  const vendorAvgBasket = targetCurrent.transactions > 0
    ? targetCurrent.revenue / targetCurrent.transactions
    : 0

  // Rang
  const sortedByRevenue = [...allVendorStats].sort((a: any, b: any) => b.revenue - a.revenue)
  const vendorRank = sortedByRevenue.findIndex((v: any) => v.canonicalId === targetCanonicalId) + 1

  // Top performer
  const topPerformer = sortedByRevenue[0] || null

  // Moyenne historique journalière du vendeur
  const historicalDaysWorked = Object.keys(targetHistorical.daily || {}).length || 1
  const historicalDailyAvg = historicalDaysWorked > 0
    ? targetHistorical.revenue / historicalDaysWorked
    : 0

  // Jours travaillés période actuelle
  const currentDaysWorked = Object.keys(targetCurrent.daily || {}).length || 1
  const currentDailyAvg = targetCurrent.revenue / currentDaysWorked

  // ============================================
  // 6. CONSTRUIRE LE BENCHMARK
  // ============================================
  const benchmark: any = {
    type: benchmarkAgainst,

    vs_team: {
      team_avg_revenue: parseFloat(teamAvgRevenue.toFixed(2)),
      team_avg_transactions: Math.round(teamAvgTransactions),
      team_avg_basket: parseFloat(teamAvgBasket.toFixed(2)),
      vendor_vs_team_revenue: parseFloat((targetCurrent.revenue - teamAvgRevenue).toFixed(2)),
      vendor_vs_team_percent: teamAvgRevenue > 0
        ? parseFloat(((targetCurrent.revenue - teamAvgRevenue) / teamAvgRevenue * 100).toFixed(2))
        : 0,
      is_above_average: targetCurrent.revenue > teamAvgRevenue,
      performance_label: getPerformanceLabel(targetCurrent.revenue, teamAvgRevenue)
    },

    vs_historical: {
      historical_days: historicalDays,
      historical_daily_avg: parseFloat(historicalDailyAvg.toFixed(2)),
      current_daily_avg: parseFloat(currentDailyAvg.toFixed(2)),
      daily_evolution_percent: historicalDailyAvg > 0
        ? parseFloat(((currentDailyAvg - historicalDailyAvg) / historicalDailyAvg * 100).toFixed(2))
        : 0,
      is_improving: currentDailyAvg > historicalDailyAvg,
      trend_label: currentDailyAvg >= historicalDailyAvg * 1.1 ? 'En progression'
        : currentDailyAvg >= historicalDailyAvg * 0.9 ? 'Stable'
        : 'En baisse'
    },

    vs_top_performer: topPerformer ? {
      top_performer_name: topPerformer.name,
      top_performer_revenue: parseFloat(topPerformer.revenue.toFixed(2)),
      gap_to_top: parseFloat((topPerformer.revenue - targetCurrent.revenue).toFixed(2)),
      percent_of_top: topPerformer.revenue > 0
        ? parseFloat((targetCurrent.revenue / topPerformer.revenue * 100).toFixed(2))
        : 100,
      vendor_is_top: targetCanonicalId === topPerformer.canonicalId
    } : null
  }

  // ============================================
  // 7. VENTILATION PAR CATÉGORIE (optionnel) - utilise currentItems déjà récupérés
  // ============================================
  let categoryBreakdown: any[] = []
  if (includeCategories) {
    // Filtrer les items du vendeur depuis currentItems (déjà chargés)
    const vendorItems = currentItems.filter((item: any) =>
      linkedVendorIds.includes(item.vendor_id)
    )

    if (vendorItems.length > 0) {
      // Récupérer les catégories pour ces items
      const vendorSaleIds = [...new Set(vendorItems.map((item: any) => item.hiboutik_sale_id))]

      let allCatItems: any[] = []
      for (let i = 0; i < vendorSaleIds.length; i += 500) {
        const chunk = vendorSaleIds.slice(i, i + 500)
        const { data } = await supabase
          .from('sale_items')
          .select('quantity, total_line, parent_category_name, category_name')
          .in('hiboutik_sale_id', chunk)
        if (data) allCatItems = allCatItems.concat(data)
      }

      const catStats: any = {}
      allCatItems.forEach((item: any) => {
        const cat = item.parent_category_name || item.category_name || 'Non catégorisé'
        if (!catStats[cat]) {
          catStats[cat] = { quantity: 0, revenue: 0 }
        }
        catStats[cat].quantity += item.quantity
        catStats[cat].revenue += parseFloat(item.total_line || '0')
      })

      const totalRev = Object.values(catStats).reduce((sum: number, c: any) => sum + c.revenue, 0)

      categoryBreakdown = Object.entries(catStats)
        .map(([name, stats]: any) => ({
          category_name: name,
          quantity: stats.quantity,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          percent: parseFloat((stats.revenue / totalRev * 100).toFixed(2))
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10)
    }
  }

  // ============================================
  // 8. VENTILATION QUOTIDIENNE (optionnel)
  // ============================================
  let dailyBreakdown: any[] = []
  if (includeDaily && targetCurrent.daily) {
    dailyBreakdown = Object.entries(targetCurrent.daily)
      .map(([date, revenue]: any) => ({
        date,
        revenue: parseFloat(revenue.toFixed(2)),
        vs_historical_daily: historicalDailyAvg > 0
          ? parseFloat(((revenue - historicalDailyAvg) / historicalDailyAvg * 100).toFixed(2))
          : 0,
        vs_team_daily: teamAvgRevenue / period.days > 0
          ? parseFloat(((revenue - teamAvgRevenue / period.days) / (teamAvgRevenue / period.days) * 100).toFixed(2))
          : 0
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  // ============================================
  // 9. ALERTES
  // ============================================
  const alerts = {
    is_underperforming: targetCurrent.revenue < teamAvgRevenue * 0.8 || currentDailyAvg < historicalDailyAvg * 0.8,
    severity: getSeverity(targetCurrent.revenue, teamAvgRevenue, currentDailyAvg, historicalDailyAvg),
    recommendations: getRecommendations(targetCurrent.revenue, teamAvgRevenue, currentDailyAvg, historicalDailyAvg)
  }

  // ============================================
  // 10. RÉPONSE
  // ============================================
  return {
    success: true,
    action: 'vendor_benchmark' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      benchmark_against: benchmarkAgainst,
      store_id: storeId || null,
      historical_days: historicalDays
    },
    data: {
      vendor: {
        id: targetVendor.id,
        canonical_id: targetCanonicalId,
        name: `${targetVendor.first_name} ${targetVendor.last_name}`,
        linked_vendor_ids: linkedVendorIds,
        store_id: targetVendor.store_id
      },

      performance: {
        total_revenue: parseFloat(targetCurrent.revenue.toFixed(2)),
        total_revenue_ht: parseFloat((targetCurrent.revenue / 1.2).toFixed(2)),
        total_transactions: targetCurrent.transactions,
        avg_basket: parseFloat(vendorAvgBasket.toFixed(2)),
        daily_avg_revenue: parseFloat(currentDailyAvg.toFixed(2)),
        days_worked: currentDaysWorked,
        rank: vendorRank,
        total_vendors: allVendorStats.length,
        percentile: allVendorStats.length > 0
          ? parseFloat(((1 - (vendorRank - 1) / allVendorStats.length) * 100).toFixed(2))
          : 100,
        contribution_to_team: teamTotalRevenue > 0
          ? parseFloat((targetCurrent.revenue / teamTotalRevenue * 100).toFixed(2))
          : 0
      },

      team_context: {
        total_vendors: allVendorStats.length,
        team_total_revenue: parseFloat(teamTotalRevenue.toFixed(2)),
        team_avg_revenue: parseFloat(teamAvgRevenue.toFixed(2)),
        team_avg_transactions: Math.round(teamAvgTransactions),
        team_avg_basket: parseFloat(teamAvgBasket.toFixed(2)),
        top_performer: topPerformer ? {
          name: topPerformer.name,
          revenue: parseFloat(topPerformer.revenue.toFixed(2))
        } : null
      },

      benchmark,
      alerts,

      category_breakdown: includeCategories ? categoryBreakdown : undefined,
      daily_breakdown: includeDaily ? dailyBreakdown : undefined
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime,
      sales_analyzed: currentSales.length
    }
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Agrège les ventes par canonical_vendor_id
 * Version simplifiée utilisant canonical_vendor_id directement depuis sale_items
 */
function aggregateByCanonical(sales: any[]) {
  const stats: any = {}

  sales.forEach((sale: any) => {
    const canonicalId = sale.canonical_vendor_id
    if (!canonicalId || EXCLUDED_VENDOR_IDS.includes(canonicalId)) return

    if (!stats[canonicalId]) {
      stats[canonicalId] = {
        canonicalId,
        name: sale.canonical_vendor_name || `Vendeur ${canonicalId}`,
        revenue: 0,
        transactions: 0,
        daily: {}
      }
    }

    stats[canonicalId].revenue += parseFloat(sale.total_amount_with_tax || '0')
    stats[canonicalId].transactions += 1

    const dateKey = sale.sale_date?.split('T')[0]
    if (dateKey) {
      if (!stats[canonicalId].daily[dateKey]) {
        stats[canonicalId].daily[dateKey] = 0
      }
      stats[canonicalId].daily[dateKey] += parseFloat(sale.total_amount_with_tax || '0')
    }
  })

  return stats
}

function getPerformanceLabel(revenue: number, teamAvg: number): string {
  if (revenue >= teamAvg * 1.2) return 'Excellent'
  if (revenue >= teamAvg) return 'Bon'
  if (revenue >= teamAvg * 0.8) return 'Moyen'
  return 'En dessous'
}

function getSeverity(revenue: number, teamAvg: number, dailyAvg: number, historicalDailyAvg: number): string {
  if (revenue < teamAvg * 0.5 || dailyAvg < historicalDailyAvg * 0.5) return 'critical'
  if (revenue < teamAvg * 0.8 || dailyAvg < historicalDailyAvg * 0.8) return 'warning'
  return 'none'
}

function getRecommendations(revenue: number, teamAvg: number, dailyAvg: number, historicalDailyAvg: number): string[] {
  const recs: string[] = []

  if (revenue < teamAvg * 0.5) {
    recs.push('Performance très en dessous de la moyenne - Analyse approfondie recommandée')
  } else if (revenue < teamAvg * 0.8) {
    recs.push('Performance légèrement en dessous - Coaching recommandé')
  }

  if (dailyAvg < historicalDailyAvg * 0.8) {
    recs.push('Baisse par rapport à l\'historique - Identifier les causes')
  }

  if (revenue >= teamAvg * 1.2) {
    recs.push('Excellent performer - Peut servir de référence pour l\'équipe')
  }

  if (recs.length === 0) {
    recs.push('Performance dans la norme')
  }

  return recs
}
