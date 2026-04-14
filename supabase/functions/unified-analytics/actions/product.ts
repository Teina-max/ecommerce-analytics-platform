/**
 * Action: product_performance
 * Performance des produits
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import { loadVendors, getVendorFullName } from '../../_shared/vendors.ts'
import { filterVirtualItems, filterItemsByCategory } from '../../_shared/categories.ts'
import { TVA_RATE } from '../../_shared/constants.ts'
import { loadQuantityRules, normalizeQuantity, type QuantityRule } from '../../_shared/quantity-rules.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '2.2-pagination-fix'

export async function handleProductPerformance(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context

  const mode = params.mode || 'top_sellers'

  // 1. Récupérer les items directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, sale_date, vendor_id, vendor_name, store_id, store_name,
      product_id, product_name, quantity, total_line, unit_price,
      category_id, category_name, parent_category_id, parent_category_name,
      grandparent_category_id, grandparent_category_name,
      brand_id, brand_name,
      canonical_category_id, canonical_parent_category_id
    `)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'product_performance',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: {
        message: 'Aucune vente trouvée pour cette période',
        summary: { total_products: 0, total_revenue: 0 },
        products: []
      },
      metadata: { generated_at: new Date().toISOString(), rows_fetched: 0 }
    }
  }

  // 2.5 Load quantity normalization rules (bulk product ÷40, etc.)
  const quantityRules = await loadQuantityRules(supabase)

  // 3. Filtrer les produits virtuels
  let filteredItems = filterVirtualItems(allItems)

  // 4. Appliquer les filtres de recherche
  if (params.product_query) {
    const terms = params.product_query.toLowerCase().split(',').map(t => t.trim())
    filteredItems = filteredItems.filter(item => {
      const productName = (item.product_name || '').toLowerCase()
      return terms.some(term => productName.includes(term))
    })
  }

  if (params.brand_name) {
    const brandLower = params.brand_name.toLowerCase()
    filteredItems = filteredItems.filter(item => {
      const brandName = (item.brand_name || '').toLowerCase()
      return brandName.includes(brandLower)
    })
  }

  if (params.category_name) {
    // Recherche sur 3 niveaux: enfant, parent, grandparent
    filteredItems = filterItemsByCategory(filteredItems, params.category_name)
  }

  if (params.product_ids && params.product_ids.length > 0) {
    filteredItems = filteredItems.filter(item =>
      params.product_ids!.includes(item.product_id)
    )
  }

  // 5. Agréger par produit (utilise les données dénormalisées)
  const productStats: Record<number, any> = {}

  filteredItems.forEach(item => {
    const productId = item.product_id
    // Apply quantity normalization rules (e.g., bulk 1ml ÷40)
    const rawQty = item.quantity || 0
    const qty = normalizeQuantity(rawQty, item.product_name || '', item.category_name, item.parent_category_name, quantityRules)
    const revenue = parseFloat(item.total_line || '0')
    const saleId = item.hiboutik_sale_id

    if (!productStats[productId]) {
      productStats[productId] = {
        product_id: productId,
        product_name: item.product_name,
        brand_name: item.brand_name,
        category_name: item.category_name,
        parent_category_name: item.parent_category_name,
        unit_price: parseFloat(item.unit_price || '0'),
        total_quantity: 0,
        total_revenue: 0,
        transaction_count: 0,
        vendors: new Map(),
        sale_ids: new Set()
      }
    }

    productStats[productId].total_quantity += qty
    productStats[productId].total_revenue += revenue

    if (saleId && !productStats[productId].sale_ids.has(saleId)) {
      productStats[productId].sale_ids.add(saleId)
      productStats[productId].transaction_count += 1
    }

    // Tracker les vendeurs (données dénormalisées dans sale_items)
    if (item.vendor_id && item.vendor_name) {
      const vendorName = item.vendor_name
      const currentQty = productStats[productId].vendors.get(vendorName) || 0
      productStats[productId].vendors.set(vendorName, currentQty + qty)
    }
  })

  // 6. Calculer les totaux et créer la liste
  const totalRevenue = Object.values(productStats).reduce((sum: number, p: any) =>
    sum + p.total_revenue, 0)
  const totalQuantity = Object.values(productStats).reduce((sum: number, p: any) =>
    sum + p.total_quantity, 0)

  let products = Object.values(productStats)
    .map((p: any) => {
      // Top 3 vendeurs pour ce produit
      const topVendors = Array.from(p.vendors.entries())
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, qty]: any) => ({ vendor_name: name, quantity: qty }))

      return {
        product_id: p.product_id,
        product_name: p.product_name,
        brand_name: p.brand_name,
        category_name: p.category_name,
        parent_category_name: p.parent_category_name,
        unit_price: p.unit_price,
        total_quantity: p.total_quantity,
        total_revenue: parseFloat(p.total_revenue.toFixed(2)),
        transaction_count: p.transaction_count,
        avg_qty_per_transaction: p.transaction_count > 0
          ? parseFloat((p.total_quantity / p.transaction_count).toFixed(2))
          : 0,
        percent_of_total_revenue: totalRevenue > 0
          ? parseFloat((p.total_revenue / totalRevenue * 100).toFixed(2))
          : 0,
        top_vendors: mode === 'detailed' ? topVendors : undefined
      }
    })

  // Trier selon le mode
  switch (mode) {
    case 'top_sellers':
      products.sort((a: any, b: any) => b.total_quantity - a.total_quantity)
      break
    case 'top_revenue':
      products.sort((a: any, b: any) => b.total_revenue - a.total_revenue)
      break
    default:
      products.sort((a: any, b: any) => b.total_revenue - a.total_revenue)
  }

  // Limiter et ajouter le rang
  products = products
    .slice(0, params.limit || 20)
    .map((p: any, index: number) => ({ ...p, rank: index + 1 }))

  // 7. Summary par catégorie (si mode summary)
  let categoryBreakdown: any[] = []
  if (mode === 'summary') {
    const catStats: Record<string, any> = {}

    filteredItems.forEach(item => {
      const catName = item.category_name || 'Sans catégorie'
      if (!catStats[catName]) {
        catStats[catName] = {
          category_name: catName,
          parent_category_name: item.parent_category_name,
          quantity: 0,
          revenue: 0,
          products_count: new Set()
        }
      }
      // Apply quantity normalization rules
      const normalizedQty = normalizeQuantity(item.quantity || 0, item.product_name || '', item.category_name, item.parent_category_name, quantityRules)
      catStats[catName].quantity += normalizedQty
      catStats[catName].revenue += parseFloat(item.total_line || '0')
      catStats[catName].products_count.add(item.product_name)
    })

    categoryBreakdown = Object.values(catStats)
      .map((c: any) => ({
        category_name: c.category_name,
        parent_category_name: c.parent_category_name,
        quantity: c.quantity,
        revenue: parseFloat(c.revenue.toFixed(2)),
        products_count: c.products_count.size,
        percent_of_total: totalRevenue > 0
          ? parseFloat((c.revenue / totalRevenue * 100).toFixed(2))
          : 0
      }))
      .sort((a: any, b: any) => b.revenue - a.revenue)
      .slice(0, 10)
  }

  return {
    success: true,
    action: 'product_performance',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      product_query: params.product_query,
      brand_name: params.brand_name,
      category_name: params.category_name,
      product_ids: params.product_ids,
      store_id: params.store_id || null,
      mode
    },
    data: {
      summary: {
        total_products: Object.keys(productStats).length,
        total_quantity: totalQuantity,
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        total_revenue_ht: parseFloat((totalRevenue / (1 + TVA_RATE)).toFixed(2)),
        avg_price: products.length > 0
          ? parseFloat((totalRevenue / totalQuantity).toFixed(2))
          : 0
      },
      products,
      category_breakdown: mode === 'summary' ? categoryBreakdown : undefined
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      items_after_filter: filteredItems.length
    }
  }
}
