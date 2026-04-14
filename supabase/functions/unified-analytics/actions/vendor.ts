/**
 * Actions: vendor_details, vendor_ranking
 * Gestion des analytics vendeurs - Version DENORMALISEE (sale_items uniquement)
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import { loadVendors, findVendorByName, getVendorFullName } from '../../_shared/vendors.ts'
import { TVA_RATE } from '../../_shared/constants.ts'
import { calculateHT, type DisplayMode } from '../../_shared/pricing.ts'
import { filterItemsByCategory } from '../../_shared/categories.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '3.5-total-items'

/**
 * Helper pour formater les montants selon le display mode
 */
function formatRevenue(ttc: number, display: DisplayMode = 'ttc'): Record<string, number> {
  const ht = calculateHT(ttc, TVA_RATE)
  switch (display) {
    case 'ht':
      return { total_revenue: parseFloat(ht.toFixed(2)) }
    case 'both':
      return {
        total_revenue_ttc: parseFloat(ttc.toFixed(2)),
        total_revenue_ht: parseFloat(ht.toFixed(2))
      }
    case 'ttc':
    default:
      return { total_revenue: parseFloat(ttc.toFixed(2)) }
  }
}

/**
 * Détails d'un vendeur spécifique - VERSION DENORMALISEE
 * Utilise uniquement sale_items (plus de JOIN avec sales)
 */
export async function handleVendorDetails(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // 1. Trouver le vendeur (utilise canonical_vendor_id pour dédupliquer)
  let vendor = null
  let canonicalVendorId: number | null = null

  if (params.vendor_id) {
    // Chercher le vendeur et obtenir son canonical_vendor_id
    const { data } = await supabase
      .from('vendors')
      .select('id, canonical_vendor_id, first_name, last_name, user_name, email, store_id, is_active')
      .eq('id', params.vendor_id)
      .single()
    vendor = data
    canonicalVendorId = vendor?.canonical_vendor_id || vendor?.id
  } else if (params.vendor_name) {
    const result = await findVendorByName(supabase, params.vendor_name)
    if (result.error && result.suggestions) {
      // Dédupliquer les suggestions par canonical_vendor_id
      const uniqueSuggestions = new Map()
      result.suggestions.forEach(v => {
        const canonId = v.canonical_vendor_id || v.id
        if (!uniqueSuggestions.has(canonId)) {
          uniqueSuggestions.set(canonId, v)
        }
      })
      return {
        success: false,
        action: 'vendor_details',
        version: VERSION,
        period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
        data: {
          error: result.error,
          suggestions: Array.from(uniqueSuggestions.values()).map(v => ({
            id: v.canonical_vendor_id || v.id,
            name: getVendorFullName(v),
            user_name: v.user_name
          }))
        },
        metadata: { generated_at: new Date().toISOString() }
      }
    }
    vendor = result.vendor
    canonicalVendorId = vendor?.canonical_vendor_id || vendor?.id
  }

  if (!vendor || !canonicalVendorId) {
    return {
      success: false,
      action: 'vendor_details',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: { error: `Vendeur non trouvé (ID: ${params.vendor_id}, Nom: ${params.vendor_name})` },
      metadata: { generated_at: new Date().toISOString() }
    }
  }

  // 2. Récupérer les ventes DEPUIS SALE_ITEMS (utilise canonical_vendor_id)
  // IMPORTANT: .order('id') est OBLIGATOIRE pour pagination stable avec fetchAllRows()
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, sale_date, payment_method, store_id, store_name, total_line, quantity, product_name, hiboutik_product_id, category_name, parent_category_name, grandparent_category_name, brand_name, canonical_vendor_name, hiboutik_customer_id, customer_name')
    .eq('canonical_vendor_id', canonicalVendorId)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)
    .order('id')

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  // Filtre par produit (ID unique)
  if (params.product_id) {
    itemsQuery = itemsQuery.eq('hiboutik_product_id', params.product_id)
  }

  let currentItems = await fetchAllRows(itemsQuery)

  // IMPORTANT: Garder une copie AVANT le filtre produit pour calcul % catégorie
  const allVendorItems = [...currentItems]

  // Filtre multi-produits (OR) - supporte virgule ou "et" comme séparateur
  // Exemple: "Mimosa, Blueberry cheese, résine jaune" ou "Mimosa et Blueberry"
  const productQuery = params.product_name || params.product_query
  let productTerms: string[] = []
  if (productQuery) {
    // Normaliser les séparateurs: virgule, " et ", " ou ", " and ", " or "
    productTerms = productQuery
      .split(/[,]|\s+et\s+|\s+ou\s+|\s+and\s+|\s+or\s+/i)
      .map((t: string) => t.trim().toLowerCase())
      .filter((t: string) => t.length > 0)

    if (productTerms.length > 0) {
      currentItems = currentItems.filter(item => {
        const productName = (item.product_name || '').toLowerCase()
        // OR logic: match si au moins un terme correspond
        return productTerms.some((term: string) => productName.includes(term))
      })
      console.log(`[vendor_details] Product filter (OR): ${productTerms.join(' | ')} → ${currentItems.length} items`)
    }
  }

  // Nouveau: Filtre par catégorie (recherche sur 3 niveaux: enfant, parent, grandparent)
  const categorySearchTerm = params.category_name || params.canonical_category_name
  if (categorySearchTerm) {
    currentItems = filterItemsByCategory(currentItems, categorySearchTerm)
  }

  // 3. Agréger par vente unique (hiboutik_sale_id)
  const salesMap = new Map<number, {
    hiboutik_sale_id: number,
    sale_date: string,
    payment_method: string,
    store_id: number,
    store_name: string,
    total: number
  }>()

  currentItems.forEach(item => {
    const saleId = item.hiboutik_sale_id
    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, {
        hiboutik_sale_id: saleId,
        sale_date: item.sale_date,
        payment_method: item.payment_method,
        store_id: item.store_id,
        store_name: item.store_name,
        total: 0
      })
    }
    salesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const currentSales = Array.from(salesMap.values())

  // 4. Ventes période précédente
  let previousRevenue = 0
  let previousTransactions = 0

  if (previousPeriod) {
    let prevQuery = supabase
      .from('sale_items')
      .select('hiboutik_sale_id, total_line, category_name, parent_category_name, grandparent_category_name')
      .eq('canonical_vendor_id', canonicalVendorId)
      .gte('sale_date', previousPeriod.startDateTime)
      .lte('sale_date', previousPeriod.endDateTime)
      .order('id')

    if (params.store_id) {
      prevQuery = prevQuery.eq('store_id', params.store_id)
    }

    let prevItems = await fetchAllRows(prevQuery)

    // Appliquer le même filtre de catégorie
    if (categorySearchTerm) {
      prevItems = filterItemsByCategory(prevItems, categorySearchTerm)
    }

    const prevSalesSet = new Set<number>()
    prevItems.forEach(item => {
      prevSalesSet.add(item.hiboutik_sale_id)
      previousRevenue += parseFloat(item.total_line || '0')
    })
    previousTransactions = prevSalesSet.size
  }

  // 5. Calculs de base
  const display = (params.display as DisplayMode) || 'ttc'
  const totalRevenueTTC = currentSales.reduce((sum, s) => sum + s.total, 0)
  const totalRevenueHT = calculateHT(totalRevenueTTC, TVA_RATE)
  const totalTransactions = currentSales.length
  const avgBasketTTC = totalTransactions > 0 ? totalRevenueTTC / totalTransactions : 0
  const avgBasketHT = totalTransactions > 0 ? totalRevenueHT / totalTransactions : 0

  const revenueEvolution = previousRevenue > 0
    ? ((totalRevenueTTC - previousRevenue) / previousRevenue * 100)
    : (totalRevenueTTC > 0 ? 100 : 0)

  // 6. Payment breakdown
  let paymentBreakdown: any[] = []
  if (params.include_payment_breakdown) {
    const paymentMethods: Record<string, number> = {}
    currentSales.forEach(sale => {
      const method = sale.payment_method || 'Inconnu'
      paymentMethods[method] = (paymentMethods[method] || 0) + 1
    })

    paymentBreakdown = Object.entries(paymentMethods)
      .map(([method, count]) => ({
        method,
        count,
        percentage: parseFloat((count / totalTransactions * 100).toFixed(2))
      }))
      .sort((a, b) => b.count - a.count)
  }

  // 7. Daily breakdown
  let dailyData: any[] = []
  if (params.include_daily && currentSales.length > 0) {
    const dailyStats: Record<string, { date: string; sales_count: number; total_revenue: number }> = {}
    currentSales.forEach(sale => {
      const date = sale.sale_date?.split('T')[0]
      if (!date) return
      if (!dailyStats[date]) {
        dailyStats[date] = { date, sales_count: 0, total_revenue: 0 }
      }
      dailyStats[date].sales_count += 1
      dailyStats[date].total_revenue += sale.total
    })

    dailyData = Object.values(dailyStats)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(day => ({
        date: day.date,
        sales_count: day.sales_count,
        total_revenue: parseFloat(day.total_revenue.toFixed(2)),
        avg_basket: parseFloat((day.total_revenue / day.sales_count).toFixed(2))
      }))
  }

  // 8. Top produits (déjà dans sale_items!)
  let topProducts: any[] = []
  const productStats: Record<string, any> = {}
  currentItems.forEach(item => {
    const name = item.product_name
    if (!productStats[name]) {
      productStats[name] = {
        product_name: name,
        category_name: item.category_name,
        parent_category_name: item.parent_category_name,
        grandparent_category_name: item.grandparent_category_name,
        brand_name: item.brand_name,
        quantity: 0,
        revenue: 0
      }
    }
    productStats[name].quantity += item.quantity
    productStats[name].revenue += parseFloat(item.total_line || '0')
  })

  // 8.0 Calcul % catégorie si demandé ou si recherche produit spécifique
  const shouldCalcCategoryPercent = params.include_category_percent || productTerms.length > 0

  // Calculer les totaux par catégorie (enfant) et parent à partir de TOUS les items du vendeur
  const categoryTotals: Record<string, number> = {}       // category_name -> total qty
  const parentCategoryTotals: Record<string, number> = {} // parent_category_name -> total qty

  if (shouldCalcCategoryPercent) {
    allVendorItems.forEach(item => {
      const catName = item.category_name || 'Non catégorisé'
      const parentName = item.parent_category_name || catName
      const qty = item.quantity || 0

      categoryTotals[catName] = (categoryTotals[catName] || 0) + qty
      parentCategoryTotals[parentName] = (parentCategoryTotals[parentName] || 0) + qty
    })
  }

  topProducts = Object.values(productStats)
    .map((p: any) => {
      const result: any = {
        ...p,
        revenue: parseFloat(p.revenue.toFixed(2))
      }

      // Ajouter % catégorie si demandé
      if (shouldCalcCategoryPercent) {
        const catTotal = categoryTotals[p.category_name] || 0
        const parentTotal = parentCategoryTotals[p.parent_category_name] || 0

        result.category_percent = {
          // % dans la catégorie enfant (ex: "Batterie Intégrée")
          in_category: {
            category_name: p.category_name,
            total_qty: catTotal,
            product_qty: p.quantity,
            percent: catTotal > 0 ? parseFloat((p.quantity / catTotal * 100).toFixed(1)) : 0
          },
          // % dans la catégorie parent (ex: "Kits")
          in_parent_category: {
            category_name: p.parent_category_name,
            total_qty: parentTotal,
            product_qty: p.quantity,
            percent: parentTotal > 0 ? parseFloat((p.quantity / parentTotal * 100).toFixed(1)) : 0
          }
        }
      }

      return result
    })
    .sort((a: any, b: any) => b.revenue - a.revenue)
    .slice(0, params.limit || 10)

  // 8.1 ANALYTICS 360: Category breakdown
  // IMPORTANT: Utiliser allVendorItems pour avoir les stats COMPLÈTES du vendeur (pas filtrées par produit)
  const categoryStats: Record<string, { name: string; parent: string; grandparent: string; revenue: number; quantity: number; brands: Record<string, number>; products: Record<string, { qty: number; revenue: number }> }> = {}
  const parentCategoryStats: Record<string, { name: string; grandparent: string; revenue: number; quantity: number; subcategories: Record<string, { qty: number; revenue: number }> }> = {}
  const grandparentCategoryStats: Record<string, { name: string; revenue: number; quantity: number; subcategories: string[] }> = {}
  const brandStats: Record<string, { name: string; revenue: number; quantity: number; categories: Set<string> }> = {}

  // Totaux globaux du vendeur (avant filtre produit)
  let vendorTotalQty = 0
  let vendorTotalRevenue = 0

  allVendorItems.forEach(item => {
    const catName = item.category_name || 'Non catégorisé'
    const parentName = item.parent_category_name || 'Non catégorisé'
    const grandparentName = item.grandparent_category_name || parentName
    const brandName = item.brand_name || 'Sans marque'
    const productName = item.product_name || 'Inconnu'
    const revenue = parseFloat(item.total_line || '0')
    const qty = item.quantity || 0

    vendorTotalQty += qty
    vendorTotalRevenue += revenue

    // Category stats (enfant)
    if (!categoryStats[catName]) {
      categoryStats[catName] = { name: catName, parent: parentName, grandparent: grandparentName, revenue: 0, quantity: 0, brands: {}, products: {} }
    }
    categoryStats[catName].revenue += revenue
    categoryStats[catName].quantity += qty
    categoryStats[catName].brands[brandName] = (categoryStats[catName].brands[brandName] || 0) + revenue

    // Track products within category
    if (!categoryStats[catName].products[productName]) {
      categoryStats[catName].products[productName] = { qty: 0, revenue: 0 }
    }
    categoryStats[catName].products[productName].qty += qty
    categoryStats[catName].products[productName].revenue += revenue

    // Parent category stats
    if (!parentCategoryStats[parentName]) {
      parentCategoryStats[parentName] = { name: parentName, grandparent: grandparentName, revenue: 0, quantity: 0, subcategories: {} }
    }
    parentCategoryStats[parentName].revenue += revenue
    parentCategoryStats[parentName].quantity += qty

    // Track subcategories within parent
    if (!parentCategoryStats[parentName].subcategories[catName]) {
      parentCategoryStats[parentName].subcategories[catName] = { qty: 0, revenue: 0 }
    }
    parentCategoryStats[parentName].subcategories[catName].qty += qty
    parentCategoryStats[parentName].subcategories[catName].revenue += revenue

    // Grandparent category stats
    if (!grandparentCategoryStats[grandparentName]) {
      grandparentCategoryStats[grandparentName] = { name: grandparentName, revenue: 0, quantity: 0, subcategories: [] }
    }
    grandparentCategoryStats[grandparentName].revenue += revenue
    grandparentCategoryStats[grandparentName].quantity += qty
    if (!grandparentCategoryStats[grandparentName].subcategories.includes(parentName)) {
      grandparentCategoryStats[grandparentName].subcategories.push(parentName)
    }

    // Brand stats
    if (!brandStats[brandName]) {
      brandStats[brandName] = { name: brandName, revenue: 0, quantity: 0, categories: new Set() }
    }
    brandStats[brandName].revenue += revenue
    brandStats[brandName].quantity += qty
    brandStats[brandName].categories.add(parentName)
  })

  // Format category breakdown with brand shares and product breakdown
  const categoryBreakdown = Object.values(categoryStats)
    .map(cat => {
      const topBrands = Object.entries(cat.brands)
        .map(([name, rev]) => ({ brand_name: name, revenue: parseFloat((rev as number).toFixed(2)), pct_in_category: parseFloat(((rev as number) / cat.revenue * 100).toFixed(1)) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)

      // Top products dans cette catégorie
      const topProductsInCat = Object.entries(cat.products)
        .map(([name, stats]) => ({
          product_name: name,
          quantity: stats.qty,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          pct_of_category_qty: parseFloat((stats.qty / cat.quantity * 100).toFixed(1)),
          pct_of_category_revenue: parseFloat((stats.revenue / cat.revenue * 100).toFixed(1))
        }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5)

      return {
        category_name: cat.name,
        parent_category_name: cat.parent,
        revenue: parseFloat(cat.revenue.toFixed(2)),
        quantity: cat.quantity,
        // % par rapport au TOTAL du vendeur
        pct_of_vendor_revenue: vendorTotalRevenue > 0 ? parseFloat((cat.revenue / vendorTotalRevenue * 100).toFixed(1)) : 0,
        pct_of_vendor_qty: vendorTotalQty > 0 ? parseFloat((cat.quantity / vendorTotalQty * 100).toFixed(1)) : 0,
        top_brands: topBrands,
        top_products: topProductsInCat
      }
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  // Format parent category breakdown with subcategory details
  const parentCategoryBreakdown = Object.values(parentCategoryStats)
    .map(cat => {
      // Détail des sous-catégories avec leurs %
      const subcategoryDetails = Object.entries(cat.subcategories)
        .map(([name, stats]) => ({
          category_name: name,
          quantity: stats.qty,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          pct_of_parent_qty: parseFloat((stats.qty / cat.quantity * 100).toFixed(1)),
          pct_of_parent_revenue: parseFloat((stats.revenue / cat.revenue * 100).toFixed(1))
        }))
        .sort((a, b) => b.quantity - a.quantity)

      return {
        category_name: cat.name,
        grandparent_category_name: cat.grandparent,
        revenue: parseFloat(cat.revenue.toFixed(2)),
        quantity: cat.quantity,
        // % par rapport au TOTAL du vendeur
        pct_of_vendor_revenue: vendorTotalRevenue > 0 ? parseFloat((cat.revenue / vendorTotalRevenue * 100).toFixed(1)) : 0,
        pct_of_vendor_qty: vendorTotalQty > 0 ? parseFloat((cat.quantity / vendorTotalQty * 100).toFixed(1)) : 0,
        subcategories: subcategoryDetails
      }
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  // Format grandparent category breakdown
  const grandparentCategoryBreakdown = Object.values(grandparentCategoryStats)
    .map(cat => ({
      category_name: cat.name,
      revenue: parseFloat(cat.revenue.toFixed(2)),
      quantity: cat.quantity,
      pct_of_total: parseFloat((cat.revenue / totalRevenueTTC * 100).toFixed(1)),
      subcategories_count: cat.subcategories.length
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  // Format brand breakdown
  const brandBreakdown = Object.values(brandStats)
    .map(brand => ({
      brand_name: brand.name,
      revenue: parseFloat(brand.revenue.toFixed(2)),
      quantity: brand.quantity,
      pct_of_total: parseFloat((brand.revenue / totalRevenueTTC * 100).toFixed(1)),
      categories: Array.from(brand.categories)
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  // 8.2 Store breakdown (si multi-store)
  const storeStats: Record<number, { id: number; name: string; revenue: number; transactions: number }> = {}
  currentSales.forEach(sale => {
    if (!sale.store_id) return
    if (!storeStats[sale.store_id]) {
      storeStats[sale.store_id] = { id: sale.store_id, name: sale.store_name, revenue: 0, transactions: 0 }
    }
    storeStats[sale.store_id].revenue += sale.total
    storeStats[sale.store_id].transactions += 1
  })

  const storeBreakdown = Object.values(storeStats)
    .map(store => ({
      store_id: store.id,
      store_name: store.name,
      revenue: parseFloat(store.revenue.toFixed(2)),
      transactions: store.transactions,
      pct_of_total: parseFloat((store.revenue / totalRevenueTTC * 100).toFixed(1)),
      avg_basket: parseFloat((store.revenue / store.transactions).toFixed(2))
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // 8.3 Customer metrics
  const customerStats: Record<number, { id: number; name: string; revenue: number; transactions: number }> = {}
  let newCustomersCount = 0
  currentItems.forEach(item => {
    const custId = (item as any).hiboutik_customer_id
    const custName = (item as any).customer_name
    if (!custId || custId <= 0) return
    if (!customerStats[custId]) {
      customerStats[custId] = { id: custId, name: custName || `Client #${custId}`, revenue: 0, transactions: 0 }
    }
    customerStats[custId].revenue += parseFloat(item.total_line || '0')
  })
  // Count unique transactions per customer
  const custTransactions: Record<number, Set<number>> = {}
  currentItems.forEach(item => {
    const custId = (item as any).hiboutik_customer_id
    const saleId = item.hiboutik_sale_id
    if (!custId || custId <= 0) return
    if (!custTransactions[custId]) custTransactions[custId] = new Set()
    custTransactions[custId].add(saleId)
  })
  Object.entries(custTransactions).forEach(([custId, sales]) => {
    if (customerStats[parseInt(custId)]) {
      customerStats[parseInt(custId)].transactions = sales.size
    }
  })

  const uniqueCustomers = Object.keys(customerStats).length
  const topCustomers = Object.values(customerStats)
    .map(c => ({
      customer_id: c.id,
      customer_name: c.name,
      revenue: parseFloat(c.revenue.toFixed(2)),
      transactions: c.transactions,
      avg_basket: c.transactions > 0 ? parseFloat((c.revenue / c.transactions).toFixed(2)) : 0
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)

  const customerMetrics = {
    unique_customers: uniqueCustomers,
    anonymous_transactions: totalTransactions - Object.values(custTransactions).reduce((sum, s) => sum + s.size, 0),
    top_customers: topCustomers
  }

  // 9. Classement global (depuis sale_items, par canonical_vendor_id)
  let globalRank = null
  let totalVendors = null

  let rankQuery = supabase
    .from('sale_items')
    .select('canonical_vendor_id, total_line')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)
    .order('id')

  if (params.store_id) {
    rankQuery = rankQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(rankQuery)

  const vendorTotals: Record<number, number> = {}
  allItems.forEach(item => {
    if (!item.canonical_vendor_id) return
    vendorTotals[item.canonical_vendor_id] = (vendorTotals[item.canonical_vendor_id] || 0) + parseFloat(item.total_line || '0')
  })

  const sortedVendors = Object.entries(vendorTotals)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .map(([id], index) => ({ vendor_id: parseInt(id), rank: index + 1 }))

  globalRank = sortedVendors.find(v => v.vendor_id === canonicalVendorId)?.rank || null
  totalVendors = sortedVendors.length

  // 10. Infos magasins (depuis sale_items)
  const storesInfo = [...new Set(currentSales.map(s => JSON.stringify({ id: s.store_id, name: s.store_name })))]
    .map(s => JSON.parse(s))
    .filter(s => s.id !== null)

  return {
    success: true,
    action: 'vendor_details',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      vendor_id: canonicalVendorId,
      store_id: params.store_id || null,
      product_id: params.product_id || null,
      product_query: productQuery || null,
      category_name: categorySearchTerm || null
    },
    data: {
      vendor: {
        id: canonicalVendorId,
        full_name: getVendorFullName(vendor),
        user_name: vendor.user_name,
        email: vendor.email,
        stores: storesInfo
      },
      performance: {
        // Montants selon display mode
        ...(display === 'both' ? {
          total_revenue_ttc: parseFloat(totalRevenueTTC.toFixed(2)),
          total_revenue_ht: parseFloat(totalRevenueHT.toFixed(2)),
          avg_basket_ttc: parseFloat(avgBasketTTC.toFixed(2)),
          avg_basket_ht: parseFloat(avgBasketHT.toFixed(2))
        } : display === 'ht' ? {
          total_revenue: parseFloat(totalRevenueHT.toFixed(2)),
          avg_basket: parseFloat(avgBasketHT.toFixed(2))
        } : {
          total_revenue: parseFloat(totalRevenueTTC.toFixed(2)),
          avg_basket: parseFloat(avgBasketTTC.toFixed(2))
        }),
        total_transactions: totalTransactions,
        display_mode: display,
        evolution: {
          revenue_percent: parseFloat(revenueEvolution.toFixed(2)),
          previous_revenue: parseFloat(previousRevenue.toFixed(2)),
          previous_transactions: previousTransactions
        }
      },
      ranking: {
        global_rank: globalRank,
        total_vendors: totalVendors,
        percentile: globalRank && totalVendors
          ? parseFloat(((1 - globalRank / totalVendors) * 100).toFixed(2))
          : null
      },
      // Standard breakdowns
      top_products: topProducts,
      daily_breakdown: params.include_daily ? dailyData : undefined,
      payment_methods: params.include_payment_breakdown ? paymentBreakdown : undefined,
      // Analytics 360
      category_breakdown: params.include_analytics360 !== false ? categoryBreakdown : undefined,
      parent_category_breakdown: params.include_analytics360 !== false ? parentCategoryBreakdown : undefined,
      grandparent_category_breakdown: params.include_analytics360 !== false ? grandparentCategoryBreakdown : undefined,
      brand_breakdown: params.include_analytics360 !== false ? brandBreakdown : undefined,
      store_breakdown: storeBreakdown.length > 1 ? storeBreakdown : undefined,
      customer_metrics: params.include_analytics360 !== false ? customerMetrics : undefined
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: currentItems.length,
      denormalized: true
    }
  }
}

/**
 * Classement de tous les vendeurs - VERSION DENORMALISEE
 * Supporte le filtre par catégorie (category_name)
 */
export async function handleVendorRanking(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // 1. Charger les vendeurs
  const vendorMap = await loadVendors(supabase)

  // 2. Récupérer les items période actuelle DIRECTEMENT depuis sale_items (canonical)
  // Inclure les champs catégorie pour le filtrage
  // IMPORTANT: .order('id') est OBLIGATOIRE pour pagination stable avec fetchAllRows()
  let baseQuery = supabase
    .from('sale_items')
    .select('canonical_vendor_id, canonical_vendor_name, store_id, store_name, hiboutik_sale_id, total_line, quantity, sale_date, payment_method, category_name, parent_category_name, grandparent_category_name')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)
    .order('id')

  if (params.store_id) {
    baseQuery = baseQuery.eq('store_id', params.store_id)
  }

  let currentItems = await fetchAllRows(baseQuery)

  // 2.1 Filtre par catégorie (recherche exacte sur 3 niveaux)
  const categorySearchTerm = params.category_name || params.canonical_category_name
  if (categorySearchTerm) {
    currentItems = filterItemsByCategory(currentItems, categorySearchTerm)
  }

  // 3. Ventes période précédente (par canonical_vendor_id)
  const previousStats: Record<number, number> = {}
  if (previousPeriod) {
    let prevQuery = supabase
      .from('sale_items')
      .select('canonical_vendor_id, total_line, category_name, parent_category_name, grandparent_category_name')
      .gte('sale_date', previousPeriod.startDateTime)
      .lte('sale_date', previousPeriod.endDateTime)
      .order('id')

    if (params.store_id) {
      prevQuery = prevQuery.eq('store_id', params.store_id)
    }

    let previousItems = await fetchAllRows(prevQuery)

    // Appliquer le même filtre de catégorie que pour la période actuelle
    if (categorySearchTerm) {
      previousItems = filterItemsByCategory(previousItems, categorySearchTerm)
    }

    previousItems.forEach(item => {
      if (!item.canonical_vendor_id) return
      previousStats[item.canonical_vendor_id] = (previousStats[item.canonical_vendor_id] || 0) + parseFloat(item.total_line || '0')
    })
  }

  // 4. Agréger par vendeur canonique (utilise canonical_vendor_id)
  const vendorStats: Record<number, any> = {}
  const vendorSales: Record<number, Set<number>> = {} // Pour compter les transactions uniques

  currentItems.forEach(item => {
    // Utiliser canonical_vendor_id comme clé unique
    const canonicalId = item.canonical_vendor_id
    if (!canonicalId) return

    const vendorName = item.canonical_vendor_name || `Vendeur ${canonicalId}`

    if (!vendorStats[canonicalId]) {
      // Chercher les infos du vendeur canonique
      const vendorInfo = vendorMap.get(canonicalId)
      vendorStats[canonicalId] = {
        vendor_id: canonicalId,
        vendor_name: vendorName,
        user_name: vendorInfo?.user_name || null,
        total_revenue: 0,
        total_items: 0, // Nouveau: comptage des articles (somme des quantités)
        stores: new Set(),
        payment_methods: {} as Record<string, number>
      }
      vendorSales[canonicalId] = new Set()
    }

    vendorStats[canonicalId].total_revenue += parseFloat(item.total_line || '0')
    vendorStats[canonicalId].total_items += (item.quantity || 1) // Nouveau: somme des quantités
    if (item.store_id) vendorStats[canonicalId].stores.add(item.store_id)

    // Compter les transactions uniques
    if (item.hiboutik_sale_id) {
      const wasNew = !vendorSales[canonicalId].has(item.hiboutik_sale_id)
      vendorSales[canonicalId].add(item.hiboutik_sale_id)

      // Ne compter le payment_method qu'une fois par transaction
      if (wasNew) {
        const pm = item.payment_method || 'Inconnu'
        vendorStats[canonicalId].payment_methods[pm] = (vendorStats[canonicalId].payment_methods[pm] || 0) + 1
      }
    }
  })

  // Ajouter le count de transactions
  Object.keys(vendorStats).forEach(canonicalId => {
    vendorStats[parseInt(canonicalId)].total_transactions = vendorSales[parseInt(canonicalId)].size
  })

  // 5. Calculer le CA global pour contribution_pct
  const display = (params.display as DisplayMode) || 'ttc'
  const globalRevenue = Object.values(vendorStats).reduce((sum: number, v: any) => sum + v.total_revenue, 0)

  // 6. Créer le classement avec contribution_pct
  const rankings = Object.values(vendorStats)
    .map((v: any) => {
      const prevRevenue = previousStats[v.vendor_id] || 0
      const evolution = prevRevenue > 0
        ? ((v.total_revenue - prevRevenue) / prevRevenue * 100)
        : (v.total_revenue > 0 ? 100 : 0)

      const cbCount = v.payment_methods['CB'] || v.payment_methods['Carte bancaire'] || 0
      const cashCount = v.payment_methods['ESP'] || v.payment_methods['Espèces'] || v.payment_methods['ESPECES'] || 0
      const cbPercent = v.total_transactions > 0 ? (cbCount / v.total_transactions * 100) : 0
      const cashPercent = v.total_transactions > 0 ? (cashCount / v.total_transactions * 100) : 0

      // Nouveau: % de contribution au CA global
      const contributionPct = globalRevenue > 0 ? (v.total_revenue / globalRevenue * 100) : 0

      const revenueTTC = v.total_revenue
      const revenueHT = calculateHT(revenueTTC, TVA_RATE)
      const avgBasketTTC = v.total_transactions > 0 ? revenueTTC / v.total_transactions : 0
      const avgBasketHT = v.total_transactions > 0 ? revenueHT / v.total_transactions : 0

      return {
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name,
        user_name: v.user_name,
        // Montants selon display mode
        ...(display === 'both' ? {
          total_revenue_ttc: parseFloat(revenueTTC.toFixed(2)),
          total_revenue_ht: parseFloat(revenueHT.toFixed(2)),
          avg_basket_ttc: parseFloat(avgBasketTTC.toFixed(2)),
          avg_basket_ht: parseFloat(avgBasketHT.toFixed(2))
        } : display === 'ht' ? {
          total_revenue: parseFloat(revenueHT.toFixed(2)),
          avg_basket: parseFloat(avgBasketHT.toFixed(2))
        } : {
          total_revenue: parseFloat(revenueTTC.toFixed(2)),
          avg_basket: parseFloat(avgBasketTTC.toFixed(2))
        }),
        total_transactions: v.total_transactions,
        total_items: v.total_items, // Nouveau: nombre d'articles vendus (somme des quantités)
        contribution_pct: parseFloat(contributionPct.toFixed(1)),
        stores_count: v.stores.size,
        evolution_percent: parseFloat(evolution.toFixed(2)),
        previous_revenue: parseFloat(prevRevenue.toFixed(2)),
        payment_breakdown: {
          cb_percent: parseFloat(cbPercent.toFixed(2)),
          cash_percent: parseFloat(cashPercent.toFixed(2)),
          cb_count: cbCount,
          cash_count: cashCount
        }
      }
    })
    .sort((a: any, b: any) => {
      // Trier par TTC interne pour cohérence
      const aRev = a.total_revenue_ttc ?? a.total_revenue ?? 0
      const bRev = b.total_revenue_ttc ?? b.total_revenue ?? 0
      return bRev - aRev
    })
    .slice(0, params.limit || 20)
    .map((v: any, index: number, arr: any[]) => ({
      ...v,
      rank: index + 1,
      contribution_cumulative_pct: parseFloat(
        arr.slice(0, index + 1).reduce((sum, x) => sum + x.contribution_pct, 0).toFixed(1)
      ) // Contribution cumulée pour analyse Pareto
    }))

  // 7. Totaux
  const totalRevenueTTC = rankings.reduce((sum, v) => {
    return sum + (v.total_revenue_ttc ?? v.total_revenue ?? 0)
  }, 0)
  const totalRevenueHT = calculateHT(totalRevenueTTC, TVA_RATE)
  const totalTransactions = rankings.reduce((sum, v) => sum + v.total_transactions, 0)
  const totalItems = rankings.reduce((sum, v) => sum + v.total_items, 0)

  const avgCbPercent = rankings.length > 0
    ? rankings.reduce((sum, v) => sum + v.payment_breakdown.cb_percent, 0) / rankings.length
    : 0
  const avgCashPercent = rankings.length > 0
    ? rankings.reduce((sum, v) => sum + v.payment_breakdown.cash_percent, 0) / rankings.length
    : 0

  return {
    success: true,
    action: 'vendor_ranking',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: params.store_id || null,
      category_name: categorySearchTerm || null,
      limit: params.limit
    },
    data: {
      summary: {
        total_vendors: rankings.length,
        // Montants selon display mode
        ...(display === 'both' ? {
          total_revenue_ttc: parseFloat(totalRevenueTTC.toFixed(2)),
          total_revenue_ht: parseFloat(totalRevenueHT.toFixed(2)),
          avg_revenue_per_vendor_ttc: rankings.length > 0 ? parseFloat((totalRevenueTTC / rankings.length).toFixed(2)) : null,
          avg_revenue_per_vendor_ht: rankings.length > 0 ? parseFloat((totalRevenueHT / rankings.length).toFixed(2)) : null
        } : display === 'ht' ? {
          total_revenue: parseFloat(totalRevenueHT.toFixed(2)),
          avg_revenue_per_vendor: rankings.length > 0 ? parseFloat((totalRevenueHT / rankings.length).toFixed(2)) : null
        } : {
          total_revenue: parseFloat(totalRevenueTTC.toFixed(2)),
          avg_revenue_per_vendor: rankings.length > 0 ? parseFloat((totalRevenueTTC / rankings.length).toFixed(2)) : null
        }),
        total_transactions: totalTransactions,
        total_items: totalItems, // Nouveau: nombre total d'articles vendus
        display_mode: display,
        avg_cb_percent: parseFloat(avgCbPercent.toFixed(2)),
        avg_cash_percent: parseFloat(avgCashPercent.toFixed(2))
      },
      highlights: {
        top_performer: rankings[0] || null,
        fastest_growing: [...rankings].sort((a, b) => b.evolution_percent - a.evolution_percent)[0] || null,
        highest_avg_basket: [...rankings].sort((a, b) => b.avg_basket - a.avg_basket)[0] || null
      },
      rankings
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: currentItems.length,
      denormalized: true
    }
  }
}
