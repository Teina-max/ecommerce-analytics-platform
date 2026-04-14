/**
 * Action: category_sales
 * Analytics de ventes par catégorie
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import { fetchAllRows, fetchByChunks } from '../../_shared/pagination.ts'
import { loadVendors, findVendorByName, getVendorFullName } from '../../_shared/vendors.ts'
import { resolveCategoryByName, filterVirtualItems, matchCategoryFlexible, filterItemsByCategory } from '../../_shared/categories.ts'
import { VIRTUAL_CATEGORY_IDS, TVA_RATE } from '../../_shared/constants.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '2.2-pagination-fix'

export async function handleCategorySales(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // 1. Résoudre le vendeur si spécifié
  let vendorFilter: number | null = null
  let vendorInfo: any = null

  if (params.vendor_id) {
    vendorFilter = params.vendor_id
    const { data } = await supabase
      .from('vendors')
      .select('id, first_name, last_name')
      .eq('id', params.vendor_id)
      .single()
    vendorInfo = data
  } else if (params.vendor_name) {
    const result = await findVendorByName(supabase, params.vendor_name)
    if (result.vendor) {
      vendorFilter = result.vendor.id
      vendorInfo = result.vendor
    } else if (result.error && result.suggestions) {
      return {
        success: false,
        action: 'category_sales',
        version: VERSION,
        period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
        data: {
          error: result.error,
          suggestions: result.suggestions.map(v => ({
            id: v.id,
            name: getVendorFullName(v)
          }))
        },
        metadata: { generated_at: new Date().toISOString() }
      }
    }
  }

  // 2. Résoudre la catégorie canonique si spécifiée par nom
  let canonicalCategoryId = params.canonical_category_id || null
  let canonicalCategoryInfo: any = null

  if (!canonicalCategoryId && params.canonical_category_name) {
    const resolved = await resolveCategoryByName(supabase, params.canonical_category_name)
    if (resolved.found) {
      canonicalCategoryId = resolved.id
      canonicalCategoryInfo = resolved
    }
  }

  // 3. Récupérer les items directement depuis sale_items (dénormalisé)
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, sale_date, vendor_id, vendor_name, store_id, store_name,
      product_id, product_name, quantity, total_line,
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

  if (vendorFilter) {
    itemsQuery = itemsQuery.eq('vendor_id', vendorFilter)
  }

  const allItems = await fetchAllRows(itemsQuery.order('id'))

  if (allItems.length === 0) {
    return {
      success: true,
      action: 'category_sales',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      filters: {
        category_name: params.category_name,
        parent_category_name: params.parent_category_name,
        vendor_id: vendorFilter,
        vendor_name: vendorInfo ? getVendorFullName(vendorInfo) : null
      },
      data: {
        message: 'Aucune vente trouvée pour cette période',
        summary: { total_quantity: 0, total_revenue: 0, unique_products: 0 },
        items: []
      },
      metadata: { generated_at: new Date().toISOString(), rows_fetched: 0 }
    }
  }

  // 5. Filtrer les produits virtuels
  let filteredItems = filterVirtualItems(allItems)
  const excludedVirtualCount = allItems.length - filteredItems.length

  // 6. Appliquer les filtres de catégorie
  let categoryFilterApplied = false

  // TOUJOURS utiliser filterItemsByCategory quand un nom est fourni
  // car les canonical_category_id dans sale_items ne correspondent pas aux hiboutik_category_id
  const categorySearchTermCat = params.category_name || params.canonical_category_name
  if (categorySearchTermCat) {
    categoryFilterApplied = true
    // Utilise filterItemsByCategory qui cherche sur les 3 niveaux
    filteredItems = filterItemsByCategory(filteredItems, categorySearchTermCat)
  }

  // Filtre par parent_category_name (recherche sur 3 niveaux également)
  if (params.parent_category_name) {
    categoryFilterApplied = true
    // Utilise filterItemsByCategory qui cherche sur les 3 niveaux
    filteredItems = filterItemsByCategory(filteredItems, params.parent_category_name)
  }

  // 7. Agréger les résultats
  const productStats: Record<string, any> = {}
  const brandStats: Record<string, any> = {}
  // CORRECTION v2.1: Agrégation par catégorie parente
  const parentCategoryStats: Record<string, any> = {}
  const childCategoryStats: Record<string, any> = {}
  let totalQuantity = 0
  let totalRevenue = 0

  filteredItems.forEach(item => {
    const qty = item.quantity || 0
    const revenue = parseFloat(item.total_line || '0')

    totalQuantity += qty
    totalRevenue += revenue

    // Par produit
    const productName = item.product_name
    if (!productStats[productName]) {
      productStats[productName] = {
        product_id: item.product_id,
        product_name: productName,
        brand_name: item.brand_name,
        category_name: item.category_name,
        parent_category_name: item.parent_category_name,
        quantity: 0,
        revenue: 0
      }
    }
    productStats[productName].quantity += qty
    productStats[productName].revenue += revenue

    // CORRECTION v2.1: Par catégorie parente
    const parentCat = item.parent_category_name || item.category_name || 'Non catégorisé'
    if (!parentCategoryStats[parentCat]) {
      parentCategoryStats[parentCat] = {
        category_name: parentCat,
        quantity: 0,
        revenue: 0,
        products_count: new Set()
      }
    }
    parentCategoryStats[parentCat].quantity += qty
    parentCategoryStats[parentCat].revenue += revenue
    parentCategoryStats[parentCat].products_count.add(item.product_name)

    // Par catégorie enfant (plus granulaire)
    const childCat = item.category_name || 'Non catégorisé'
    if (!childCategoryStats[childCat]) {
      childCategoryStats[childCat] = {
        category_name: childCat,
        parent_category_name: item.parent_category_name,
        quantity: 0,
        revenue: 0,
        products_count: new Set()
      }
    }
    childCategoryStats[childCat].quantity += qty
    childCategoryStats[childCat].revenue += revenue
    childCategoryStats[childCat].products_count.add(item.product_name)

    // Par marque
    if (params.include_brands) {
      const brandName = item.brand_name || 'Sans marque'
      if (!brandStats[brandName]) {
        brandStats[brandName] = {
          brand_name: brandName,
          quantity: 0,
          revenue: 0,
          products_count: new Set()
        }
      }
      brandStats[brandName].quantity += qty
      brandStats[brandName].revenue += revenue
      brandStats[brandName].products_count.add(item.product_name)
    }
  })

  // Top produits
  const topProducts = Object.values(productStats)
    .map((p: any) => ({
      ...p,
      revenue: parseFloat(p.revenue.toFixed(2)),
      percent_of_total: totalRevenue > 0
        ? parseFloat((p.revenue / totalRevenue * 100).toFixed(2))
        : 0
    }))
    .sort((a: any, b: any) => b.revenue - a.revenue)
    .slice(0, params.limit || 20)

  // Top marques
  const topBrands = params.include_brands
    ? Object.values(brandStats)
        .map((b: any) => ({
          brand_name: b.brand_name,
          quantity: b.quantity,
          revenue: parseFloat(b.revenue.toFixed(2)),
          products_count: b.products_count.size,
          percent_of_total: totalRevenue > 0
            ? parseFloat((b.revenue / totalRevenue * 100).toFixed(2))
            : 0
        }))
        .sort((a: any, b: any) => b.revenue - a.revenue)
        .slice(0, 10)
    : undefined

  // CORRECTION v2.1: Top catégories parentes
  const topParentCategories = Object.values(parentCategoryStats)
    .map((c: any) => ({
      category_name: c.category_name,
      quantity: c.quantity,
      revenue: parseFloat(c.revenue.toFixed(2)),
      products_count: c.products_count.size,
      percent_of_total: totalRevenue > 0
        ? parseFloat((c.revenue / totalRevenue * 100).toFixed(2))
        : 0
    }))
    .sort((a: any, b: any) => b.revenue - a.revenue)
    .slice(0, 15)

  // Top catégories enfants
  const topChildCategories = Object.values(childCategoryStats)
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
    .slice(0, 15)

  return {
    success: true,
    action: 'category_sales',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      category_name: params.category_name,
      parent_category_name: params.parent_category_name,
      canonical_category_id: canonicalCategoryId,
      canonical_category_name: canonicalCategoryInfo?.name,
      vendor_id: vendorFilter,
      vendor_name: vendorInfo ? getVendorFullName(vendorInfo) : null,
      store_id: params.store_id || null
    },
    data: {
      summary: {
        total_quantity: totalQuantity,
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        total_revenue_ht: parseFloat((totalRevenue / (1 + TVA_RATE)).toFixed(2)),
        unique_products: Object.keys(productStats).length,
        unique_categories: Object.keys(parentCategoryStats).length,
        unique_brands: params.include_brands ? Object.keys(brandStats).length : undefined
      },
      // CORRECTION v2.1: Inclure le classement des catégories
      top_parent_categories: topParentCategories,
      top_child_categories: topChildCategories,
      top_products: topProducts,
      top_brands: topBrands
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      items_after_filter: filteredItems.length,
      virtual_items_excluded: excludedVirtualCount,
      category_filter_applied: categoryFilterApplied
    }
  }
}
