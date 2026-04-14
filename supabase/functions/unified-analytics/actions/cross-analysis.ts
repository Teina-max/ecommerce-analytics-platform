/**
 * Action: cross_analysis
 * Croisements de données avancés (NOUVELLE FONCTIONNALITÉ)
 * Version DENORMALISEE - utilise uniquement sale_items
 *
 * Permet des analyses multi-dimensionnelles comme:
 * - Performance vendeur dans une catégorie vs moyenne équipe
 * - Part de marché marque avec contribution vendeur
 * - Comparaison vendeur A vs vendeur B sur mêmes produits
 * - Performance catégorie par magasin avec benchmark
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import { loadVendors, findVendorByName, getVendorFullName } from '../../_shared/vendors.ts'
import { resolveCategoryByName, filterVirtualItems, filterItemsByCategory } from '../../_shared/categories.ts'
import { STORE_NAMES, TVA_RATE } from '../../_shared/constants.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '2.2-pagination-fix'

export async function handleCrossAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // Déterminer le type de croisement demandé
  const hasVendor = params.vendor_id || params.vendor_name
  const hasCategory = params.category_name || params.canonical_category_id || params.canonical_category_name
  const hasBrand = params.brand_name
  const compareWith = params.compare_with || 'team_avg'

  // Router vers le bon type d'analyse
  if (hasVendor && hasCategory) {
    return await vendorInCategoryAnalysis(context)
  } else if (hasVendor && hasBrand) {
    return await vendorBrandAnalysis(context)
  } else if (hasBrand && hasCategory) {
    return await brandMarketShareAnalysis(context)
  } else if (hasVendor) {
    return await vendorBenchmarkAnalysis(context)
  } else {
    return {
      success: false,
      action: 'cross_analysis',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: {
        error: 'Paramètres insuffisants pour cross_analysis',
        hint: 'Combinez: vendor_id/vendor_name + category_name, brand_name, ou utilisez compare_with',
        examples: [
          '?action=cross_analysis&vendor_name=Vendor-1&category_name=Category-A&compare_with=team_avg',
          '?action=cross_analysis&brand_name=Brand-A&category_name=Category-B&compare_with=store_avg',
          '?action=cross_analysis&vendor_name=Vendor-1&brand_name=Brand-B'
        ]
      },
      metadata: { generated_at: new Date().toISOString() }
    }
  }
}

/**
 * Analyse: Performance vendeur dans une catégorie vs équipe/magasin
 * Exemple: "Comment Vendor-1 performe en Category-A vs la moyenne de l'équipe?"
 */
async function vendorInCategoryAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context
  const compareWith = params.compare_with || 'team_avg'

  // 1. Résoudre le vendeur
  let vendor: any = null
  if (params.vendor_id) {
    const { data } = await supabase
      .from('vendors')
      .select('id, first_name, last_name')
      .eq('id', params.vendor_id)
      .single()
    vendor = data
  } else if (params.vendor_name) {
    const result = await findVendorByName(supabase, params.vendor_name)
    if (result.error) {
      return {
        success: false,
        action: 'cross_analysis',
        version: VERSION,
        period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
        data: { error: result.error, suggestions: result.suggestions },
        metadata: { generated_at: new Date().toISOString() }
      }
    }
    vendor = result.vendor
  }

  if (!vendor) {
    return {
      success: false,
      action: 'cross_analysis',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { error: 'Vendeur non trouvé' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // 2. Résoudre la catégorie
  let canonicalCategoryId = params.canonical_category_id
  let categoryInfo: any = null

  if (!canonicalCategoryId && (params.canonical_category_name || params.category_name)) {
    const resolved = await resolveCategoryByName(supabase, params.canonical_category_name || params.category_name)
    if (resolved.found) {
      canonicalCategoryId = resolved.id
      categoryInfo = resolved
    }
  }

  // 3. Récupérer TOUS les items directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, sale_date,
      product_id, product_name, quantity, total_line,
      category_name, parent_category_name, grandparent_category_name, brand_name,
      canonical_category_id, canonical_parent_category_id
    `)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  // 5. Filtrer par catégorie (recherche sur 3 niveaux: enfant, parent, grandparent)
  let categoryItems = filterVirtualItems(allItems)

  // TOUJOURS utiliser filterItemsByCategory quand un nom est fourni
  // car les canonical_category_id dans sale_items ne correspondent pas toujours aux hiboutik_category_id
  const categorySearchTerm = params.category_name || params.canonical_category_name
  if (categorySearchTerm) {
    // Utilise filterItemsByCategory qui cherche sur les 3 niveaux
    categoryItems = filterItemsByCategory(categoryItems, categorySearchTerm)
  }

  // 6. Calculer les stats du vendeur cible (utilise vendor_id dénormalisé)
  const vendorItems = categoryItems.filter(item => item.vendor_id === vendor.id)

  const vendorStats = {
    quantity: vendorItems.reduce((sum, item) => sum + (item.quantity || 0), 0),
    revenue: vendorItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0),
    products: new Set(vendorItems.map(item => item.product_name)).size,
    transactions: new Set(vendorItems.map(item => item.hiboutik_sale_id)).size
  }

  // 7. Calculer les stats de comparaison (équipe ou magasin) - utilise vendor_id dénormalisé
  const vendorMap = await loadVendors(supabase)
  const otherVendorsStats: Record<number, { quantity: number; revenue: number }> = {}

  categoryItems.forEach(item => {
    const vendorId = item.vendor_id
    if (!vendorId || vendorId === vendor.id) return
    if (!vendorMap.has(vendorId)) return // Exclure comptes techniques

    if (!otherVendorsStats[vendorId]) {
      otherVendorsStats[vendorId] = { quantity: 0, revenue: 0 }
    }
    otherVendorsStats[vendorId].quantity += item.quantity || 0
    otherVendorsStats[vendorId].revenue += parseFloat(item.total_line || '0')
  })

  const otherVendors = Object.entries(otherVendorsStats)
  const teamTotalQty = otherVendors.reduce((sum, [, stats]) => sum + stats.quantity, 0) + vendorStats.quantity
  const teamTotalRevenue = otherVendors.reduce((sum, [, stats]) => sum + stats.revenue, 0) + vendorStats.revenue
  const teamCount = otherVendors.length + 1

  const teamAvgQty = teamCount > 0 ? teamTotalQty / teamCount : 0
  const teamAvgRevenue = teamCount > 0 ? teamTotalRevenue / teamCount : 0

  // 8. Calculer les comparaisons
  const qtyVsAvg = teamAvgQty > 0
    ? ((vendorStats.quantity - teamAvgQty) / teamAvgQty * 100)
    : 0
  const revenueVsAvg = teamAvgRevenue > 0
    ? ((vendorStats.revenue - teamAvgRevenue) / teamAvgRevenue * 100)
    : 0

  // 9. Calculer le rang dans l'équipe
  const allVendorsRanked = [
    { id: vendor.id, revenue: vendorStats.revenue },
    ...otherVendors.map(([id, stats]) => ({ id: parseInt(id), revenue: stats.revenue }))
  ].sort((a, b) => b.revenue - a.revenue)

  const vendorRank = allVendorsRanked.findIndex(v => v.id === vendor.id) + 1

  // 10. Top produits du vendeur dans la catégorie
  const productStats: Record<string, { name: string; quantity: number; revenue: number }> = {}
  vendorItems.forEach(item => {
    const name = item.product_name
    if (!productStats[name]) {
      productStats[name] = { name, quantity: 0, revenue: 0 }
    }
    productStats[name].quantity += item.quantity || 0
    productStats[name].revenue += parseFloat(item.total_line || '0')
  })

  const topProducts = Object.values(productStats)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((p, i) => ({
      rank: i + 1,
      product_name: p.name,
      quantity: p.quantity,
      revenue: parseFloat(p.revenue.toFixed(2))
    }))

  return {
    success: true,
    action: 'cross_analysis',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      vendor_id: vendor.id,
      vendor_name: getVendorFullName(vendor),
      category_name: params.category_name,
      canonical_category_id: canonicalCategoryId,
      canonical_category_name: categoryInfo?.name,
      compare_with: compareWith,
      store_id: params.store_id || null
    },
    data: {
      analysis_type: 'vendor_in_category',

      vendor: {
        id: vendor.id,
        name: getVendorFullName(vendor),
        category_performance: {
          quantity: vendorStats.quantity,
          revenue: parseFloat(vendorStats.revenue.toFixed(2)),
          revenue_ht: parseFloat((vendorStats.revenue / (1 + TVA_RATE)).toFixed(2)),
          unique_products: vendorStats.products,
          transactions: vendorStats.transactions
        }
      },

      comparison: {
        compare_with: compareWith,
        team_size: teamCount,
        team_avg: {
          quantity: parseFloat(teamAvgQty.toFixed(2)),
          revenue: parseFloat(teamAvgRevenue.toFixed(2))
        },
        vendor_vs_avg: {
          quantity_diff: parseFloat((vendorStats.quantity - teamAvgQty).toFixed(2)),
          quantity_percent: parseFloat(qtyVsAvg.toFixed(2)),
          revenue_diff: parseFloat((vendorStats.revenue - teamAvgRevenue).toFixed(2)),
          revenue_percent: parseFloat(revenueVsAvg.toFixed(2))
        },
        rank_in_team: vendorRank,
        performance_rating: qtyVsAvg >= 20 ? 'excellent'
          : qtyVsAvg >= 0 ? 'above_average'
          : qtyVsAvg >= -20 ? 'below_average'
          : 'needs_improvement'
      },

      category_totals: {
        total_quantity: teamTotalQty,
        total_revenue: parseFloat(teamTotalRevenue.toFixed(2)),
        vendor_share_percent: teamTotalRevenue > 0
          ? parseFloat((vendorStats.revenue / teamTotalRevenue * 100).toFixed(2))
          : 0
      },

      top_products: topProducts,

      insights: generateInsights(vendorStats, teamAvgQty, teamAvgRevenue, vendorRank, teamCount)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      category_items: categoryItems.length,
      vendor_items: vendorItems.length
    }
  }
}

/**
 * Analyse: Performance vendeur sur une marque vs équipe
 * Exemple: "Comment Vendor-1 performe sur la marque Brand-A vs la moyenne de l'équipe?"
 */
async function vendorBrandAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context
  const compareWith = params.compare_with || 'team_avg'

  // 1. Résoudre le vendeur
  let vendor: any = null
  if (params.vendor_id) {
    const { data } = await supabase
      .from('vendors')
      .select('id, first_name, last_name')
      .eq('id', params.vendor_id)
      .single()
    vendor = data
  } else if (params.vendor_name) {
    const result = await findVendorByName(supabase, params.vendor_name)
    if (result.error) {
      return {
        success: false,
        action: 'cross_analysis',
        version: VERSION,
        period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
        data: { error: result.error, suggestions: result.suggestions },
        metadata: { generated_at: new Date().toISOString() }
      }
    }
    vendor = result.vendor
  }

  if (!vendor) {
    return {
      success: false,
      action: 'cross_analysis',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { error: 'Vendeur non trouvé' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // 2. Récupérer TOUS les items de la période
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, sale_date,
      product_id, product_name, quantity, total_line,
      brand_id, brand_name, canonical_category_id
    `)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  // 3. Filtrer par marque (recherche flexible sur brand_name)
  const brandNameLower = params.brand_name.toLowerCase()
  let brandItems = filterVirtualItems(allItems).filter(item => {
    const itemBrand = (item.brand_name || '').toLowerCase()
    return itemBrand.includes(brandNameLower)
  })

  // Récupérer le nom exact de la marque
  const brandNames = [...new Set(brandItems.map(i => i.brand_name).filter(Boolean))]
  const resolvedBrandName = brandNames[0] || params.brand_name

  // 4. Stats du vendeur cible sur la marque
  const vendorItems = brandItems.filter(item => item.vendor_id === vendor.id)

  const vendorStats = {
    quantity: vendorItems.reduce((sum, item) => sum + (item.quantity || 0), 0),
    revenue: vendorItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0),
    products: new Set(vendorItems.map(item => item.product_name)).size,
    transactions: new Set(vendorItems.map(item => item.hiboutik_sale_id)).size
  }

  // 5. Stats de l'équipe sur la marque
  const vendorMap = await loadVendors(supabase)
  const otherVendorsStats: Record<number, { quantity: number; revenue: number }> = {}

  brandItems.forEach(item => {
    const vendorId = item.vendor_id
    if (!vendorId || vendorId === vendor.id) return
    if (!vendorMap.has(vendorId)) return

    if (!otherVendorsStats[vendorId]) {
      otherVendorsStats[vendorId] = { quantity: 0, revenue: 0 }
    }
    otherVendorsStats[vendorId].quantity += item.quantity || 0
    otherVendorsStats[vendorId].revenue += parseFloat(item.total_line || '0')
  })

  const otherVendors = Object.entries(otherVendorsStats)
  const teamTotalQty = otherVendors.reduce((sum, [, stats]) => sum + stats.quantity, 0) + vendorStats.quantity
  const teamTotalRevenue = otherVendors.reduce((sum, [, stats]) => sum + stats.revenue, 0) + vendorStats.revenue
  const teamCount = otherVendors.length + 1

  const teamAvgQty = teamCount > 0 ? teamTotalQty / teamCount : 0
  const teamAvgRevenue = teamCount > 0 ? teamTotalRevenue / teamCount : 0

  // 6. Comparaisons
  const qtyVsAvg = teamAvgQty > 0 ? ((vendorStats.quantity - teamAvgQty) / teamAvgQty * 100) : 0
  const revenueVsAvg = teamAvgRevenue > 0 ? ((vendorStats.revenue - teamAvgRevenue) / teamAvgRevenue * 100) : 0

  // 7. Rang dans l'équipe
  const allVendorsRanked = [
    { id: vendor.id, revenue: vendorStats.revenue },
    ...otherVendors.map(([id, stats]) => ({ id: parseInt(id), revenue: stats.revenue }))
  ].sort((a, b) => b.revenue - a.revenue)

  const vendorRank = allVendorsRanked.findIndex(v => v.id === vendor.id) + 1

  // 8. Top produits de la marque vendus par le vendeur
  const productStats: Record<string, { name: string; quantity: number; revenue: number }> = {}
  vendorItems.forEach(item => {
    const name = item.product_name
    if (!productStats[name]) {
      productStats[name] = { name, quantity: 0, revenue: 0 }
    }
    productStats[name].quantity += item.quantity || 0
    productStats[name].revenue += parseFloat(item.total_line || '0')
  })

  const topProducts = Object.values(productStats)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((p, i) => ({
      rank: i + 1,
      product_name: p.name,
      quantity: p.quantity,
      revenue: parseFloat(p.revenue.toFixed(2))
    }))

  return {
    success: true,
    action: 'cross_analysis',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      vendor_id: vendor.id,
      vendor_name: getVendorFullName(vendor),
      brand_name: resolvedBrandName,
      compare_with: compareWith,
      store_id: params.store_id || null
    },
    data: {
      analysis_type: 'vendor_brand',

      vendor: {
        id: vendor.id,
        name: getVendorFullName(vendor),
        brand_performance: {
          quantity: vendorStats.quantity,
          revenue: parseFloat(vendorStats.revenue.toFixed(2)),
          revenue_ht: parseFloat((vendorStats.revenue / (1 + TVA_RATE)).toFixed(2)),
          unique_products: vendorStats.products,
          transactions: vendorStats.transactions
        }
      },

      comparison: {
        compare_with: compareWith,
        team_size: teamCount,
        team_avg: {
          quantity: parseFloat(teamAvgQty.toFixed(2)),
          revenue: parseFloat(teamAvgRevenue.toFixed(2))
        },
        vendor_vs_avg: {
          quantity_diff: parseFloat((vendorStats.quantity - teamAvgQty).toFixed(2)),
          quantity_percent: parseFloat(qtyVsAvg.toFixed(2)),
          revenue_diff: parseFloat((vendorStats.revenue - teamAvgRevenue).toFixed(2)),
          revenue_percent: parseFloat(revenueVsAvg.toFixed(2))
        },
        rank_in_team: vendorRank,
        performance_rating: qtyVsAvg >= 20 ? 'excellent'
          : qtyVsAvg >= 0 ? 'above_average'
          : qtyVsAvg >= -20 ? 'below_average'
          : 'needs_improvement'
      },

      brand_totals: {
        total_quantity: teamTotalQty,
        total_revenue: parseFloat(teamTotalRevenue.toFixed(2)),
        vendor_share_percent: teamTotalRevenue > 0
          ? parseFloat((vendorStats.revenue / teamTotalRevenue * 100).toFixed(2))
          : 0,
        distinct_brands_found: brandNames.length
      },

      top_products: topProducts,

      insights: generateVendorBrandInsights(vendorStats, teamAvgQty, teamAvgRevenue, vendorRank, teamCount, resolvedBrandName)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      brand_items: brandItems.length,
      vendor_items: vendorItems.length
    }
  }
}

/**
 * Génère des insights pour l'analyse vendeur/marque
 */
function generateVendorBrandInsights(
  vendorStats: { quantity: number; revenue: number },
  teamAvgQty: number,
  teamAvgRevenue: number,
  rank: number,
  teamSize: number,
  brandName: string
): string[] {
  const insights: string[] = []
  const qtyVsAvg = teamAvgQty > 0 ? ((vendorStats.quantity - teamAvgQty) / teamAvgQty * 100) : 0

  if (rank === 1) {
    insights.push(`Meilleur vendeur de ${brandName} avec ${vendorStats.quantity} unités`)
  } else if (rank <= 3) {
    insights.push(`Top 3 des vendeurs ${brandName} (rang ${rank}/${teamSize})`)
  }

  if (qtyVsAvg >= 50) {
    insights.push(`Spécialiste ${brandName}: +${qtyVsAvg.toFixed(0)}% au-dessus de la moyenne équipe`)
  } else if (qtyVsAvg >= 20) {
    insights.push(`Bonne maîtrise de ${brandName}: +${qtyVsAvg.toFixed(0)}% vs moyenne`)
  } else if (qtyVsAvg < -20) {
    insights.push(`Potentiel de développement sur ${brandName}: ${Math.abs(qtyVsAvg).toFixed(0)}% sous la moyenne`)
  }

  return insights
}

/**
 * Analyse: Part de marché d'une marque dans une catégorie
 * Exemple: "Quelle est la part de marché de Brand-A dans la Category-B?"
 */
async function brandMarketShareAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // 1. Résoudre la catégorie
  let canonicalCategoryId = params.canonical_category_id
  let categoryInfo: any = null

  if (!canonicalCategoryId && (params.canonical_category_name || params.category_name)) {
    const resolved = await resolveCategoryByName(supabase, params.canonical_category_name || params.category_name)
    if (resolved.found) {
      canonicalCategoryId = resolved.id
      categoryInfo = resolved
    }
  }

  // 2. Récupérer TOUS les items de la période
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, sale_date,
      product_id, product_name, quantity, total_line,
      brand_id, brand_name, category_name, parent_category_name, grandparent_category_name,
      canonical_category_id, canonical_parent_category_id
    `)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  // 3. Filtrer par catégorie (exclut les virtuels)
  let categoryItems = filterVirtualItems(allItems)

  // TOUJOURS utiliser filterItemsByCategory quand un nom est fourni
  const categorySearchTermBrand = params.category_name || params.canonical_category_name
  if (categorySearchTermBrand) {
    categoryItems = filterItemsByCategory(categoryItems, categorySearchTermBrand)
  }

  // 4. Calculer les totaux de la catégorie
  const categoryTotalQty = categoryItems.reduce((sum, item) => sum + (item.quantity || 0), 0)
  const categoryTotalRevenue = categoryItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0)

  // 5. Filtrer par marque cible
  const brandNameLower = params.brand_name.toLowerCase()
  const brandItems = categoryItems.filter(item => {
    const itemBrand = (item.brand_name || '').toLowerCase()
    return itemBrand.includes(brandNameLower)
  })

  const brandNames = [...new Set(brandItems.map(i => i.brand_name).filter(Boolean))]
  const resolvedBrandName = brandNames[0] || params.brand_name

  // 6. Stats de la marque cible
  const brandStats = {
    quantity: brandItems.reduce((sum, item) => sum + (item.quantity || 0), 0),
    revenue: brandItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0),
    products: new Set(brandItems.map(item => item.product_name)).size,
    transactions: new Set(brandItems.map(item => item.hiboutik_sale_id)).size
  }

  // 7. Agrégation par marque concurrente
  const brandStatsMap: Record<string, { name: string; quantity: number; revenue: number; products: Set<string> }> = {}

  categoryItems.forEach(item => {
    const brandName = item.brand_name || 'Sans marque'
    if (!brandStatsMap[brandName]) {
      brandStatsMap[brandName] = { name: brandName, quantity: 0, revenue: 0, products: new Set() }
    }
    brandStatsMap[brandName].quantity += item.quantity || 0
    brandStatsMap[brandName].revenue += parseFloat(item.total_line || '0')
    brandStatsMap[brandName].products.add(item.product_name)
  })

  // 8. Classement des marques
  const brandRankings = Object.values(brandStatsMap)
    .map(b => ({
      brand_name: b.name,
      quantity: b.quantity,
      revenue: parseFloat(b.revenue.toFixed(2)),
      unique_products: b.products.size,
      market_share_qty: categoryTotalQty > 0 ? parseFloat((b.quantity / categoryTotalQty * 100).toFixed(2)) : 0,
      market_share_revenue: categoryTotalRevenue > 0 ? parseFloat((b.revenue / categoryTotalRevenue * 100).toFixed(2)) : 0,
      is_target_brand: b.name.toLowerCase().includes(brandNameLower)
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .map((b, i) => ({ ...b, rank: i + 1 }))

  // 9. Position de la marque cible
  const targetBrandRanking = brandRankings.find(b => b.is_target_brand)
  const targetBrandRank = targetBrandRanking?.rank || 0

  // 10. Top produits de la marque dans la catégorie
  const productStats: Record<string, { name: string; quantity: number; revenue: number }> = {}
  brandItems.forEach(item => {
    const name = item.product_name
    if (!productStats[name]) {
      productStats[name] = { name, quantity: 0, revenue: 0 }
    }
    productStats[name].quantity += item.quantity || 0
    productStats[name].revenue += parseFloat(item.total_line || '0')
  })

  const topProducts = Object.values(productStats)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((p, i) => ({
      rank: i + 1,
      product_name: p.name,
      quantity: p.quantity,
      revenue: parseFloat(p.revenue.toFixed(2)),
      share_of_brand: brandStats.revenue > 0 ? parseFloat((p.revenue / brandStats.revenue * 100).toFixed(2)) : 0
    }))

  // 11. Agrégation par magasin pour la marque
  const storeStats: Record<number, { store_id: number; store_name: string; quantity: number; revenue: number }> = {}
  brandItems.forEach(item => {
    const storeId = item.store_id
    if (!storeStats[storeId]) {
      storeStats[storeId] = {
        store_id: storeId,
        store_name: item.store_name || STORE_NAMES[storeId] || `Magasin ${storeId}`,
        quantity: 0,
        revenue: 0
      }
    }
    storeStats[storeId].quantity += item.quantity || 0
    storeStats[storeId].revenue += parseFloat(item.total_line || '0')
  })

  const byStore = Object.values(storeStats)
    .map(s => ({
      ...s,
      revenue: parseFloat(s.revenue.toFixed(2)),
      share_of_brand: brandStats.revenue > 0 ? parseFloat((s.revenue / brandStats.revenue * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // 12. Évolution vs période précédente
  let evolution = null
  if (previousPeriod) {
    let prevQuery = supabase
      .from('sale_items')
      .select('brand_name, quantity, total_line, canonical_category_id, canonical_parent_category_id')
      .gte('sale_date', previousPeriod.startDateTime)
      .lte('sale_date', previousPeriod.endDateTime)

    if (params.store_id) {
      prevQuery = prevQuery.eq('store_id', params.store_id)
    }

    const prevItems = await fetchAllRows(prevQuery.order('id'))
    let prevCategoryItems = filterVirtualItems(prevItems)

    // Utiliser filterItemsByCategory pour cohérence avec la période actuelle
    if (categorySearchTermBrand) {
      prevCategoryItems = filterItemsByCategory(prevCategoryItems, categorySearchTermBrand)
    }

    const prevBrandItems = prevCategoryItems.filter(item =>
      (item.brand_name || '').toLowerCase().includes(brandNameLower)
    )

    const prevBrandRevenue = prevBrandItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0)
    const prevCategoryRevenue = prevCategoryItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0)
    const prevMarketShare = prevCategoryRevenue > 0 ? (prevBrandRevenue / prevCategoryRevenue * 100) : 0

    const currentMarketShare = categoryTotalRevenue > 0 ? (brandStats.revenue / categoryTotalRevenue * 100) : 0

    evolution = {
      previous_revenue: parseFloat(prevBrandRevenue.toFixed(2)),
      previous_market_share: parseFloat(prevMarketShare.toFixed(2)),
      revenue_change_percent: prevBrandRevenue > 0
        ? parseFloat(((brandStats.revenue - prevBrandRevenue) / prevBrandRevenue * 100).toFixed(2))
        : (brandStats.revenue > 0 ? 100 : 0),
      market_share_change_pts: parseFloat((currentMarketShare - prevMarketShare).toFixed(2))
    }
  }

  return {
    success: true,
    action: 'cross_analysis',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      brand_name: resolvedBrandName,
      category_name: params.category_name,
      canonical_category_id: canonicalCategoryId,
      canonical_category_name: categoryInfo?.name,
      store_id: params.store_id || null
    },
    data: {
      analysis_type: 'brand_market_share',

      brand: {
        name: resolvedBrandName,
        performance: {
          quantity: brandStats.quantity,
          revenue: parseFloat(brandStats.revenue.toFixed(2)),
          revenue_ht: parseFloat((brandStats.revenue / (1 + TVA_RATE)).toFixed(2)),
          unique_products: brandStats.products,
          transactions: brandStats.transactions
        },
        market_share: {
          by_quantity: categoryTotalQty > 0 ? parseFloat((brandStats.quantity / categoryTotalQty * 100).toFixed(2)) : 0,
          by_revenue: categoryTotalRevenue > 0 ? parseFloat((brandStats.revenue / categoryTotalRevenue * 100).toFixed(2)) : 0
        },
        rank_in_category: targetBrandRank,
        total_brands_in_category: brandRankings.length
      },

      category_totals: {
        total_quantity: categoryTotalQty,
        total_revenue: parseFloat(categoryTotalRevenue.toFixed(2)),
        total_brands: brandRankings.length
      },

      competitors: brandRankings.filter(b => !b.is_target_brand).slice(0, 10),

      top_products: topProducts,
      by_store: byStore,
      evolution: evolution,

      insights: generateMarketShareInsights(brandStats, categoryTotalRevenue, targetBrandRank, brandRankings.length, resolvedBrandName, evolution)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      category_items: categoryItems.length,
      brand_items: brandItems.length
    }
  }
}

/**
 * Génère des insights pour l'analyse part de marché
 */
function generateMarketShareInsights(
  brandStats: { quantity: number; revenue: number },
  categoryTotalRevenue: number,
  rank: number,
  totalBrands: number,
  brandName: string,
  evolution: any
): string[] {
  const insights: string[] = []
  const marketShare = categoryTotalRevenue > 0 ? (brandStats.revenue / categoryTotalRevenue * 100) : 0

  if (rank === 1) {
    insights.push(`${brandName} est le leader de la catégorie avec ${marketShare.toFixed(1)}% de PDM`)
  } else if (rank <= 3) {
    insights.push(`${brandName} est dans le top 3 (rang ${rank}/${totalBrands}) avec ${marketShare.toFixed(1)}% de PDM`)
  } else if (rank <= 5) {
    insights.push(`${brandName} est dans le top 5 (rang ${rank}/${totalBrands})`)
  }

  if (marketShare >= 30) {
    insights.push(`Position dominante: plus de 30% de la catégorie`)
  } else if (marketShare >= 15) {
    insights.push(`Position solide: ${marketShare.toFixed(1)}% de la catégorie`)
  } else if (marketShare < 5) {
    insights.push(`Marque de niche: ${marketShare.toFixed(1)}% de la catégorie`)
  }

  if (evolution) {
    if (evolution.market_share_change_pts > 2) {
      insights.push(`En progression: +${evolution.market_share_change_pts.toFixed(1)} pts de PDM vs période précédente`)
    } else if (evolution.market_share_change_pts < -2) {
      insights.push(`En recul: ${evolution.market_share_change_pts.toFixed(1)} pts de PDM vs période précédente`)
    }
  }

  return insights
}

/**
 * Analyse: Benchmark global d'un vendeur vs équipe/magasin
 * Exemple: "Comment Vendor-1 se positionne globalement par rapport à l'équipe?"
 */
async function vendorBenchmarkAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context
  const compareWith = params.compare_with || 'team_avg'

  // 1. Résoudre le vendeur
  let vendor: any = null
  if (params.vendor_id) {
    const { data } = await supabase
      .from('vendors')
      .select('id, first_name, last_name')
      .eq('id', params.vendor_id)
      .single()
    vendor = data
  } else if (params.vendor_name) {
    const result = await findVendorByName(supabase, params.vendor_name)
    if (result.error) {
      return {
        success: false,
        action: 'cross_analysis',
        version: VERSION,
        period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
        data: { error: result.error, suggestions: result.suggestions },
        metadata: { generated_at: new Date().toISOString() }
      }
    }
    vendor = result.vendor
  }

  if (!vendor) {
    return {
      success: false,
      action: 'cross_analysis',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { error: 'Vendeur non trouvé' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // 2. Récupérer TOUS les items de la période
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, sale_date,
      product_id, product_name, quantity, total_line, supply_price,
      brand_id, brand_name, category_name, parent_category_name,
      canonical_category_id, canonical_parent_category_id, canonical_vendor_id
    `)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  // 3. Exclure les catégories virtuelles
  const filteredItems = filterVirtualItems(allItems)

  // 4. Charger les vendeurs pour exclure les comptes techniques
  const vendorMap = await loadVendors(supabase)

  // 5. Agréger par vendeur
  const vendorStatsMap: Record<number, {
    vendor_id: number
    vendor_name: string
    store_id: number | null
    store_name: string | null
    quantity: number
    revenue: number
    margin: number
    transactions: Set<number>
    products: Set<string>
    brands: Set<string>
    categories: Set<string>
  }> = {}

  filteredItems.forEach(item => {
    const vendorId = item.vendor_id
    if (!vendorId || !vendorMap.has(vendorId)) return

    if (!vendorStatsMap[vendorId]) {
      vendorStatsMap[vendorId] = {
        vendor_id: vendorId,
        vendor_name: item.vendor_name || `Vendeur ${vendorId}`,
        store_id: item.store_id,
        store_name: item.store_name,
        quantity: 0,
        revenue: 0,
        margin: 0,
        transactions: new Set(),
        products: new Set(),
        brands: new Set(),
        categories: new Set()
      }
    }

    const stats = vendorStatsMap[vendorId]
    stats.quantity += item.quantity || 0
    stats.revenue += parseFloat(item.total_line || '0')

    // Calculer la marge si supply_price disponible
    const supplyPrice = parseFloat(item.supply_price || '0')
    const revenue = parseFloat(item.total_line || '0')
    if (supplyPrice > 0) {
      stats.margin += revenue - (supplyPrice * (item.quantity || 1))
    }

    stats.transactions.add(item.hiboutik_sale_id)
    if (item.product_name) stats.products.add(item.product_name)
    if (item.brand_name) stats.brands.add(item.brand_name)
    if (item.category_name) stats.categories.add(item.category_name)
  })

  // 6. Stats du vendeur cible
  const vendorStats = vendorStatsMap[vendor.id] || {
    vendor_id: vendor.id,
    vendor_name: getVendorFullName(vendor),
    store_id: null,
    store_name: null,
    quantity: 0,
    revenue: 0,
    margin: 0,
    transactions: new Set(),
    products: new Set(),
    brands: new Set(),
    categories: new Set()
  }

  // 7. Calculer les métriques du vendeur
  const vendorMetrics = {
    total_quantity: vendorStats.quantity,
    total_revenue: parseFloat(vendorStats.revenue.toFixed(2)),
    total_revenue_ht: parseFloat((vendorStats.revenue / (1 + TVA_RATE)).toFixed(2)),
    total_margin: parseFloat(vendorStats.margin.toFixed(2)),
    margin_percent: vendorStats.revenue > 0 ? parseFloat((vendorStats.margin / vendorStats.revenue * 100).toFixed(2)) : 0,
    transaction_count: vendorStats.transactions.size,
    avg_basket: vendorStats.transactions.size > 0 ? parseFloat((vendorStats.revenue / vendorStats.transactions.size).toFixed(2)) : 0,
    avg_items_per_transaction: vendorStats.transactions.size > 0 ? parseFloat((vendorStats.quantity / vendorStats.transactions.size).toFixed(2)) : 0,
    unique_products: vendorStats.products.size,
    unique_brands: vendorStats.brands.size,
    unique_categories: vendorStats.categories.size
  }

  // 8. Calculer les moyennes de l'équipe
  const otherVendors = Object.values(vendorStatsMap).filter(v => v.vendor_id !== vendor.id)
  const teamCount = otherVendors.length + 1

  const teamTotals = {
    quantity: Object.values(vendorStatsMap).reduce((sum, v) => sum + v.quantity, 0),
    revenue: Object.values(vendorStatsMap).reduce((sum, v) => sum + v.revenue, 0),
    margin: Object.values(vendorStatsMap).reduce((sum, v) => sum + v.margin, 0),
    transactions: Object.values(vendorStatsMap).reduce((sum, v) => sum + v.transactions.size, 0)
  }

  const teamAvg = {
    quantity: teamCount > 0 ? teamTotals.quantity / teamCount : 0,
    revenue: teamCount > 0 ? teamTotals.revenue / teamCount : 0,
    margin: teamCount > 0 ? teamTotals.margin / teamCount : 0,
    transactions: teamCount > 0 ? teamTotals.transactions / teamCount : 0,
    avg_basket: teamTotals.transactions > 0 ? teamTotals.revenue / teamTotals.transactions : 0
  }

  // 9. Calculer les rankings
  const allVendorsList = Object.values(vendorStatsMap).map(v => ({
    vendor_id: v.vendor_id,
    vendor_name: v.vendor_name,
    revenue: v.revenue,
    quantity: v.quantity,
    margin: v.margin,
    transactions: v.transactions.size
  }))

  const revenueRank = [...allVendorsList].sort((a, b) => b.revenue - a.revenue).findIndex(v => v.vendor_id === vendor.id) + 1
  const quantityRank = [...allVendorsList].sort((a, b) => b.quantity - a.quantity).findIndex(v => v.vendor_id === vendor.id) + 1
  const marginRank = [...allVendorsList].sort((a, b) => b.margin - a.margin).findIndex(v => v.vendor_id === vendor.id) + 1
  const transactionsRank = [...allVendorsList].sort((a, b) => b.transactions - a.transactions).findIndex(v => v.vendor_id === vendor.id) + 1

  // 10. Calculer les comparaisons vs moyenne
  const vsAvg = {
    revenue: {
      diff: parseFloat((vendorStats.revenue - teamAvg.revenue).toFixed(2)),
      percent: teamAvg.revenue > 0 ? parseFloat(((vendorStats.revenue - teamAvg.revenue) / teamAvg.revenue * 100).toFixed(2)) : 0
    },
    quantity: {
      diff: parseFloat((vendorStats.quantity - teamAvg.quantity).toFixed(2)),
      percent: teamAvg.quantity > 0 ? parseFloat(((vendorStats.quantity - teamAvg.quantity) / teamAvg.quantity * 100).toFixed(2)) : 0
    },
    margin: {
      diff: parseFloat((vendorStats.margin - teamAvg.margin).toFixed(2)),
      percent: teamAvg.margin > 0 ? parseFloat(((vendorStats.margin - teamAvg.margin) / teamAvg.margin * 100).toFixed(2)) : 0
    },
    avg_basket: {
      diff: parseFloat((vendorMetrics.avg_basket - teamAvg.avg_basket).toFixed(2)),
      percent: teamAvg.avg_basket > 0 ? parseFloat(((vendorMetrics.avg_basket - teamAvg.avg_basket) / teamAvg.avg_basket * 100).toFixed(2)) : 0
    }
  }

  // 11. Top catégories du vendeur
  const categoryStatsMap: Record<string, { name: string; quantity: number; revenue: number }> = {}
  filteredItems.filter(item => item.vendor_id === vendor.id).forEach(item => {
    const catName = item.category_name || 'Non catégorisé'
    if (!categoryStatsMap[catName]) {
      categoryStatsMap[catName] = { name: catName, quantity: 0, revenue: 0 }
    }
    categoryStatsMap[catName].quantity += item.quantity || 0
    categoryStatsMap[catName].revenue += parseFloat(item.total_line || '0')
  })

  const topCategories = Object.values(categoryStatsMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((c, i) => ({
      rank: i + 1,
      category_name: c.name,
      quantity: c.quantity,
      revenue: parseFloat(c.revenue.toFixed(2)),
      share_of_vendor: vendorStats.revenue > 0 ? parseFloat((c.revenue / vendorStats.revenue * 100).toFixed(2)) : 0
    }))

  // 12. Top marques du vendeur
  const brandStatsMap: Record<string, { name: string; quantity: number; revenue: number }> = {}
  filteredItems.filter(item => item.vendor_id === vendor.id).forEach(item => {
    const brandName = item.brand_name || 'Sans marque'
    if (!brandStatsMap[brandName]) {
      brandStatsMap[brandName] = { name: brandName, quantity: 0, revenue: 0 }
    }
    brandStatsMap[brandName].quantity += item.quantity || 0
    brandStatsMap[brandName].revenue += parseFloat(item.total_line || '0')
  })

  const topBrands = Object.values(brandStatsMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((b, i) => ({
      rank: i + 1,
      brand_name: b.name,
      quantity: b.quantity,
      revenue: parseFloat(b.revenue.toFixed(2)),
      share_of_vendor: vendorStats.revenue > 0 ? parseFloat((b.revenue / vendorStats.revenue * 100).toFixed(2)) : 0
    }))

  // 13. Évolution vs période précédente
  let evolution = null
  if (previousPeriod) {
    let prevQuery = supabase
      .from('sale_items')
      .select('vendor_id, quantity, total_line, hiboutik_sale_id, canonical_category_id')
      .gte('sale_date', previousPeriod.startDateTime)
      .lte('sale_date', previousPeriod.endDateTime)

    if (params.store_id) {
      prevQuery = prevQuery.eq('store_id', params.store_id)
    }

    const prevItems = await fetchAllRows(prevQuery.order('id'))
    const prevVendorItems = filterVirtualItems(prevItems).filter(item => item.vendor_id === vendor.id)

    const prevRevenue = prevVendorItems.reduce((sum, item) => sum + parseFloat(item.total_line || '0'), 0)
    const prevQuantity = prevVendorItems.reduce((sum, item) => sum + (item.quantity || 0), 0)
    const prevTransactions = new Set(prevVendorItems.map(item => item.hiboutik_sale_id)).size

    evolution = {
      previous_revenue: parseFloat(prevRevenue.toFixed(2)),
      previous_quantity: prevQuantity,
      previous_transactions: prevTransactions,
      revenue_change_percent: prevRevenue > 0
        ? parseFloat(((vendorStats.revenue - prevRevenue) / prevRevenue * 100).toFixed(2))
        : (vendorStats.revenue > 0 ? 100 : 0),
      quantity_change_percent: prevQuantity > 0
        ? parseFloat(((vendorStats.quantity - prevQuantity) / prevQuantity * 100).toFixed(2))
        : (vendorStats.quantity > 0 ? 100 : 0),
      transactions_change_percent: prevTransactions > 0
        ? parseFloat(((vendorStats.transactions.size - prevTransactions) / prevTransactions * 100).toFixed(2))
        : (vendorStats.transactions.size > 0 ? 100 : 0)
    }
  }

  // 14. Déterminer le rating global
  const avgRank = (revenueRank + quantityRank + marginRank + transactionsRank) / 4
  const performanceRating = avgRank <= 3 ? 'excellent'
    : avgRank <= teamCount * 0.3 ? 'above_average'
    : avgRank <= teamCount * 0.6 ? 'average'
    : avgRank <= teamCount * 0.8 ? 'below_average'
    : 'needs_improvement'

  return {
    success: true,
    action: 'cross_analysis',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      vendor_id: vendor.id,
      vendor_name: getVendorFullName(vendor),
      compare_with: compareWith,
      store_id: params.store_id || null
    },
    data: {
      analysis_type: 'vendor_benchmark',

      vendor: {
        id: vendor.id,
        name: getVendorFullName(vendor),
        store: vendorStats.store_name || 'Multi-magasins',
        metrics: vendorMetrics
      },

      rankings: {
        by_revenue: { rank: revenueRank, total: teamCount },
        by_quantity: { rank: quantityRank, total: teamCount },
        by_margin: { rank: marginRank, total: teamCount },
        by_transactions: { rank: transactionsRank, total: teamCount },
        overall_performance: performanceRating
      },

      comparison: {
        compare_with: compareWith,
        team_size: teamCount,
        team_avg: {
          revenue: parseFloat(teamAvg.revenue.toFixed(2)),
          quantity: parseFloat(teamAvg.quantity.toFixed(2)),
          margin: parseFloat(teamAvg.margin.toFixed(2)),
          avg_basket: parseFloat(teamAvg.avg_basket.toFixed(2))
        },
        vs_avg: vsAvg
      },

      team_share: {
        revenue_share: teamTotals.revenue > 0 ? parseFloat((vendorStats.revenue / teamTotals.revenue * 100).toFixed(2)) : 0,
        quantity_share: teamTotals.quantity > 0 ? parseFloat((vendorStats.quantity / teamTotals.quantity * 100).toFixed(2)) : 0,
        transactions_share: teamTotals.transactions > 0 ? parseFloat((vendorStats.transactions.size / teamTotals.transactions * 100).toFixed(2)) : 0
      },

      specializations: {
        top_categories: topCategories,
        top_brands: topBrands
      },

      evolution: evolution,

      insights: generateBenchmarkInsights(vendorMetrics, vsAvg, revenueRank, quantityRank, teamCount, getVendorFullName(vendor), evolution)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      filtered_items: filteredItems.length,
      team_vendors: teamCount
    }
  }
}

/**
 * Génère des insights pour le benchmark vendeur
 */
function generateBenchmarkInsights(
  vendorMetrics: any,
  vsAvg: any,
  revenueRank: number,
  quantityRank: number,
  teamCount: number,
  vendorName: string,
  evolution: any
): string[] {
  const insights: string[] = []

  // Ranking insights
  if (revenueRank === 1) {
    insights.push(`${vendorName} est le #1 en chiffre d'affaires de l'équipe`)
  } else if (revenueRank <= 3) {
    insights.push(`Top 3 CA de l'équipe (rang ${revenueRank}/${teamCount})`)
  }

  if (quantityRank === 1 && revenueRank !== 1) {
    insights.push(`Leader en volume de ventes avec ${vendorMetrics.total_quantity} unités`)
  }

  // Performance vs average
  if (vsAvg.revenue.percent >= 30) {
    insights.push(`Performance exceptionnelle: +${vsAvg.revenue.percent.toFixed(0)}% vs moyenne équipe`)
  } else if (vsAvg.revenue.percent >= 10) {
    insights.push(`Bonne performance: +${vsAvg.revenue.percent.toFixed(0)}% au-dessus de la moyenne`)
  } else if (vsAvg.revenue.percent < -20) {
    insights.push(`Axe de progression: ${Math.abs(vsAvg.revenue.percent).toFixed(0)}% sous la moyenne équipe`)
  }

  // Basket insights
  if (vsAvg.avg_basket.percent >= 15) {
    insights.push(`Panier moyen élevé: ${vendorMetrics.avg_basket.toFixed(2)}€ (+${vsAvg.avg_basket.percent.toFixed(0)}% vs équipe)`)
  } else if (vsAvg.avg_basket.percent < -15) {
    insights.push(`Potentiel d'amélioration du panier moyen: ${vendorMetrics.avg_basket.toFixed(2)}€`)
  }

  // Evolution insights
  if (evolution) {
    if (evolution.revenue_change_percent >= 20) {
      insights.push(`Forte progression: +${evolution.revenue_change_percent.toFixed(0)}% vs période précédente`)
    } else if (evolution.revenue_change_percent <= -20) {
      insights.push(`En baisse: ${evolution.revenue_change_percent.toFixed(0)}% vs période précédente`)
    }
  }

  return insights
}

/**
 * Génère des insights en langage naturel
 */
function generateInsights(
  vendorStats: { quantity: number; revenue: number },
  teamAvgQty: number,
  teamAvgRevenue: number,
  rank: number,
  teamSize: number
): string[] {
  const insights: string[] = []

  const qtyVsAvg = teamAvgQty > 0 ? ((vendorStats.quantity - teamAvgQty) / teamAvgQty * 100) : 0
  const revenueVsAvg = teamAvgRevenue > 0 ? ((vendorStats.revenue - teamAvgRevenue) / teamAvgRevenue * 100) : 0

  if (rank === 1) {
    insights.push(`Leader de la catégorie avec ${vendorStats.quantity} unités vendues`)
  } else if (rank <= 3) {
    insights.push(`Top 3 de la catégorie (rang ${rank}/${teamSize})`)
  }

  if (qtyVsAvg >= 50) {
    insights.push(`Performance exceptionnelle: +${qtyVsAvg.toFixed(0)}% au-dessus de la moyenne équipe`)
  } else if (qtyVsAvg >= 20) {
    insights.push(`Bonne performance: +${qtyVsAvg.toFixed(0)}% au-dessus de la moyenne`)
  } else if (qtyVsAvg < -20) {
    insights.push(`Axe d'amélioration: ${Math.abs(qtyVsAvg).toFixed(0)}% en dessous de la moyenne équipe`)
  }

  if (vendorStats.quantity > 0 && vendorStats.revenue / vendorStats.quantity > teamAvgRevenue / teamAvgQty * 1.1) {
    insights.push(`Vend des produits à plus forte valeur que la moyenne`)
  }

  return insights
}
