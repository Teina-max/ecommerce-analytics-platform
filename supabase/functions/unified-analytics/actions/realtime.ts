/**
 * Action: realtime_sales
 * Ventes en temps réel avec intervalles (15 min, 1h, etc.)
 * Compare avec historique à la même heure
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import type { ExecutionContext, AnalyticsResult } from '../types.ts'
import { fetchAllRows } from '../../_shared/pagination.ts'
import { getParisOffset } from '../../_shared/dates.ts'

const VERSION = '2.1-pagination-fix'

// Catégories virtuelles à exclure
const VIRTUAL_CATEGORY_IDS = [8, 9, 10, 11]

/**
 * Obtient l'heure actuelle à Paris
 */
function getNowParis(): Date {
  const now = new Date()
  const parisOffset = getParisOffset()
  return new Date(now.getTime() + parisOffset * 60 * 60 * 1000)
}

/**
 * Handler pour realtime_sales
 *
 * Paramètres:
 * - minutes: intervalle en minutes (15, 30, 60, etc.) - défaut: 60
 * - compare_days: jours historiques pour moyenne - défaut: 7
 * - group_by: 'product' | 'category' | 'vendor' | 'store' - défaut: none
 * - store_id: filtrer par magasin
 */
export async function handleRealtimeSales(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, startTime } = context

  const minutes = (params as any).minutes || 60
  const compareDays = (params as any).compare_days || 7
  const groupBy = (params as any).group_by || null
  const storeId = params.store_id

  const nowParis = getNowParis()
  const parisOffset = getParisOffset()

  // Calculer l'intervalle actuel
  const intervalStart = new Date(nowParis.getTime() - minutes * 60 * 1000)

  // Convertir en UTC pour les requêtes SQL
  const intervalStartUTC = new Date(intervalStart.getTime() - parisOffset * 60 * 60 * 1000)
  const nowUTC = new Date(nowParis.getTime() - parisOffset * 60 * 60 * 1000)

  // ============================================
  // 1. VENTES TEMPS RÉEL (intervalle actuel) - depuis sale_items dénormalisé
  // ============================================
  let itemsQuery = supabase
    .from('sale_items')
    .select('id, hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, sale_date, total_line, product_name, product_id, quantity, category_name, parent_category_name, canonical_category_id')
    .gte('sale_date', intervalStartUTC.toISOString())
    .lte('sale_date', nowUTC.toISOString())

  if (storeId) {
    itemsQuery = itemsQuery.eq('store_id', storeId)
  }

  const currentItems = await fetchAllRows(itemsQuery.order('id'))

  // Agréger les items par vente unique pour calculer les totaux
  const salesMap = new Map<number, { total: number; vendor_id: number | null; store_id: number | null }>()
  currentItems.forEach(item => {
    const saleId = item.hiboutik_sale_id
    if (!saleId) return
    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, { total: 0, vendor_id: item.vendor_id, store_id: item.store_id })
    }
    salesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const currentSales = Array.from(salesMap.entries()).map(([id, data]) => ({
    id,
    total_amount_with_tax: data.total,
    vendor_id: data.vendor_id,
    store_id: data.store_id
  }))

  // Calculer les totaux actuels
  const currentRevenue = currentSales.reduce((sum: number, s: any) =>
    sum + parseFloat(s.total_amount_with_tax || '0'), 0)
  const currentTransactions = currentSales.length

  // ============================================
  // 2. VENTES HISTORIQUES (même créneau horaire) - depuis sale_items
  // ============================================
  const historicalData: any[] = []

  for (let d = 1; d <= compareDays; d++) {
    const historicalStart = new Date(intervalStartUTC)
    historicalStart.setDate(historicalStart.getDate() - d)

    const historicalEnd = new Date(nowUTC)
    historicalEnd.setDate(historicalEnd.getDate() - d)

    let histQuery = supabase
      .from('sale_items')
      .select('hiboutik_sale_id, total_line')
      .gte('sale_date', historicalStart.toISOString())
      .lte('sale_date', historicalEnd.toISOString())

    if (storeId) {
      histQuery = histQuery.eq('store_id', storeId)
    }

    const { data: histItems } = await histQuery

    // Agréger par vente unique
    const histSalesMap = new Map<number, number>()
    histItems?.forEach((item: any) => {
      const saleId = item.hiboutik_sale_id
      if (!saleId) return
      histSalesMap.set(saleId, (histSalesMap.get(saleId) || 0) + parseFloat(item.total_line || '0'))
    })

    const dayRevenue = Array.from(histSalesMap.values()).reduce((sum, v) => sum + v, 0)
    const dayTransactions = histSalesMap.size

    historicalData.push({
      days_ago: d,
      date: historicalStart.toISOString().split('T')[0],
      revenue: dayRevenue,
      transactions: dayTransactions
    })
  }

  // Calculer la moyenne historique
  const avgHistoricalRevenue = historicalData.length > 0
    ? historicalData.reduce((sum, d) => sum + d.revenue, 0) / historicalData.length
    : 0
  const avgHistoricalTransactions = historicalData.length > 0
    ? historicalData.reduce((sum, d) => sum + d.transactions, 0) / historicalData.length
    : 0

  // Calculer la variation
  const revenueVariation = avgHistoricalRevenue > 0
    ? ((currentRevenue - avgHistoricalRevenue) / avgHistoricalRevenue * 100)
    : (currentRevenue > 0 ? 100 : 0)
  const transactionVariation = avgHistoricalTransactions > 0
    ? ((currentTransactions - avgHistoricalTransactions) / avgHistoricalTransactions * 100)
    : (currentTransactions > 0 ? 100 : 0)

  // ============================================
  // 3. DÉTECTION ANOMALIE
  // ============================================
  let anomalyStatus = 'normal'
  let anomalyMessage = null

  if (Math.abs(revenueVariation) >= 50) {
    anomalyStatus = revenueVariation > 0 ? 'spike' : 'drop'
    anomalyMessage = revenueVariation > 0
      ? `Pic de ventes: +${revenueVariation.toFixed(0)}% par rapport à la moyenne`
      : `Baisse anormale: ${revenueVariation.toFixed(0)}% par rapport à la moyenne`
  } else if (Math.abs(revenueVariation) >= 30) {
    anomalyStatus = 'warning'
    anomalyMessage = revenueVariation > 0
      ? `Hausse notable: +${revenueVariation.toFixed(0)}%`
      : `Baisse notable: ${revenueVariation.toFixed(0)}%`
  }

  // ============================================
  // 4. GROUPEMENT (si demandé) - utilise currentItems déjà récupérés
  // ============================================
  let breakdown: any = null

  if (groupBy && currentItems.length > 0) {
    // Filtrer les virtuels
    let allItems = currentItems.filter(item =>
      !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id)
    )

    if (groupBy === 'product') {
      const productStats: any = {}
      allItems.forEach((item: any) => {
        const name = item.product_name
        if (!productStats[name]) {
          productStats[name] = { product_name: name, quantity: 0, revenue: 0 }
        }
        productStats[name].quantity += item.quantity
        productStats[name].revenue += parseFloat(item.total_line || '0')
      })

      breakdown = Object.values(productStats)
        .sort((a: any, b: any) => b.quantity - a.quantity)
        .slice(0, 20)
        .map((p: any, i: number) => ({
          rank: i + 1,
          product_name: p.product_name,
          quantity: p.quantity,
          revenue: parseFloat(p.revenue.toFixed(2)),
          velocity: parseFloat((p.quantity / (minutes / 60)).toFixed(2)) // unités/heure
        }))
    } else if (groupBy === 'category') {
      const catStats: any = {}
      allItems.forEach((item: any) => {
        const cat = item.parent_category_name || item.category_name || 'Non catégorisé'
        if (!catStats[cat]) {
          catStats[cat] = { category_name: cat, quantity: 0, revenue: 0 }
        }
        catStats[cat].quantity += item.quantity
        catStats[cat].revenue += parseFloat(item.total_line || '0')
      })

      breakdown = Object.values(catStats)
        .sort((a: any, b: any) => b.revenue - a.revenue)
        .slice(0, 15)
    } else if (groupBy === 'vendor') {
      // Agréger par vendeur depuis les items dénormalisés
      const vendorStats: any = {}
      const vendorSalesMap: Record<number, Set<number>> = {}

      allItems.forEach((item: any) => {
        const vid = item.vendor_id
        const vendorName = item.vendor_name
        if (!vid || !vendorName) return

        if (!vendorStats[vid]) {
          vendorStats[vid] = {
            vendor_id: vid,
            vendor_name: vendorName,
            revenue: 0,
            transactions: 0
          }
          vendorSalesMap[vid] = new Set()
        }
        vendorStats[vid].revenue += parseFloat(item.total_line || '0')
        if (item.hiboutik_sale_id) {
          vendorSalesMap[vid].add(item.hiboutik_sale_id)
        }
      })

      // Compter les transactions uniques
      Object.keys(vendorStats).forEach(vid => {
        vendorStats[vid].transactions = vendorSalesMap[parseInt(vid)]?.size || 0
      })

      breakdown = Object.values(vendorStats)
        .sort((a: any, b: any) => b.revenue - a.revenue)
    }
  }

  // ============================================
  // 5. RÉPONSE
  // ============================================
  return {
    success: true,
    action: 'realtime_sales' as any,
    version: VERSION,
    period: {
      start_date: intervalStart.toISOString(),
      end_date: nowParis.toISOString(),
      days: 0
    },
    filters: {
      minutes,
      compare_days: compareDays,
      group_by: groupBy,
      store_id: storeId || null
    },
    data: {
      current: {
        interval_minutes: minutes,
        interval_start: intervalStart.toISOString(),
        interval_end: nowParis.toISOString(),
        revenue: parseFloat(currentRevenue.toFixed(2)),
        transactions: currentTransactions,
        avg_basket: currentTransactions > 0
          ? parseFloat((currentRevenue / currentTransactions).toFixed(2))
          : 0
      },

      historical_average: {
        days_compared: compareDays,
        avg_revenue: parseFloat(avgHistoricalRevenue.toFixed(2)),
        avg_transactions: parseFloat(avgHistoricalTransactions.toFixed(1))
      },

      comparison: {
        revenue_variation_percent: parseFloat(revenueVariation.toFixed(2)),
        transaction_variation_percent: parseFloat(transactionVariation.toFixed(2)),
        revenue_difference: parseFloat((currentRevenue - avgHistoricalRevenue).toFixed(2)),
        transaction_difference: Math.round(currentTransactions - avgHistoricalTransactions)
      },

      anomaly: {
        status: anomalyStatus,
        message: anomalyMessage,
        requires_attention: anomalyStatus === 'spike' || anomalyStatus === 'drop'
      },

      breakdown: breakdown,

      historical_detail: historicalData.slice(0, 5)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime,
      timezone: 'Europe/Paris',
      paris_offset: parisOffset
    }
  }
}

/**
 * Handler pour velocity_products
 * Produits qui se vendent le plus rapidement (vélocité)
 */
export async function handleVelocityProducts(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const storeId = params.store_id
  const limit = params.limit || 20

  // Récupérer les items directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('product_name, product_id, quantity, total_line, canonical_category_id, sale_date')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) {
    itemsQuery = itemsQuery.eq('store_id', storeId)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'velocity_products' as any,
      version: VERSION,
      period: {
        start_date: period.startDate,
        end_date: period.endDate,
        days: period.days
      },
      data: { products: [], message: 'Aucune vente sur la période' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Filtrer virtuels
  const filteredItems = allItems.filter(item =>
    !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id)
  )

  // Calculer la vélocité par produit
  const hoursInPeriod = period.days * 24
  const productStats: any = {}

  filteredItems.forEach((item: any) => {
    const name = item.product_name
    if (!productStats[name]) {
      productStats[name] = {
        product_name: name,
        product_id: item.product_id,
        quantity: 0,
        revenue: 0
      }
    }
    productStats[name].quantity += item.quantity
    productStats[name].revenue += parseFloat(item.total_line || '0')
  })

  const products = Object.values(productStats)
    .map((p: any) => ({
      ...p,
      revenue: parseFloat(p.revenue.toFixed(2)),
      velocity_per_hour: parseFloat((p.quantity / hoursInPeriod).toFixed(3)),
      velocity_per_day: parseFloat((p.quantity / period.days).toFixed(2))
    }))
    .sort((a: any, b: any) => b.velocity_per_hour - a.velocity_per_hour)
    .slice(0, limit)
    .map((p: any, i: number) => ({ rank: i + 1, ...p }))

  return {
    success: true,
    action: 'velocity_products' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    data: {
      hours_analyzed: hoursInPeriod,
      products
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}
