/**
 * Action: anomaly_detection
 * Détection d'anomalies (produits, vendeurs, catégories)
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
 * Handler pour anomaly_detection
 *
 * Paramètres:
 * - type: 'all' | 'products' | 'vendors' | 'categories' - défaut: 'all'
 * - threshold_percent: seuil de variation pour anomalie - défaut: 30
 * - severity: 'all' | 'critical' | 'warning' - défaut: 'all'
 * - store_id: filtrer par magasin
 */
export async function handleAnomalyDetection(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const anomalyType = (params as any).type || 'all'
  const thresholdPercent = (params as any).threshold_percent || 30
  const severityFilter = (params as any).severity || 'all'
  const storeId = params.store_id

  // Période précédente pour comparaison
  const previousPeriod = calculatePreviousPeriod(period)

  const anomalies: any = {
    products: [],
    vendors: [],
    categories: [],
    summary: {
      critical_count: 0,
      warning_count: 0,
      total_anomalies: 0
    }
  }

  // ============================================
  // 1. ANOMALIES PRODUITS
  // ============================================
  if (anomalyType === 'all' || anomalyType === 'products') {
    const productAnomalies = await detectProductAnomalies(
      supabase, period, previousPeriod, storeId, thresholdPercent
    )
    anomalies.products = filterBySeverity(productAnomalies, severityFilter)
  }

  // ============================================
  // 2. ANOMALIES VENDEURS
  // ============================================
  if (anomalyType === 'all' || anomalyType === 'vendors') {
    const vendorAnomalies = await detectVendorAnomalies(
      supabase, period, previousPeriod, storeId, thresholdPercent
    )
    anomalies.vendors = filterBySeverity(vendorAnomalies, severityFilter)
  }

  // ============================================
  // 3. ANOMALIES CATÉGORIES
  // ============================================
  if (anomalyType === 'all' || anomalyType === 'categories') {
    const categoryAnomalies = await detectCategoryAnomalies(
      supabase, period, previousPeriod, storeId, thresholdPercent
    )
    anomalies.categories = filterBySeverity(categoryAnomalies, severityFilter)
  }

  // Résumé
  const allAnomalies = [...anomalies.products, ...anomalies.vendors, ...anomalies.categories]
  anomalies.summary.critical_count = allAnomalies.filter((a: any) => a.severity === 'critical').length
  anomalies.summary.warning_count = allAnomalies.filter((a: any) => a.severity === 'warning').length
  anomalies.summary.total_anomalies = allAnomalies.length

  return {
    success: true,
    action: 'anomaly_detection' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      type: anomalyType,
      threshold_percent: thresholdPercent,
      severity: severityFilter,
      store_id: storeId || null
    },
    data: anomalies,
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime,
      compared_with: {
        start_date: previousPeriod.startDate,
        end_date: previousPeriod.endDate
      }
    }
  }
}

/**
 * Détecte les anomalies sur les produits
 */
async function detectProductAnomalies(
  supabase: any,
  currentPeriod: any,
  previousPeriod: any,
  storeId: number | undefined,
  threshold: number
): Promise<any[]> {
  // Ventes période actuelle
  const currentStats = await getProductStats(supabase, currentPeriod, storeId)

  // Ventes période précédente
  const previousStats = await getProductStats(supabase, previousPeriod, storeId)

  const anomalies: any[] = []

  // Comparer chaque produit
  for (const [productName, current] of Object.entries(currentStats) as any) {
    const previous = previousStats[productName] || { quantity: 0, revenue: 0 }

    // Calculer la variation
    const qtyVariation = previous.quantity > 0
      ? ((current.quantity - previous.quantity) / previous.quantity * 100)
      : (current.quantity > 0 ? 100 : 0)

    const revVariation = previous.revenue > 0
      ? ((current.revenue - previous.revenue) / previous.revenue * 100)
      : (current.revenue > 0 ? 100 : 0)

    // Détecter anomalie
    if (Math.abs(qtyVariation) >= threshold || Math.abs(revVariation) >= threshold) {
      const isDropping = qtyVariation < 0 || revVariation < 0
      const severity = Math.abs(qtyVariation) >= 50 || Math.abs(revVariation) >= 50
        ? 'critical'
        : 'warning'

      anomalies.push({
        entity_type: 'product',
        entity_name: productName,
        entity_id: current.product_id,
        severity,
        anomaly_type: isDropping ? 'decline' : 'spike',
        current_period: {
          quantity: current.quantity,
          revenue: parseFloat(current.revenue.toFixed(2))
        },
        previous_period: {
          quantity: previous.quantity,
          revenue: parseFloat(previous.revenue.toFixed(2))
        },
        variation: {
          quantity_percent: parseFloat(qtyVariation.toFixed(2)),
          revenue_percent: parseFloat(revVariation.toFixed(2))
        },
        message: isDropping
          ? `Baisse de ${Math.abs(qtyVariation).toFixed(0)}% en quantité`
          : `Hausse de ${qtyVariation.toFixed(0)}% en quantité`
      })
    }
  }

  // Vérifier les produits qui étaient vendus avant mais plus maintenant
  for (const [productName, previous] of Object.entries(previousStats) as any) {
    if (!currentStats[productName] && previous.quantity >= 5) {
      anomalies.push({
        entity_type: 'product',
        entity_name: productName,
        entity_id: previous.product_id,
        severity: 'critical',
        anomaly_type: 'stopped_selling',
        current_period: { quantity: 0, revenue: 0 },
        previous_period: {
          quantity: previous.quantity,
          revenue: parseFloat(previous.revenue.toFixed(2))
        },
        variation: { quantity_percent: -100, revenue_percent: -100 },
        message: `Produit arrêté: vendait ${previous.quantity} unités sur période précédente`
      })
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.variation.quantity_percent) - Math.abs(a.variation.quantity_percent))
}

/**
 * Détecte les anomalies sur les vendeurs
 */
async function detectVendorAnomalies(
  supabase: any,
  currentPeriod: any,
  previousPeriod: any,
  storeId: number | undefined,
  threshold: number
): Promise<any[]> {
  // Récupérer les vendeurs
  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, first_name, last_name, canonical_vendor_id')
    .eq('is_active', true)

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
        linked_ids: []
      }
    }
    canonicalMap[canonicalId].linked_ids.push(v.id)
  })

  // Stats période actuelle
  const currentStats = await getVendorStats(supabase, currentPeriod, storeId, canonicalMap)

  // Stats période précédente
  const previousStats = await getVendorStats(supabase, previousPeriod, storeId, canonicalMap)

  // Calculer la moyenne d'équipe actuelle
  const teamCurrentStats = Object.values(currentStats)
  const teamAvgRevenue = teamCurrentStats.length > 0
    ? teamCurrentStats.reduce((sum: number, v: any) => sum + v.revenue, 0) / teamCurrentStats.length
    : 0

  const anomalies: any[] = []

  for (const [vendorId, current] of Object.entries(currentStats) as any) {
    const previous = previousStats[vendorId] || { revenue: 0, transactions: 0 }

    // Variation vs période précédente
    const revVariation = previous.revenue > 0
      ? ((current.revenue - previous.revenue) / previous.revenue * 100)
      : 0

    // Variation vs moyenne équipe
    const vsTeamAvg = teamAvgRevenue > 0
      ? ((current.revenue - teamAvgRevenue) / teamAvgRevenue * 100)
      : 0

    // Sous-performance par rapport à l'historique OU l'équipe
    const isUnderperforming = revVariation < -threshold || vsTeamAvg < -threshold

    if (isUnderperforming || Math.abs(revVariation) >= threshold) {
      const severity = revVariation < -50 || vsTeamAvg < -50 ? 'critical' : 'warning'

      // CORRECTION v2.1: Utiliser vendor_name depuis currentStats (capturé de sale_items)
      anomalies.push({
        entity_type: 'vendor',
        entity_name: current.vendor_name || `Vendeur ${vendorId}`,
        entity_id: parseInt(vendorId),
        severity,
        anomaly_type: revVariation < 0 ? 'underperforming' : 'overperforming',
        current_period: {
          revenue: parseFloat(current.revenue.toFixed(2)),
          transactions: current.transactions
        },
        previous_period: {
          revenue: parseFloat(previous.revenue.toFixed(2)),
          transactions: previous.transactions
        },
        variation: {
          vs_previous_percent: parseFloat(revVariation.toFixed(2)),
          vs_team_avg_percent: parseFloat(vsTeamAvg.toFixed(2))
        },
        team_context: {
          team_avg_revenue: parseFloat(teamAvgRevenue.toFixed(2)),
          position: vsTeamAvg >= 0 ? 'above_avg' : 'below_avg'
        },
        message: isUnderperforming
          ? `Sous-performance: ${revVariation.toFixed(0)}% vs période précédente, ${vsTeamAvg.toFixed(0)}% vs moyenne équipe`
          : `Variation de ${revVariation.toFixed(0)}% vs période précédente`
      })
    }
  }

  return anomalies.sort((a, b) => a.variation.vs_previous_percent - b.variation.vs_previous_percent)
}

/**
 * Détecte les anomalies sur les catégories
 */
async function detectCategoryAnomalies(
  supabase: any,
  currentPeriod: any,
  previousPeriod: any,
  storeId: number | undefined,
  threshold: number
): Promise<any[]> {
  const currentStats = await getCategoryStats(supabase, currentPeriod, storeId)
  const previousStats = await getCategoryStats(supabase, previousPeriod, storeId)

  const anomalies: any[] = []

  for (const [category, current] of Object.entries(currentStats) as any) {
    const previous = previousStats[category] || { quantity: 0, revenue: 0 }

    const qtyVariation = previous.quantity > 0
      ? ((current.quantity - previous.quantity) / previous.quantity * 100)
      : (current.quantity > 0 ? 100 : 0)

    const revVariation = previous.revenue > 0
      ? ((current.revenue - previous.revenue) / previous.revenue * 100)
      : (current.revenue > 0 ? 100 : 0)

    if (Math.abs(qtyVariation) >= threshold || Math.abs(revVariation) >= threshold) {
      const isDropping = qtyVariation < 0 || revVariation < 0
      const severity = Math.abs(qtyVariation) >= 50 || Math.abs(revVariation) >= 50
        ? 'critical'
        : 'warning'

      anomalies.push({
        entity_type: 'category',
        entity_name: category,
        severity,
        anomaly_type: isDropping ? 'decline' : 'spike',
        current_period: {
          quantity: current.quantity,
          revenue: parseFloat(current.revenue.toFixed(2))
        },
        previous_period: {
          quantity: previous.quantity,
          revenue: parseFloat(previous.revenue.toFixed(2))
        },
        variation: {
          quantity_percent: parseFloat(qtyVariation.toFixed(2)),
          revenue_percent: parseFloat(revVariation.toFixed(2))
        },
        message: isDropping
          ? `Catégorie en baisse: ${Math.abs(revVariation).toFixed(0)}% de CA`
          : `Catégorie en hausse: +${revVariation.toFixed(0)}% de CA`
      })
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.variation.revenue_percent) - Math.abs(a.variation.revenue_percent))
}

// ============================================
// HELPERS
// ============================================

async function getProductStats(supabase: any, period: any, storeId?: number) {
  // Récupérer directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('product_name, product_id, quantity, total_line, canonical_category_id')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))
  if (allItems.length === 0) return {}

  // Filtrer virtuels
  const filteredItems = allItems.filter(item => !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id))

  const stats: any = {}
  filteredItems.forEach((item: any) => {
    const name = item.product_name
    if (!stats[name]) {
      stats[name] = { product_id: item.product_id, quantity: 0, revenue: 0 }
    }
    stats[name].quantity += item.quantity
    stats[name].revenue += parseFloat(item.total_line || '0')
  })

  return stats
}

async function getVendorStats(supabase: any, period: any, storeId: number | undefined, canonicalMap: any) {
  // CORRECTION v2.1: Récupérer vendor_name depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, vendor_name, total_line')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const items = await fetchAllRows(itemsQuery.order('id'))

  // Agréger par vente unique pour calculer le revenu et transactions
  const salesMap = new Map<number, { vendor_id: number; vendor_name: string; total: number }>()
  items.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId || !item.vendor_id || EXCLUDED_VENDOR_IDS.includes(item.vendor_id)) return

    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, { vendor_id: item.vendor_id, vendor_name: item.vendor_name || '', total: 0 })
    }
    salesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const stats: any = {}
  salesMap.forEach((sale, saleId) => {
    // Trouver le canonical_id
    let canonicalId = sale.vendor_id
    for (const [cid, canonical] of Object.entries(canonicalMap) as any) {
      if (canonical.linked_ids.includes(sale.vendor_id)) {
        canonicalId = parseInt(cid)
        break
      }
    }

    if (!stats[canonicalId]) {
      // CORRECTION v2.1: Capturer le nom du vendeur depuis sale_items
      stats[canonicalId] = {
        revenue: 0,
        transactions: 0,
        vendor_name: canonicalMap[canonicalId]?.name || sale.vendor_name || `Vendeur ${canonicalId}`
      }
    }
    stats[canonicalId].revenue += sale.total
    stats[canonicalId].transactions += 1
  })

  return stats
}

async function getCategoryStats(supabase: any, period: any, storeId?: number) {
  // Récupérer directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('parent_category_name, category_name, quantity, total_line, canonical_category_id')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))
  if (allItems.length === 0) return {}

  const filteredItems = allItems.filter(item => !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id))

  const stats: any = {}
  filteredItems.forEach((item: any) => {
    const cat = item.parent_category_name || item.category_name || 'Non catégorisé'
    if (!stats[cat]) {
      stats[cat] = { quantity: 0, revenue: 0 }
    }
    stats[cat].quantity += item.quantity
    stats[cat].revenue += parseFloat(item.total_line || '0')
  })

  return stats
}

function filterBySeverity(anomalies: any[], severity: string): any[] {
  if (severity === 'all') return anomalies
  return anomalies.filter(a => a.severity === severity)
}

/**
 * Handler pour vendors_underperforming
 * Liste les vendeurs en sous-performance aujourd'hui
 */
export async function handleVendorsUnderperforming(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod, startTime } = context

  const storeId = params.store_id
  const threshold = (params as any).threshold_percent || 20

  // Utiliser la période précédente fournie ou la calculer
  const compPeriod = previousPeriod || calculatePreviousPeriod(period)

  // Récupérer les vendeurs
  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, first_name, last_name, canonical_vendor_id')
    .eq('is_active', true)

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
        linked_ids: []
      }
    }
    canonicalMap[canonicalId].linked_ids.push(v.id)
  })

  const currentStats = await getVendorStats(supabase, period, storeId, canonicalMap)
  const previousStats = await getVendorStats(supabase, compPeriod, storeId, canonicalMap)

  // Moyenne d'équipe actuelle
  const teamStats = Object.values(currentStats)
  const teamAvgRevenue = teamStats.length > 0
    ? teamStats.reduce((sum: number, v: any) => sum + v.revenue, 0) / teamStats.length
    : 0

  const underperformers: any[] = []

  for (const [vendorId, current] of Object.entries(currentStats) as any) {
    const previous = previousStats[vendorId] || { revenue: 0, transactions: 0 }

    const vsHistorical = previous.revenue > 0
      ? ((current.revenue - previous.revenue) / previous.revenue * 100)
      : 0

    const vsTeam = teamAvgRevenue > 0
      ? ((current.revenue - teamAvgRevenue) / teamAvgRevenue * 100)
      : 0

    // Sous-performance si en dessous du seuil
    if (vsHistorical < -threshold || vsTeam < -threshold) {
      // CORRECTION v2.1: Utiliser vendor_name depuis currentStats
      underperformers.push({
        vendor_id: parseInt(vendorId),
        vendor_name: current.vendor_name || `Vendeur ${vendorId}`,
        current_revenue: parseFloat(current.revenue.toFixed(2)),
        current_transactions: current.transactions,
        previous_revenue: parseFloat(previous.revenue.toFixed(2)),
        vs_historical_percent: parseFloat(vsHistorical.toFixed(2)),
        vs_team_avg_percent: parseFloat(vsTeam.toFixed(2)),
        severity: vsHistorical < -50 || vsTeam < -50 ? 'critical' : 'warning',
        recommendation: vsHistorical < -30
          ? 'Coaching recommandé - performance en baisse significative'
          : 'Suivi à prévoir - légère sous-performance'
      })
    }
  }

  // Trier par variation historique (pires en premier)
  underperformers.sort((a, b) => a.vs_historical_percent - b.vs_historical_percent)

  return {
    success: true,
    action: 'vendors_underperforming' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    data: {
      threshold_percent: threshold,
      team_context: {
        total_vendors: Object.keys(currentStats).length,
        underperforming_count: underperformers.length,
        team_avg_revenue: parseFloat(teamAvgRevenue.toFixed(2))
      },
      compared_with: {
        start_date: compPeriod.startDate,
        end_date: compPeriod.endDate
      },
      underperformers
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}
