/**
 * Actions d'analyse de marge et rotation produits
 * - products_margin: Produits les plus rentables
 * - products_declining: Produits en perte de vitesse
 * - product_rotation: Taux de rotation par produit
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import type { ExecutionContext, AnalyticsResult } from '../types.ts'
import { fetchAllRows } from '../../_shared/pagination.ts'
import { calculatePreviousPeriod } from '../../_shared/dates.ts'

const VERSION = '2.2-pagination-fix'

// Catégories virtuelles à exclure
const VIRTUAL_CATEGORY_IDS = [8, 9, 10, 11]

/**
 * Handler pour products_margin
 * Retourne les produits les plus rentables (basé sur le prix d'achat si disponible)
 *
 * Paramètres:
 * - store_id: filtrer par magasin
 * - limit: nombre de produits (défaut: 20)
 * - category_name: filtrer par catégorie
 * - min_quantity: quantité minimum vendue (défaut: 3)
 */
export async function handleProductsMargin(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const storeId = params.store_id
  const limit = params.limit || 20
  const categoryFilter = (params as any).category_name
  const minQuantity = (params as any).min_quantity || 3

  // CORRECTION v2.1: Récupérer les items avec supply_price DIRECTEMENT depuis sale_items
  // (au lieu de chercher dans la table products qui a souvent des valeurs vides)
  let itemsQuery = supabase
    .from('sale_items')
    .select('product_id, product_name, brand_name, quantity, unit_price, total_line, supply_price, parent_category_name, category_name, canonical_category_id')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  let allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'products_margin' as any,
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

  // Filtrer virtuels et par catégorie si demandé
  allItems = allItems.filter(item => {
    if (VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id)) return false
    if (categoryFilter) {
      const cat = (item.parent_category_name || item.category_name || '').toLowerCase()
      if (!cat.includes(categoryFilter.toLowerCase())) return false
    }
    return true
  })

  // CORRECTION v2.1: Agréger par produit en utilisant supply_price de CHAQUE item
  const productStats: any = {}

  allItems.forEach((item: any) => {
    const pid = item.product_id
    const itemSupplyPrice = parseFloat(item.supply_price || '0')

    if (!productStats[pid]) {
      productStats[pid] = {
        product_id: pid,
        product_name: item.product_name,
        brand: item.brand_name || 'Inconnu',
        supply_price: itemSupplyPrice,  // Prendre le premier supply_price trouvé
        quantity: 0,
        revenue: 0,
        total_cost: 0,
        has_supply_price: itemSupplyPrice > 0
      }
    }

    const qty = item.quantity || 0
    const revenue = parseFloat(item.total_line || '0')
    // Utiliser le supply_price de l'item (déjà stocké au moment de la vente)
    const unitCost = itemSupplyPrice > 0 ? itemSupplyPrice : productStats[pid].supply_price

    productStats[pid].quantity += qty
    productStats[pid].revenue += revenue
    productStats[pid].total_cost += qty * unitCost

    // Mettre à jour has_supply_price si on trouve un supply_price valide
    if (itemSupplyPrice > 0) {
      productStats[pid].has_supply_price = true
      productStats[pid].supply_price = itemSupplyPrice
    }
  })

  // Calculer la marge et trier (CORRECTION v2.1: utiliser has_supply_price)
  const productsWithMargin = Object.values(productStats)
    .filter((p: any) => p.quantity >= minQuantity && p.has_supply_price)
    .map((p: any) => {
      const marginTotal = p.revenue - p.total_cost
      const marginPercent = p.revenue > 0 ? (marginTotal / p.revenue * 100) : 0
      const marginPerUnit = p.quantity > 0 ? marginTotal / p.quantity : 0

      return {
        product_id: p.product_id,
        product_name: p.product_name,
        brand: p.brand,
        quantity_sold: p.quantity,
        revenue: parseFloat(p.revenue.toFixed(2)),
        total_cost: parseFloat(p.total_cost.toFixed(2)),
        margin_total: parseFloat(marginTotal.toFixed(2)),
        margin_percent: parseFloat(marginPercent.toFixed(2)),
        margin_per_unit: parseFloat(marginPerUnit.toFixed(2)),
        supply_price: p.supply_price,
        avg_sell_price: parseFloat((p.revenue / p.quantity).toFixed(2))
      }
    })
    .sort((a: any, b: any) => b.margin_total - a.margin_total)
    .slice(0, limit)
    .map((p: any, i: number) => ({ rank: i + 1, ...p }))

  // Stats globales
  const totalMargin = productsWithMargin.reduce((sum, p) => sum + p.margin_total, 0)
  const totalRevenue = productsWithMargin.reduce((sum, p) => sum + p.revenue, 0)
  const avgMarginPercent = totalRevenue > 0 ? (totalMargin / totalRevenue * 100) : 0

  return {
    success: true,
    action: 'products_margin' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: storeId || null,
      category_name: categoryFilter || null,
      min_quantity: minQuantity
    },
    data: {
      summary: {
        products_analyzed: productsWithMargin.length,
        total_margin: parseFloat(totalMargin.toFixed(2)),
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        avg_margin_percent: parseFloat(avgMarginPercent.toFixed(2)),
        top_performer: productsWithMargin[0] || null
      },
      products: productsWithMargin,
      note: 'Produits sans prix d\'achat (supply_price) sont exclus'
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

/**
 * Handler pour products_declining
 * Produits en perte de vitesse vs période précédente
 *
 * Paramètres:
 * - store_id: filtrer par magasin
 * - limit: nombre de produits (défaut: 20)
 * - threshold_percent: seuil de baisse (défaut: 20)
 * - min_previous_quantity: quantité minimum période précédente (défaut: 5)
 */
export async function handleProductsDeclining(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod, startTime } = context

  const storeId = params.store_id
  const limit = params.limit || 20
  const threshold = (params as any).threshold_percent || 20
  const minPrevQty = (params as any).min_previous_quantity || 5

  const compPeriod = previousPeriod || calculatePreviousPeriod(period)

  // Stats période actuelle
  const currentStats = await getProductSalesStats(supabase, period, storeId)

  // Stats période précédente
  const previousStats = await getProductSalesStats(supabase, compPeriod, storeId)

  const decliningProducts: any[] = []

  // Comparer
  for (const [productName, previous] of Object.entries(previousStats) as any) {
    if (previous.quantity < minPrevQty) continue

    const current = currentStats[productName] || { quantity: 0, revenue: 0 }

    const qtyVariation = ((current.quantity - previous.quantity) / previous.quantity) * 100
    const revVariation = ((current.revenue - previous.revenue) / previous.revenue) * 100

    // Ne garder que les produits en baisse significative
    if (qtyVariation < -threshold) {
      decliningProducts.push({
        product_name: productName,
        product_id: previous.product_id,
        brand: previous.brand || 'Inconnu',
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
          revenue_percent: parseFloat(revVariation.toFixed(2)),
          quantity_absolute: current.quantity - previous.quantity,
          revenue_absolute: parseFloat((current.revenue - previous.revenue).toFixed(2))
        },
        severity: qtyVariation < -50 ? 'critical' : 'warning',
        recommendation: qtyVariation < -50
          ? 'Action urgente: vérifier stock, placement, promotion'
          : 'Surveillance recommandée'
      })
    }
  }

  // Trier par baisse la plus forte
  decliningProducts.sort((a, b) => a.variation.quantity_percent - b.variation.quantity_percent)
  const topDeclining = decliningProducts.slice(0, limit)

  return {
    success: true,
    action: 'products_declining' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: storeId || null,
      threshold_percent: threshold,
      min_previous_quantity: minPrevQty
    },
    data: {
      summary: {
        total_declining: decliningProducts.length,
        critical_count: decliningProducts.filter(p => p.severity === 'critical').length,
        warning_count: decliningProducts.filter(p => p.severity === 'warning').length
      },
      compared_with: {
        start_date: compPeriod.startDate,
        end_date: compPeriod.endDate
      },
      products: topDeclining
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

/**
 * Handler pour product_rotation
 * Taux de rotation par produit (ventes/stock)
 * CORRECTION v2.1: Utilise la table stock au lieu de products.total_stock
 *
 * Paramètres:
 * - store_id: filtrer par magasin
 * - limit: nombre de produits (défaut: 30)
 * - sort_by: 'high' | 'low' - haute ou basse rotation (défaut: 'low')
 * - min_stock: stock minimum pour être inclus (défaut: 1)
 */
export async function handleProductRotation(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const storeId = params.store_id
  const limit = params.limit || 30
  const sortBy = (params as any).sort_by || 'low'
  const minStock = (params as any).min_stock || 1

  // CORRECTION v2.1: Récupérer le stock depuis la table 'stock'
  let stockQuery = supabase
    .from('stock')
    .select('product_id, store_id, available_stock')
    .gt('available_stock', 0)

  if (storeId) {
    stockQuery = stockQuery.eq('store_id', storeId)
  }

  const { data: stockData } = await stockQuery

  // Agréger le stock par produit (somme des stocks de tous les magasins si pas de filtre store)
  const stockByProduct: Record<number, number> = {}
  stockData?.forEach((s: any) => {
    stockByProduct[s.product_id] = (stockByProduct[s.product_id] || 0) + (s.available_stock || 0)
  })

  // Filtrer par stock minimum
  const productIdsWithStock = Object.entries(stockByProduct)
    .filter(([_, stock]) => stock >= minStock)
    .map(([id, _]) => parseInt(id))

  if (productIdsWithStock.length === 0) {
    return {
      success: true,
      action: 'product_rotation' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { products: [], message: 'Aucun produit avec stock suffisant trouvé' },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Récupérer les infos produits
  const { data: products } = await supabase
    .from('products')
    .select('id, product_name, product_brand')
    .in('id', productIdsWithStock)

  const productMap: any = {}
  products?.forEach((p: any) => {
    productMap[p.id] = {
      product_name: p.product_name,
      brand: p.product_brand,
      stock: stockByProduct[p.id] || 0
    }
  })

  // Récupérer les ventes
  const salesStats = await getProductSalesStats(supabase, period, storeId)

  // Calculer la rotation
  const rotationData: any[] = []

  for (const [productId, info] of Object.entries(productMap) as any) {
    const salesForProduct = Object.entries(salesStats).find(([name, data]: any) =>
      data.product_id === parseInt(productId)
    )

    const soldQty = salesForProduct ? (salesForProduct[1] as any).quantity : 0
    const stock = info.stock

    // Taux de rotation = quantité vendue / stock
    // Jours de stock restant = stock / (ventes / jours)
    const dailySales = soldQty / period.days
    const daysOfStock = dailySales > 0 ? stock / dailySales : 999
    const rotationRate = stock > 0 ? soldQty / stock : 0

    rotationData.push({
      product_id: parseInt(productId),
      product_name: info.product_name,
      brand: info.brand,
      current_stock: stock,
      quantity_sold: soldQty,
      daily_sales_avg: parseFloat(dailySales.toFixed(2)),
      days_of_stock: Math.round(daysOfStock),
      rotation_rate: parseFloat(rotationRate.toFixed(3)),
      status: daysOfStock < 7 ? 'critical_low'
        : daysOfStock < 14 ? 'low'
        : daysOfStock < 30 ? 'normal'
        : daysOfStock < 60 ? 'slow'
        : 'very_slow'
    })
  }

  // Trier
  if (sortBy === 'low') {
    // Faible rotation = beaucoup de jours de stock
    rotationData.sort((a, b) => b.days_of_stock - a.days_of_stock)
  } else {
    // Haute rotation = peu de jours de stock
    rotationData.sort((a, b) => a.days_of_stock - b.days_of_stock)
  }

  const topProducts = rotationData.slice(0, limit).map((p, i) => ({ rank: i + 1, ...p }))

  // Stats résumé
  const statusCounts = {
    critical_low: rotationData.filter(p => p.status === 'critical_low').length,
    low: rotationData.filter(p => p.status === 'low').length,
    normal: rotationData.filter(p => p.status === 'normal').length,
    slow: rotationData.filter(p => p.status === 'slow').length,
    very_slow: rotationData.filter(p => p.status === 'very_slow').length
  }

  return {
    success: true,
    action: 'product_rotation' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: storeId || null,
      sort_by: sortBy,
      min_stock: minStock
    },
    data: {
      summary: {
        products_analyzed: rotationData.length,
        status_distribution: statusCounts,
        avg_rotation_rate: parseFloat(
          (rotationData.reduce((sum, p) => sum + p.rotation_rate, 0) / rotationData.length).toFixed(3)
        )
      },
      products: topProducts,
      interpretation: {
        critical_low: '< 7 jours de stock - Réapprovisionner immédiatement',
        low: '7-14 jours - Commander bientôt',
        normal: '14-30 jours - Stock sain',
        slow: '30-60 jours - Rotation lente',
        very_slow: '> 60 jours - Envisager promotion ou déstockage'
      }
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}

// ============================================
// HELPER
// ============================================

async function getProductSalesStats(supabase: any, period: any, storeId?: number) {
  // Récupérer directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select('product_id, product_name, quantity, total_line, canonical_category_id')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))
  if (allItems.length === 0) return {}

  const filteredItems = allItems.filter(item => !VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id))

  const stats: any = {}
  filteredItems.forEach((item: any) => {
    const name = item.product_name
    if (!stats[name]) {
      stats[name] = {
        product_id: item.product_id,
        quantity: 0,
        revenue: 0
      }
    }
    stats[name].quantity += item.quantity
    stats[name].revenue += parseFloat(item.total_line || '0')
  })

  return stats
}

/**
 * Handler pour vendors_high_margin
 * Vendeurs performants sur produits à forte marge
 * CORRECTION v2.1: Utilise supply_price de sale_items au lieu de products
 */
export async function handleVendorsHighMargin(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, startTime } = context

  const storeId = params.store_id
  const limit = params.limit || 15
  const minMarginPercent = (params as any).min_margin_percent || 30

  // CORRECTION v2.1: Récupérer les items avec supply_price DIRECTEMENT depuis sale_items
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, vendor_name, product_id, product_name, quantity, unit_price, total_line, supply_price')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)
    .gt('supply_price', 0)  // Filtrer les items avec supply_price valide

  if (storeId) itemsQuery = itemsQuery.eq('store_id', storeId)

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'vendors_high_margin' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { vendors: [], message: `Aucun item avec supply_price sur la période` },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Filtrer les items à haute marge (calcul sur chaque item)
  const highMarginItems = allItems.filter((item: any) => {
    const supplyPrice = parseFloat(item.supply_price || '0')
    const unitPrice = parseFloat(item.unit_price || '0')
    if (unitPrice <= 0 || supplyPrice <= 0) return false
    const marginPercent = ((unitPrice - supplyPrice) / unitPrice) * 100
    return marginPercent >= minMarginPercent
  })

  if (highMarginItems.length === 0) {
    return {
      success: true,
      action: 'vendors_high_margin' as any,
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { vendors: [], message: `Aucun produit avec marge >= ${minMarginPercent}%` },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // Agréger par vendeur
  const vendorStats: any = {}
  const highMarginProductNames = new Set<string>()

  highMarginItems.forEach((item: any) => {
    const vendorId = item.vendor_id
    if (!vendorId) return

    const vendorName = item.vendor_name || `Vendeur ${vendorId}`
    const supplyPrice = parseFloat(item.supply_price || '0')
    const unitPrice = parseFloat(item.unit_price || '0')
    const marginPerUnit = unitPrice - supplyPrice
    const itemMargin = marginPerUnit * item.quantity

    highMarginProductNames.add(item.product_name)

    if (!vendorStats[vendorId]) {
      vendorStats[vendorId] = {
        vendor_id: vendorId,
        vendor_name: vendorName,
        high_margin_quantity: 0,
        high_margin_revenue: 0,
        total_margin_generated: 0,
        products_sold: new Set()
      }
    }

    vendorStats[vendorId].high_margin_quantity += item.quantity
    vendorStats[vendorId].high_margin_revenue += parseFloat(item.total_line || '0')
    vendorStats[vendorId].total_margin_generated += itemMargin
    vendorStats[vendorId].products_sold.add(item.product_name)
  })

  const rankings = Object.values(vendorStats)
    .map((v: any) => ({
      vendor_id: v.vendor_id,
      vendor_name: v.vendor_name,
      high_margin_quantity: v.high_margin_quantity,
      high_margin_revenue: parseFloat(v.high_margin_revenue.toFixed(2)),
      margin_generated: parseFloat(v.total_margin_generated.toFixed(2)),
      unique_products: v.products_sold.size,
      top_products: [...v.products_sold].slice(0, 5)
    }))
    .sort((a: any, b: any) => b.margin_generated - a.margin_generated)
    .slice(0, limit)
    .map((v: any, i: number) => ({ rank: i + 1, ...v }))

  return {
    success: true,
    action: 'vendors_high_margin' as any,
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: storeId || null,
      min_margin_percent: minMarginPercent
    },
    data: {
      summary: {
        high_margin_products_count: highMarginProductNames.size,
        high_margin_items_count: highMarginItems.length,
        vendors_with_sales: rankings.length,
        total_margin_generated: parseFloat(
          rankings.reduce((sum, v) => sum + v.margin_generated, 0).toFixed(2)
        ),
        min_margin_threshold: minMarginPercent
      },
      vendors: rankings
    },
    metadata: {
      generated_at: new Date().toISOString(),
      execution_time_ms: Date.now() - startTime
    }
  }
}
