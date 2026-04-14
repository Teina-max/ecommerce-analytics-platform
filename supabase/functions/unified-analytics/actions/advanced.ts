/**
 * Actions avancées:
 * - discount_analysis: Corrélation remise/volume
 * - trend_analysis: Tendances sur période
 * - brand_share: Part de marché d'une marque
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import type { ExecutionContext, AnalyticsResult } from '../types.ts'
import { fetchAllRows } from '../../_shared/pagination.ts'
import { calculatePreviousPeriod } from '../../_shared/dates.ts'

const VERSION = '2.2-pagination-fix'

// Catégories virtuelles à exclure
const VIRTUAL_CATEGORY_IDS = [8, 9, 10, 11]

// Vendeurs techniques à exclure
const EXCLUDED_VENDOR_IDS = [1, 1068]

/**
 * Handler pour discount_analysis
 * Analyse la corrélation entre remises et volume vendu
 *
 * Paramètres:
 * - store_id: filtrer par magasin
 * - group_by: 'product' | 'vendor' | 'category' - défaut: 'product'
 * - min_transactions: minimum de transactions pour inclure - défaut: 5
 */
export async function handleDiscountAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const storeId = params.store_id
  const groupBy = (params as any).group_by || 'product'
  const minTransactions = (params as any).min_transactions || 5

  // Récupérer les ventes depuis sale_items (dénormalisé)
  // On agrège par hiboutik_sale_id pour reconstituer les ventes
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, store_id, total_line, discount, sale_date')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  // Agréger par vente unique
  const salesMap = new Map<number, any>()
  allItems.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId) return
    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, {
        id: saleId,
        vendor_id: item.vendor_id,
        store_id: item.store_id,
        total_amount_with_tax: 0,
        total_discount: 0,
        sale_date: item.sale_date
      })
    }
    salesMap.get(saleId).total_amount_with_tax += parseFloat(item.total_line || '0')
    salesMap.get(saleId).total_discount += parseFloat(item.discount || '0')
  })

  const sales = Array.from(salesMap.values())

  // Séparer ventes avec et sans remise
  const salesWithDiscount = sales.filter((s: any) =>
    parseFloat(s.total_discount || '0') > 0
  )
  const salesNoDiscount = sales.filter((s: any) =>
    parseFloat(s.total_discount || '0') === 0
  )

  // Stats globales
  const totalSales = sales.length
  const discountedSalesCount = salesWithDiscount.length
  const discountedSalesPercent = totalSales > 0 ? (discountedSalesCount / totalSales * 100) : 0

  const totalRevenueWithDiscount = salesWithDiscount.reduce((sum: number, s: any) =>
    sum + parseFloat(s.total_amount_with_tax || '0'), 0)
  const totalRevenueNoDiscount = salesNoDiscount.reduce((sum: number, s: any) =>
    sum + parseFloat(s.total_amount_with_tax || '0'), 0)

  const avgBasketWithDiscount = salesWithDiscount.length > 0
    ? totalRevenueWithDiscount / salesWithDiscount.length
    : 0
  const avgBasketNoDiscount = salesNoDiscount.length > 0
    ? totalRevenueNoDiscount / salesNoDiscount.length
    : 0

  const totalDiscountGiven = salesWithDiscount.reduce((sum: number, s: any) =>
    sum + parseFloat(s.total_discount || '0'), 0)

  // ============================================
  // ANALYSE PAR GROUPE
  // ============================================
  let breakdown: any[] = []

  if (groupBy === 'vendor') {
    // Récupérer les vendeurs
    const { data: vendors } = await supabase
      .from('vendors')
      .select('id, first_name, last_name')
      .eq('is_active', true)

    const vendorMap: any = {}
    vendors?.forEach((v: any) => {
      if (!EXCLUDED_VENDOR_IDS.includes(v.id)) {
        vendorMap[v.id] = v
      }
    })

    const vendorStats: any = {}

    sales.forEach((sale: any) => {
      const vendor = vendorMap[sale.vendor_id]
      if (!vendor) return

      const hasDiscount = parseFloat(sale.total_discount || '0') > 0

      if (!vendorStats[sale.vendor_id]) {
        vendorStats[sale.vendor_id] = {
          vendor_id: sale.vendor_id,
          vendor_name: `${vendor.first_name} ${vendor.last_name}`,
          total_sales: 0,
          discounted_sales: 0,
          total_revenue: 0,
          revenue_with_discount: 0,
          revenue_without_discount: 0,
          total_discount_given: 0
        }
      }

      vendorStats[sale.vendor_id].total_sales += 1
      vendorStats[sale.vendor_id].total_revenue += parseFloat(sale.total_amount_with_tax || '0')

      if (hasDiscount) {
        vendorStats[sale.vendor_id].discounted_sales += 1
        vendorStats[sale.vendor_id].revenue_with_discount += parseFloat(sale.total_amount_with_tax || '0')
        vendorStats[sale.vendor_id].total_discount_given += parseFloat(sale.total_discount || '0')
      } else {
        vendorStats[sale.vendor_id].revenue_without_discount += parseFloat(sale.total_amount_with_tax || '0')
      }
    })

    breakdown = Object.values(vendorStats)
      .filter((v: any) => v.total_sales >= minTransactions)
      .map((v: any) => ({
        ...v,
        discount_rate: parseFloat((v.discounted_sales / v.total_sales * 100).toFixed(2)),
        avg_basket_with_discount: v.discounted_sales > 0
          ? parseFloat((v.revenue_with_discount / v.discounted_sales).toFixed(2))
          : 0,
        avg_basket_without_discount: (v.total_sales - v.discounted_sales) > 0
          ? parseFloat((v.revenue_without_discount / (v.total_sales - v.discounted_sales)).toFixed(2))
          : 0,
        total_revenue: parseFloat(v.total_revenue.toFixed(2)),
        total_discount_given: parseFloat(v.total_discount_given.toFixed(2))
      }))
      .sort((a: any, b: any) => b.discount_rate - a.discount_rate)
  } else if (groupBy === 'category') {
    // Récupérer les sale_items pour catégoriser
    const saleIds = sales.map((s: any) => s.id)
    const saleDiscountMap: any = {}
    sales.forEach((s: any) => {
      saleDiscountMap[s.id] = parseFloat(s.total_discount || '0') > 0
    })

    let allItems: any[] = []
    for (let i = 0; i < saleIds.length; i += 500) {
      const chunk = saleIds.slice(i, i + 500)
      const { data } = await supabase
        .from('sale_items')
        .select('sale_id, quantity, total_line, parent_category_name, category_name, canonical_category_id')
        .in('sale_id', chunk)
      if (data) allItems = allItems.concat(data)
    }

    allItems = allItems.filter(item => !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id))

    const catStats: any = {}

    allItems.forEach((item: any) => {
      const cat = item.parent_category_name || item.category_name || 'Non catégorisé'
      const hasDiscount = saleDiscountMap[item.sale_id]

      if (!catStats[cat]) {
        catStats[cat] = {
          category_name: cat,
          total_quantity: 0,
          quantity_with_discount: 0,
          quantity_without_discount: 0,
          total_revenue: 0,
          revenue_with_discount: 0,
          revenue_without_discount: 0
        }
      }

      catStats[cat].total_quantity += item.quantity
      catStats[cat].total_revenue += parseFloat(item.total_line || '0')

      if (hasDiscount) {
        catStats[cat].quantity_with_discount += item.quantity
        catStats[cat].revenue_with_discount += parseFloat(item.total_line || '0')
      } else {
        catStats[cat].quantity_without_discount += item.quantity
        catStats[cat].revenue_without_discount += parseFloat(item.total_line || '0')
      }
    })

    breakdown = Object.values(catStats)
      .filter((c: any) => c.total_quantity >= minTransactions)
      .map((c: any) => ({
        category_name: c.category_name,
        total_quantity: c.total_quantity,
        discount_impact: {
          quantity_with_discount: c.quantity_with_discount,
          quantity_without_discount: c.quantity_without_discount,
          percent_sold_with_discount: parseFloat((c.quantity_with_discount / c.total_quantity * 100).toFixed(2))
        },
        revenue: {
          total: parseFloat(c.total_revenue.toFixed(2)),
          with_discount: parseFloat(c.revenue_with_discount.toFixed(2)),
          without_discount: parseFloat(c.revenue_without_discount.toFixed(2))
        }
      }))
      .sort((a: any, b: any) => b.discount_impact.percent_sold_with_discount - a.discount_impact.percent_sold_with_discount)
  }

  // Analyse de corrélation simple
  const correlationInsight = avgBasketWithDiscount > avgBasketNoDiscount
    ? 'Les paniers avec remise sont plus élevés en moyenne - la remise encourage les achats plus importants'
    : avgBasketWithDiscount < avgBasketNoDiscount
      ? 'Les paniers sans remise sont plus élevés - les remises sont appliquées sur des petits achats'
      : 'Pas de différence significative entre paniers avec et sans remise'

  return {
    success: true,
    action: 'discount_analysis' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: storeId || null,
      group_by: groupBy,
      min_transactions: minTransactions
    },
    data: {
      summary: {
        total_transactions: totalSales,
        transactions_with_discount: discountedSalesCount,
        discount_rate: parseFloat(discountedSalesPercent.toFixed(2)),
        total_discount_given: parseFloat(totalDiscountGiven.toFixed(2)),
        avg_basket_with_discount: parseFloat(avgBasketWithDiscount.toFixed(2)),
        avg_basket_without_discount: parseFloat(avgBasketNoDiscount.toFixed(2)),
        basket_difference: parseFloat((avgBasketWithDiscount - avgBasketNoDiscount).toFixed(2)),
        basket_difference_percent: avgBasketNoDiscount > 0
          ? parseFloat(((avgBasketWithDiscount - avgBasketNoDiscount) / avgBasketNoDiscount * 100).toFixed(2))
          : 0
      },
      correlation_insight: correlationInsight,
      breakdown
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

/**
 * Handler pour trend_analysis
 * Analyse des tendances sur période avec granularité
 * Version DENORMALISEE - utilise sale_items
 *
 * Paramètres:
 * - granularity: 'daily' | 'weekly' | 'monthly' - défaut: 'daily'
 * - metric: 'revenue' | 'transactions' | 'avg_basket' - défaut: 'revenue'
 * - vendor_id/vendor_name: filtrer par vendeur
 * - category_name: filtrer par catégorie
 * - compare_previous: inclure période précédente - défaut: true
 */
export async function handleTrendAnalysis(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod, startTime } = context

  const granularity = (params as any).granularity || 'daily'
  const metric = (params as any).metric || 'revenue'
  const storeId = params.store_id
  const vendorId = (params as any).vendor_id
  const vendorName = (params as any).vendor_name
  const categoryName = (params as any).category_name
  const comparePrevious = (params as any).compare_previous !== false

  // Récupérer les items depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, vendor_name, store_id, sale_date, total_line')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)
  if (vendorId) itemsQuery = itemsQuery.eq('vendor_id', vendorId)

  const currentItems = await fetchAllRows(itemsQuery.order('id'))

  // Filtrer par vendeur name si spécifié (recherche partielle)
  let filteredItems = currentItems
  if (vendorName && !vendorId) {
    const searchName = vendorName.toLowerCase()
    filteredItems = currentItems.filter((item: any) =>
      item.vendor_name && item.vendor_name.toLowerCase().includes(searchName)
    )
  }

  // Agréger les items par vente unique
  const salesMap = new Map<number, { total: number; sale_date: string }>()
  filteredItems.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId) return
    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, { total: 0, sale_date: item.sale_date })
    }
    salesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const currentSales = Array.from(salesMap.entries()).map(([id, data]) => ({
    id,
    total_amount_with_tax: data.total.toString(),
    sale_date: data.sale_date
  }))

  // Agréger par granularité
  const currentTrend = aggregateByGranularity(currentSales, granularity)

  // Période précédente si demandé
  let previousTrend: any = null
  if (comparePrevious && previousPeriod) {
    let prevItemsQuery = supabase
      .from('sale_items')
      .select('hiboutik_sale_id, vendor_id, vendor_name, sale_date, total_line')
      .gte('sale_date', previousPeriod.startDateTime)
      .lte('sale_date', previousPeriod.endDateTime)

    if (storeId) prevItemsQuery = prevItemsQuery.eq('store_id', storeId)
    if (vendorId) prevItemsQuery = prevItemsQuery.eq('vendor_id', vendorId)

    const prevItems = await fetchAllRows(prevItemsQuery.order('id'))

    let filteredPrevItems = prevItems
    if (vendorName && !vendorId) {
      const searchName = vendorName.toLowerCase()
      filteredPrevItems = prevItems.filter((item: any) =>
        item.vendor_name && item.vendor_name.toLowerCase().includes(searchName)
      )
    }

    // Agréger par vente
    const prevSalesMap = new Map<number, { total: number; sale_date: string }>()
    filteredPrevItems.forEach((item: any) => {
      const saleId = item.hiboutik_sale_id
      if (!saleId) return
      if (!prevSalesMap.has(saleId)) {
        prevSalesMap.set(saleId, { total: 0, sale_date: item.sale_date })
      }
      prevSalesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
    })

    const prevSales = Array.from(prevSalesMap.entries()).map(([id, data]) => ({
      id,
      total_amount_with_tax: data.total.toString(),
      sale_date: data.sale_date
    }))

    previousTrend = aggregateByGranularity(prevSales, granularity)
  }

  // Calculer les variations
  const trendData = currentTrend.map((point: any, index: number) => {
    const prevPoint = previousTrend?.[index]

    let variation = null
    if (prevPoint) {
      const currentValue = point[metric] || 0
      const prevValue = prevPoint[metric] || 0
      variation = {
        previous_value: prevValue,
        absolute_change: parseFloat((currentValue - prevValue).toFixed(2)),
        percent_change: prevValue > 0
          ? parseFloat(((currentValue - prevValue) / prevValue * 100).toFixed(2))
          : (currentValue > 0 ? 100 : 0)
      }
    }

    return {
      ...point,
      variation
    }
  })

  // Calculer les stats globales
  const totalRevenue = currentTrend.reduce((sum: number, p: any) => sum + p.revenue, 0)
  const totalTransactions = currentTrend.reduce((sum: number, p: any) => sum + p.transactions, 0)
  const avgBasket = totalTransactions > 0 ? totalRevenue / totalTransactions : 0

  // Trouver le pic et le creux
  const peak = [...currentTrend].sort((a: any, b: any) => b[metric] - a[metric])[0]
  const trough = [...currentTrend].sort((a: any, b: any) => a[metric] - b[metric])[0]

  return {
    success: true,
    action: 'trend_analysis' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      granularity,
      metric,
      store_id: storeId || null,
      vendor_id: vendorId || null,
      vendor_name: vendorName || null,
      category_name: categoryName || null
    },
    data: {
      summary: {
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        total_transactions: totalTransactions,
        avg_basket: parseFloat(avgBasket.toFixed(2)),
        data_points: trendData.length,
        peak: peak ? {
          period: peak.period_label,
          value: peak[metric]
        } : null,
        trough: trough ? {
          period: trough.period_label,
          value: trough[metric]
        } : null
      },
      compared_with: comparePrevious && previousPeriod ? {
        start_date: previousPeriod.startDate,
        end_date: previousPeriod.endDate
      } : null,
      trend: trendData
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

/**
 * Handler pour brand_share
 * Part de marché d'une marque dans une catégorie
 * Version DENORMALISEE - utilise sale_items
 */
export async function handleBrandShare(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const brandName = (params as any).brand_name
  const categoryName = (params as any).category_name
  const parentCategoryName = (params as any).parent_category_name
  const storeId = params.store_id
  const includeCompetitors = (params as any).include_competitors !== false

  if (!brandName) {
    return {
      success: false,
      action: 'brand_share' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: { error: 'brand_name requis' }
    }
  }

  // Récupérer les items directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('product_name, brand_name, quantity, total_line, parent_category_name, category_name, canonical_category_id')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'brand_share' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { brand_share: null, message: 'Aucune vente sur la période' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Filtrer virtuels
  let filteredItems = allItems.filter(item => !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id))

  // Filtrer par catégorie si demandé
  if (categoryName || parentCategoryName) {
    filteredItems = filteredItems.filter(item => {
      const cat = (item.category_name || '').toLowerCase()
      const parentCat = (item.parent_category_name || '').toLowerCase()

      if (categoryName && !cat.includes(categoryName.toLowerCase()) && !parentCat.includes(categoryName.toLowerCase())) {
        return false
      }
      if (parentCategoryName && !parentCat.includes(parentCategoryName.toLowerCase())) {
        return false
      }
      return true
    })
  }

  // Agréger par marque
  const brandStats: any = {}

  filteredItems.forEach((item: any) => {
    const brand = item.brand_name || 'Sans marque'

    if (!brandStats[brand]) {
      brandStats[brand] = {
        brand_name: brand,
        quantity: 0,
        revenue: 0,
        products: new Set()
      }
    }

    brandStats[brand].quantity += item.quantity
    brandStats[brand].revenue += parseFloat(item.total_line || '0')
    brandStats[brand].products.add(item.product_name)
  })

  // Totaux catégorie
  const categoryTotalQty = Object.values(brandStats).reduce((sum: number, b: any) => sum + b.quantity, 0)
  const categoryTotalRev = Object.values(brandStats).reduce((sum: number, b: any) => sum + b.revenue, 0)

  // Trouver la marque recherchée
  const targetBrand = Object.values(brandStats).find((b: any) =>
    b.brand_name.toLowerCase().includes(brandName.toLowerCase())
  ) as any

  if (!targetBrand) {
    return {
      success: true,
      action: 'brand_share' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: {
        brand_share: null,
        message: `Marque "${brandName}" non trouvée dans les ventes`
      },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Calculer la part de marché
  const brandShare = {
    brand_name: targetBrand.brand_name,
    quantity: targetBrand.quantity,
    revenue: parseFloat(targetBrand.revenue.toFixed(2)),
    unique_products: targetBrand.products.size,
    market_share: {
      by_quantity: parseFloat((targetBrand.quantity / categoryTotalQty * 100).toFixed(2)),
      by_revenue: parseFloat((targetBrand.revenue / categoryTotalRev * 100).toFixed(2))
    },
    category_context: {
      category_name: categoryName || parentCategoryName || 'Toutes catégories',
      total_quantity: categoryTotalQty,
      total_revenue: parseFloat(categoryTotalRev.toFixed(2)),
      brands_count: Object.keys(brandStats).length
    }
  }

  // Classement des concurrents
  const sortedBrands = Object.values(brandStats)
    .map((b: any) => ({
      brand_name: b.brand_name,
      quantity: b.quantity,
      revenue: parseFloat(b.revenue.toFixed(2)),
      market_share_qty: parseFloat((b.quantity / categoryTotalQty * 100).toFixed(2)),
      market_share_rev: parseFloat((b.revenue / categoryTotalRev * 100).toFixed(2))
    }))
    .sort((a: any, b: any) => b.revenue - a.revenue)

  const brandRank = sortedBrands.findIndex(b => b.brand_name === targetBrand.brand_name) + 1

  // Top 10 concurrents si demandé
  let competitors: any[] = []
  if (includeCompetitors) {
    competitors = sortedBrands
      .filter(b => b.brand_name !== targetBrand.brand_name)
      .slice(0, 10)
  }

  return {
    success: true,
    action: 'brand_share' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      brand_name: brandName,
      category_name: categoryName || null,
      parent_category_name: parentCategoryName || null,
      store_id: storeId || null
    },
    data: {
      brand_share: {
        ...brandShare,
        rank: brandRank,
        total_brands: sortedBrands.length
      },
      competitors: includeCompetitors ? competitors : undefined,
      top_products: [...targetBrand.products].slice(0, 10)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

// ============================================
// HELPERS
// ============================================

function aggregateByGranularity(sales: any[], granularity: string): any[] {
  const buckets: any = {}

  sales.forEach((sale: any) => {
    const date = new Date(sale.sale_date)
    let key: string
    let label: string

    if (granularity === 'weekly') {
      // Semaine ISO
      const weekStart = new Date(date)
      weekStart.setDate(date.getDate() - date.getDay() + 1) // Lundi
      key = weekStart.toISOString().split('T')[0]
      label = `Semaine du ${weekStart.toLocaleDateString('fr-FR')}`
    } else if (granularity === 'monthly') {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      label = date.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    } else {
      // daily
      key = sale.sale_date.split('T')[0]
      label = new Date(key).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
    }

    if (!buckets[key]) {
      buckets[key] = {
        period_key: key,
        period_label: label,
        revenue: 0,
        transactions: 0
      }
    }

    buckets[key].revenue += parseFloat(sale.total_amount_with_tax || '0')
    buckets[key].transactions += 1
  })

  return Object.values(buckets)
    .map((b: any) => ({
      ...b,
      revenue: parseFloat(b.revenue.toFixed(2)),
      avg_basket: b.transactions > 0 ? parseFloat((b.revenue / b.transactions).toFixed(2)) : 0
    }))
    .sort((a: any, b: any) => a.period_key.localeCompare(b.period_key))
}
