/**
 * Actions: product_challenge, team_challenge, combo_challenge
 * Migré depuis get-product-challenge-ranking v8.3
 * Version: 1.3-variant-filter
 *
 * v1.3: Ajout du paramètre variant_filter pour filtrer par taux de nicotine (ex: "20mg")
 * v1.2: Exclusion des cartouches du comptage des kits dans combo_challenge
 * v1.1: Fix parsing catégories multiples (ex: "10 ML,50 ML")
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import { filterItemsByCategory } from '../../_shared/categories.ts'
import { VIRTUAL_CATEGORY_IDS, EXCLUDED_VENDOR_IDS } from '../../_shared/constants.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '1.3-variant-filter'

// Règle hardcodée 1ML/40
const HARDCODED_1ML_RULE = {
  divisor: 40,
  description: '1ml compte comme 1/40 de 50ml (CEIL arrondi supérieur)'
}

/**
 * Normalise le nom d'un vendeur (supprime les espaces doubles)
 */
function normalizeVendorName(name: string | null): string {
  if (!name) return 'Inconnu'
  return name.replace(/\s+/g, ' ').trim()
}

interface QuantityRule {
  id: number
  product_id: number | null
  product_pattern: string | null
  category_pattern: string | null
  parent_category_pattern: string | null
  divisor: number
  description: string | null
  priority: number
}

async function getQuantityRules(supabase: any): Promise<QuantityRule[]> {
  const { data, error } = await supabase
    .from('product_quantity_rules')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: true })

  if (error) {
    console.error('Error fetching quantity rules:', error)
    return []
  }
  return data || []
}

function getItemDivisor(item: any, rules: QuantityRule[]): { divisor: number; rule_id: number | null; description: string | null } {
  const productId = item.product_id
  const productName = (item.product_name || '').toLowerCase()
  const categoryName = (item.category_name || '').toLowerCase()
  const parentCategoryName = (item.parent_category_name || '').toLowerCase()

  for (const rule of rules) {
    if (rule.product_id !== null && rule.product_id === productId) {
      return { divisor: rule.divisor, rule_id: rule.id, description: rule.description }
    }

    if (rule.product_id === null) {
      const matchesProduct = !rule.product_pattern ||
        productName.includes(rule.product_pattern.replace(/%/g, '').toLowerCase())
      const matchesCategory = !rule.category_pattern ||
        categoryName.includes(rule.category_pattern.replace(/%/g, '').toLowerCase())
      const matchesParentCategory = !rule.parent_category_pattern ||
        parentCategoryName.includes(rule.parent_category_pattern.replace(/%/g, '').toLowerCase())
      const hasPattern = rule.product_pattern || rule.category_pattern || rule.parent_category_pattern

      if (hasPattern && matchesProduct && matchesCategory && matchesParentCategory) {
        return { divisor: rule.divisor, rule_id: rule.id, description: rule.description }
      }
    }
  }

  // Règle hardcodée 1ML/40
  const matches1ml = productName.includes('- 1ml') || productName.includes('- 1 ml') ||
                     productName.includes(' 1ml') || productName.includes(' 1 ml')
  const matches50ml = parentCategoryName.includes('50 ml') || parentCategoryName.includes('50ml')

  if (matches1ml && matches50ml) {
    return { divisor: HARDCODED_1ML_RULE.divisor, rule_id: -1, description: HARDCODED_1ML_RULE.description }
  }

  return { divisor: 1, rule_id: null, description: null }
}

function normalizeQuantity(rawQuantity: number, divisor: number): number {
  if (divisor <= 1) return rawQuantity
  return Math.ceil(rawQuantity / divisor)
}

async function resolveCanonicalCategoryId(supabase: any, categoryName: string): Promise<{ id: number | null; name: string; category_type: string | null }> {
  if (!categoryName) return { id: null, name: '', category_type: null }

  const { data, error } = await supabase
    .from('categories')
    .select('id, hiboutik_category_id, category_name')
    .ilike('category_name', `%${categoryName}%`)
    .eq('api_source', 'main')
    .limit(5)

  if (error || !data || data.length === 0) {
    return { id: null, name: categoryName, category_type: null }
  }

  const exact = data.find((c: any) => c.category_name.toLowerCase() === categoryName.toLowerCase())
  const cat = exact || data[0]
  return { id: cat.hiboutik_category_id, name: cat.category_name, category_type: null }
}

// ============================================
// PRODUCT CHALLENGE
// ============================================
export async function handleProductChallenge(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context

  const periodStart = period.startDateTime
  const periodEnd = period.endDateTime

  const normalizeQuantities = params.normalize_quantities !== false
  const showRawQuantities = params.show_raw_quantities === true
  const excludeVirtual = params.exclude_virtual !== false
  const minQty = params.min_qty || 0
  const searchMode = params.search_mode || 'AND'
  const limit = params.limit || 20
  const includeCategoryPercent = params.include_category_percent === true
  const sortByCategoryPercent = params.sort_by_category_percent === true

  const quantityRules = normalizeQuantities ? await getQuantityRules(supabase) : []

  // Résoudre catégorie canonique
  let canonicalCategoryId = params.canonical_category_id || null
  let canonicalCategoryInfo: any = null
  if (!canonicalCategoryId && params.canonical_category_name) {
    canonicalCategoryInfo = await resolveCanonicalCategoryId(supabase, params.canonical_category_name)
    canonicalCategoryId = canonicalCategoryInfo.id
  }

  // Requête sale_items
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, sale_date, payment_method,
      vendor_id, vendor_name, store_id, store_name,
      product_id, product_name, quantity, total_line,
      category_id, category_name, parent_category_id, parent_category_name,
      brand_id, brand_name,
      canonical_category_id, canonical_parent_category_id
    `)
    .gte('sale_date', periodStart)
    .lte('sale_date', periodEnd)
    .order('id', { ascending: true })

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery, 1000, 100000)
  console.log(`[product_challenge] Fetched ${allItems.length} items`)

  if (!allItems || allItems.length === 0) {
    return {
      success: false,
      action: 'product_challenge',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: { message: 'Aucune vente trouvée pour cette période' }
    }
  }

  // Filtrer items virtuels
  let filteredItems = allItems
  let excludedVirtualCount = 0

  if (excludeVirtual) {
    const beforeCount = filteredItems.length
    filteredItems = filteredItems.filter(item => {
      if (item.canonical_category_id && VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id)) return false
      if (item.canonical_parent_category_id && VIRTUAL_CATEGORY_IDS.includes(item.canonical_parent_category_id)) return false
      return true
    })
    excludedVirtualCount = beforeCount - filteredItems.length
  }

  // Exclure vendeurs techniques
  filteredItems = filteredItems.filter(item => {
    if (!item.vendor_id) return false
    return !EXCLUDED_VENDOR_IDS.includes(item.vendor_id)
  })

  const matchedProducts = new Set<string>()
  const searchedTerms: string[] = []

  // Filtre par marque
  let brandProductIds: number[] = []
  let resolvedBrandName: string | null = null

  if (params.brand_query) {
    const { data: brands } = await supabase
      .from('brands')
      .select('id, brand_name')
      .ilike('brand_name', `%${params.brand_query}%`)
      .limit(5)

    const brandIds = brands?.map((b: any) => b.id) || []
    if (brands && brands.length > 0) {
      resolvedBrandName = brands[0].brand_name
    }

    let brandProductsQuery = supabase
      .from('products')
      .select('id, product_brand, brand_id')
      .eq('is_active', true)

    if (brandIds.length > 0) {
      brandProductsQuery = brandProductsQuery.or(`brand_id.in.(${brandIds.join(',')}),product_brand.ilike.%${params.brand_query}%`)
    } else {
      brandProductsQuery = brandProductsQuery.ilike('product_brand', `%${params.brand_query}%`)
    }

    const { data: brandProducts } = await brandProductsQuery
    brandProductIds = brandProducts?.map((p: any) => p.id) || []
  }

  // Filtre par catégorie
  const categorySearchTerm = canonicalCategoryInfo?.name || params.category_name
  if (categorySearchTerm) {
    searchedTerms.push(`category:${categorySearchTerm}`)
    const beforeCount = filteredItems.length
    filteredItems = filterItemsByCategory(filteredItems, categorySearchTerm)
    filteredItems.forEach(item => matchedProducts.add(item.product_name))
    console.log(`[product_challenge] Category filter "${categorySearchTerm}": ${beforeCount} -> ${filteredItems.length} items`)
  }

  if (params.parent_category_name) {
    searchedTerms.push(`parent_category:${params.parent_category_name}`)
    const beforeCount = filteredItems.length
    filteredItems = filterItemsByCategory(filteredItems, params.parent_category_name)
    filteredItems.forEach(item => matchedProducts.add(item.product_name))
    console.log(`[product_challenge] Parent category filter: ${beforeCount} -> ${filteredItems.length} items`)
  }

  // Filtre par brand - CORRIGÉ: filtre aussi par brand_name même si aucun product_id trouvé
  if (params.brand_query) {
    searchedTerms.push(`brand:${params.brand_query}`)
    const brandQueryLower = params.brand_query.toLowerCase()
    filteredItems = filteredItems.filter(item => {
      const matchesBrandId = brandProductIds.length > 0 && brandProductIds.includes(item.product_id)
      const matchesBrandName = item.brand_name?.toLowerCase().includes(brandQueryLower)
      if (matchesBrandId || matchesBrandName) {
        matchedProducts.add(item.product_name)
        return true
      }
      return false
    })
    console.log(`[product_challenge] Brand filter "${params.brand_query}": ${filteredItems.length} items matched`)
  }

  // Filtre par productQuery
  if (params.product_query && !params.brand_query) {
    const terms = params.product_query.split(',').map((t: string) => t.trim().toLowerCase()).filter((t: string) => t.length > 0)
    searchedTerms.push(...terms.map(t => `product:${t}`))

    filteredItems = filteredItems.filter((item: any) => {
      const productName = (item.product_name || '').toLowerCase()
      if (searchMode === 'OR') {
        const matches = terms.some((term: string) => productName.includes(term))
        if (matches) matchedProducts.add(item.product_name)
        return matches
      } else {
        const matches = terms.every((term: string) => productName.includes(term))
        if (matches) matchedProducts.add(item.product_name)
        return matches
      }
    })
  }

  // Agréger par vendeur
  const vendorStats: any = {}
  let normalizedItemsCount = 0

  filteredItems.forEach((item: any) => {
    const vendorId = item.vendor_id
    if (!vendorId) return

    if (!vendorStats[vendorId]) {
      vendorStats[vendorId] = {
        vendor_id: vendorId,
        vendor_name: normalizeVendorName(item.vendor_name) || `Vendeur ${vendorId}`,
        total_qty: 0,
        total_qty_raw: 0,
        total_revenue: 0,
        transaction_count: 0,
        products: new Map(),
        sale_ids: new Set()
      }
    }

    const rawQty = item.quantity || 0
    let normalizedQty = rawQty

    if (normalizeQuantities && quantityRules.length > 0) {
      const { divisor } = getItemDivisor(item, quantityRules)
      if (divisor > 1) {
        normalizedQty = normalizeQuantity(rawQty, divisor)
        normalizedItemsCount++
      }
    }

    vendorStats[vendorId].total_qty += normalizedQty
    vendorStats[vendorId].total_qty_raw += rawQty
    vendorStats[vendorId].total_revenue += parseFloat(item.total_line || '0')

    if (item.hiboutik_sale_id && !vendorStats[vendorId].sale_ids.has(item.hiboutik_sale_id)) {
      vendorStats[vendorId].sale_ids.add(item.hiboutik_sale_id)
      vendorStats[vendorId].transaction_count++
    }

    const productName = item.product_name
    const existingProduct = vendorStats[vendorId].products.get(productName)
    if (existingProduct) {
      existingProduct.qty += normalizedQty
      existingProduct.revenue += parseFloat(item.total_line || '0')
    } else {
      vendorStats[vendorId].products.set(productName, {
        name: productName,
        qty: normalizedQty,
        revenue: parseFloat(item.total_line || '0')
      })
    }
  })

  // Calculer % catégorie si demandé
  const resolvedCategoryNameForCompare = params.compare_category_name || params.parent_category_name || params.category_name || null
  let categoryTotalsByVendor: any = {}
  const hasCategoryComparison = !!resolvedCategoryNameForCompare

  if (hasCategoryComparison) {
    const challengeProductIds = new Set(filteredItems.map((item: any) => item.product_id))

    const categoryItems = allItems.filter(item => {
      if (excludeVirtual && VIRTUAL_CATEGORY_IDS.includes(item.canonical_category_id)) return false
      if (!item.vendor_id || EXCLUDED_VENDOR_IDS.includes(item.vendor_id)) return false

      const catName = (item.category_name || '').toLowerCase()
      const parentCatName = (item.parent_category_name || '').toLowerCase()
      return catName.includes(resolvedCategoryNameForCompare.toLowerCase()) ||
             parentCatName.includes(resolvedCategoryNameForCompare.toLowerCase())
    })

    categoryItems.forEach(item => {
      const vendorId = item.vendor_id
      if (!vendorId) return

      let qty = item.quantity || 0
      if (normalizeQuantities && quantityRules.length > 0) {
        const { divisor } = getItemDivisor(item, quantityRules)
        if (divisor > 1) qty = normalizeQuantity(qty, divisor)
      }

      categoryTotalsByVendor[vendorId] = (categoryTotalsByVendor[vendorId] || 0) + qty
    })
  }

  // Créer le classement
  const shouldSortByPercent = sortByCategoryPercent || hasCategoryComparison

  let rankings = Object.values(vendorStats)
    .map((v: any) => {
      const topProducts = Array.from(v.products.values())
        .sort((a: any, b: any) => b.qty - a.qty)
        .slice(0, 3)

      const categoryTotal = categoryTotalsByVendor[v.vendor_id] || 0
      const productQty = v.total_qty
      const hasCategoryShare = hasCategoryComparison && categoryTotal > 0
      const categoryPercent = hasCategoryShare ? parseFloat((productQty / categoryTotal * 100).toFixed(2)) : 0

      const categoryShare = hasCategoryShare ? {
        category_name: resolvedCategoryNameForCompare,
        category_total_qty: categoryTotal,
        product_qty: productQty,
        percent_of_category: categoryPercent,
        challenge_text: `${productQty} sur ${categoryTotal} (${categoryPercent}%)`
      } : null

      return {
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name,
        total_qty: v.total_qty,
        total_qty_raw: showRawQuantities ? v.total_qty_raw : undefined,
        total_revenue: parseFloat(v.total_revenue.toFixed(2)),
        transaction_count: v.transaction_count,
        is_qualified: v.total_qty >= minQty,
        top_products: topProducts,
        category_share: categoryShare
      }
    })
    .filter((v: any) => v.total_qty > 0)
    .sort((a: any, b: any) => {
      if (shouldSortByPercent && a.category_share && b.category_share) {
        if (a.is_qualified !== b.is_qualified) {
          return a.is_qualified ? -1 : 1
        }
        return b.category_share.percent_of_category - a.category_share.percent_of_category
      }
      return b.total_qty - a.total_qty
    })
    .slice(0, limit)
    .map((v: any, index: number) => ({ ...v, rank: index + 1 }))

  const totalQtySold = rankings.reduce((sum, v) => sum + v.total_qty, 0)
  const totalRevenue = rankings.reduce((sum, v) => sum + v.total_revenue, 0)
  const qualifiedVendors = rankings.filter(v => v.is_qualified).length

  // Ajouter % de marque par vendeur
  rankings = rankings.map((v: any) => ({
    ...v,
    vendor_share_of_brand_percent: totalQtySold > 0
      ? parseFloat((v.total_qty / totalQtySold * 100).toFixed(2))
      : 0
  }))

  return {
    success: true,
    action: 'product_challenge',
    version: VERSION,
    period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
    filters: {
      product_query: params.product_query,
      brand_query: params.brand_query,
      category_name: params.category_name,
      parent_category_name: params.parent_category_name,
      store_id: params.store_id || null,
      min_qty: minQty,
      search_mode: searchMode,
      searched_terms: [...new Set(searchedTerms)],
      matched_products: [...matchedProducts].slice(0, 10)
    },
    data: {
      summary: {
        total_vendors: rankings.length,
        qualified_vendors: qualifiedVendors,
        total_qty_sold: totalQtySold,
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        leader: rankings[0] || null
      },
      rankings: rankings,
      normalization: normalizeQuantities ? {
        enabled: true,
        rules_count: quantityRules.length,
        items_normalized: normalizedItemsCount
      } : { enabled: false }
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      items_after_filter: filteredItems.length,
      virtual_items_excluded: excludedVirtualCount
    }
  }
}

// ============================================
// TEAM CHALLENGE
// ============================================
export async function handleTeamChallenge(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context

  const periodStart = period.startDateTime
  const periodEnd = period.endDateTime
  const targetAmount = params.target_amount || 0
  const bonusPercent = params.bonus_percent || 5
  const minVendorsForBonus = params.min_vendors_for_bonus || 1
  const limit = params.limit || 20

  // Parser objectifs par magasin
  const storeTargets: Record<number, number> = {}
  if (params.target_per_store) {
    params.target_per_store.split(',').forEach((pair: string) => {
      const [sid, amount] = pair.split(':')
      if (sid && amount) {
        storeTargets[parseInt(sid)] = parseFloat(amount)
      }
    })
  }

  // Récupérer items
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, vendor_id, vendor_name, store_id, store_name, total_line')
    .gte('sale_date', periodStart)
    .lte('sale_date', periodEnd)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const items = await fetchAllRows(itemsQuery, 1000, 100000)

  // Agréger par vente unique
  const salesMap = new Map<number, { vendor_id: number; vendor_name: string; store_id: number; store_name: string; total: number }>()

  items.forEach((item: any) => {
    if (!item.vendor_id || !item.hiboutik_sale_id) return
    if (EXCLUDED_VENDOR_IDS.includes(item.vendor_id)) return

    if (!salesMap.has(item.hiboutik_sale_id)) {
      salesMap.set(item.hiboutik_sale_id, {
        vendor_id: item.vendor_id,
        vendor_name: item.vendor_name || `Vendeur ${item.vendor_id}`,
        store_id: item.store_id,
        store_name: item.store_name || 'Inconnu',
        total: 0
      })
    }
    salesMap.get(item.hiboutik_sale_id)!.total += parseFloat(item.total_line || '0')
  })

  const sales = Array.from(salesMap.values())

  // Agréger par vendeur
  const vendorStats: any = {}
  sales.forEach((sale: any) => {
    const vid = sale.vendor_id
    if (!vendorStats[vid]) {
      vendorStats[vid] = {
        vendor_id: vid,
        vendor_name: sale.vendor_name,
        store_name: sale.store_name,
        store_id: sale.store_id,
        total_revenue_ttc: 0,
        total_transactions: 0
      }
    }
    vendorStats[vid].total_revenue_ttc += sale.total
    vendorStats[vid].total_transactions += 1
  })

  const rankings = Object.values(vendorStats)
    .map((v: any) => {
      const revenueHT = v.total_revenue_ttc / 1.2
      const vendorTarget = storeTargets[v.store_id] || targetAmount
      const targetReached = revenueHT >= vendorTarget
      const amountAboveTarget = Math.max(0, revenueHT - vendorTarget)
      const bonusAmount = targetReached ? amountAboveTarget * (bonusPercent / 100) : 0
      const percentOfTarget = vendorTarget > 0 ? (revenueHT / vendorTarget * 100) : 0
      const missingForTarget = Math.max(0, vendorTarget - revenueHT)

      return {
        vendor_id: v.vendor_id,
        vendor_name: normalizeVendorName(v.vendor_name),
        store_name: v.store_name,
        store_id: v.store_id,
        total_revenue_ttc: parseFloat(v.total_revenue_ttc.toFixed(2)),
        total_revenue_ht: parseFloat(revenueHT.toFixed(2)),
        total_transactions: v.total_transactions,
        avg_basket: parseFloat((v.total_revenue_ttc / v.total_transactions).toFixed(2)),
        target_amount: vendorTarget,
        target_reached: targetReached,
        percent_of_target: parseFloat(percentOfTarget.toFixed(2)),
        missing_for_target: parseFloat(missingForTarget.toFixed(2)),
        amount_above_target: parseFloat(amountAboveTarget.toFixed(2)),
        potential_bonus: parseFloat(bonusAmount.toFixed(2))
      }
    })
    .sort((a: any, b: any) => b.total_revenue_ht - a.total_revenue_ht)
    .slice(0, limit)
    .map((v: any, index: number) => ({ ...v, rank: index + 1 }))

  // Stats par magasin
  const storeStats: any = {}
  rankings.forEach((v: any) => {
    if (!storeStats[v.store_id]) {
      storeStats[v.store_id] = {
        store_id: v.store_id,
        store_name: v.store_name,
        vendors_count: 0,
        vendors_qualified: 0,
        total_revenue_ht: 0
      }
    }
    storeStats[v.store_id].vendors_count += 1
    storeStats[v.store_id].total_revenue_ht += v.total_revenue_ht
    if (v.target_reached) storeStats[v.store_id].vendors_qualified += 1
  })

  const storeRankings = Object.values(storeStats)
    .map((s: any) => ({
      ...s,
      total_revenue_ht: parseFloat(s.total_revenue_ht.toFixed(2)),
      team_bonus_eligible: s.vendors_count >= minVendorsForBonus
    }))
    .sort((a: any, b: any) => b.total_revenue_ht - a.total_revenue_ht)

  const totalRevenueHT = rankings.reduce((sum, v) => sum + v.total_revenue_ht, 0)
  const vendorsQualified = rankings.filter(v => v.target_reached).length
  const totalBonus = rankings.reduce((sum, v) => sum + v.potential_bonus, 0)

  return {
    success: true,
    action: 'team_challenge',
    version: VERSION,
    period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
    filters: {
      target_amount_ht: targetAmount,
      target_per_store: Object.keys(storeTargets).length > 0 ? storeTargets : undefined,
      bonus_percent: bonusPercent,
      min_vendors_for_bonus: minVendorsForBonus,
      store_id: params.store_id || null
    },
    data: {
      summary: {
        total_vendors: rankings.length,
        vendors_qualified: vendorsQualified,
        vendors_not_qualified: rankings.length - vendorsQualified,
        total_revenue_ht: parseFloat(totalRevenueHT.toFixed(2)),
        total_potential_bonus: parseFloat(totalBonus.toFixed(2)),
        leader: rankings[0] || null
      },
      rankings: rankings,
      by_store: storeRankings
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: items.length
    }
  }
}

// ============================================
// COMBO CHALLENGE
// ============================================
export async function handleComboChallenge(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context

  const periodStart = period.startDateTime
  const periodEnd = period.endDateTime
  const kitQuery = params.kit_query
  const eliquidQuery = params.eliquid_query
  const eliquidBrand = params.eliquid_brand
  const eliquidCategory = params.eliquid_category
  const variantFilter = params.variant_filter // ex: "20mg", "20", "sel"
  const includeCategoryPercent = params.include_category_percent === true
  const limit = params.limit || 20

  // Validation
  if (!kitQuery) {
    return {
      success: false,
      action: 'combo_challenge',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: { message: 'Le paramètre kit_query est requis' }
    }
  }

  const hasEliquidFilter = eliquidQuery || eliquidBrand || eliquidCategory
  if (!hasEliquidFilter) {
    return {
      success: false,
      action: 'combo_challenge',
      version: VERSION,
      period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
      data: null,
      metadata: { generated_at: new Date().toISOString() },
      debug: { message: 'Au moins un paramètre e-liquide est requis: eliquid_query, eliquid_brand, ou eliquid_category' }
    }
  }

  // Récupérer items
  let itemsQuery = supabase
    .from('sale_items')
    .select(`
      id, hiboutik_sale_id, sale_date, payment_method,
      vendor_id, vendor_name, store_id, store_name,
      product_id, product_name, quantity, total_line,
      category_id, category_name, parent_category_id, parent_category_name,
      grandparent_category_id, grandparent_category_name,
      canonical_category_id, canonical_parent_category_id,
      brand_name, variant_name, size_name
    `)
    .gte('sale_date', periodStart)
    .lte('sale_date', periodEnd)
    .order('hiboutik_sale_id', { ascending: true })

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const allItems = await fetchAllRows(itemsQuery, 1000, 100000)
  console.log(`[combo_challenge] Fetched ${allItems.length} items`)

  // Filtrer vendeurs techniques
  const filteredItems = allItems.filter((item: any) => {
    if (!item.vendor_id) return false
    return !EXCLUDED_VENDOR_IDS.includes(item.vendor_id)
  })

  // Parser termes de recherche
  const kitTerms = kitQuery.toLowerCase().split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0)
  const eliquidTerms = eliquidQuery ? eliquidQuery.toLowerCase().split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0) : []
  const eliquidBrandTerms = eliquidBrand ? eliquidBrand.toLowerCase().split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0) : []

  // Helpers - FIXED: parse comma-separated categories
  const isInCategory = (item: any, categorySearch: string): boolean => {
    if (!categorySearch) return true
    // Split by comma to support multiple categories (e.g., "10 ML,50 ML")
    const searchTerms = categorySearch.toLowerCase().split(',').map(t => t.trim()).filter(t => t.length > 0)
    const catName = (item.category_name || '').toLowerCase()
    const parentCatName = (item.parent_category_name || '').toLowerCase()
    const grandparentCatName = (item.grandparent_category_name || '').toLowerCase()
    // Return true if ANY search term matches ANY category level
    return searchTerms.some(term =>
      catName.includes(term) || parentCatName.includes(term) || grandparentCatName.includes(term)
    )
  }

  const matchesBrand = (item: any, brandTerms: string[]): boolean => {
    if (brandTerms.length === 0) return true
    const brandName = (item.brand_name || '').toLowerCase()
    const productName = (item.product_name || '').toLowerCase()
    return brandTerms.some((term: string) => brandName.includes(term) || productName.includes(term))
  }

  const isValidEliquid = (item: any): boolean => {
    if (eliquidTerms.length > 0) {
      const productName = (item.product_name || '').toLowerCase()
      const matchesName = eliquidTerms.some((term: string) => productName.includes(term))
      if (!matchesName) return false
    }
    if (eliquidBrandTerms.length > 0) {
      if (!matchesBrand(item, eliquidBrandTerms)) return false
    }
    if (eliquidCategory) {
      if (!isInCategory(item, eliquidCategory)) return false
    }
    // Filtre par variante (taux de nicotine)
    if (variantFilter) {
      const variantName = (item.variant_name || '').toLowerCase()
      const sizeName = (item.size_name || '').toLowerCase()
      const filterLower = variantFilter.toLowerCase()
      const matchesVariant = variantName.includes(filterLower) || sizeName.includes(filterLower)
      if (!matchesVariant) return false
    }
    return true
  }

  // Grouper par ticket
  const ticketItems: Record<number, any[]> = {}
  filteredItems.forEach((item: any) => {
    const saleId = item.hiboutik_sale_id
    if (!saleId) return
    if (!ticketItems[saleId]) {
      ticketItems[saleId] = []
    }
    ticketItems[saleId].push(item)
  })

  // Trouver combos
  const comboTickets: any[] = []

  // Helper: vérifie si un produit est un vrai kit (pas une cartouche)
  const isRealKit = (item: any): boolean => {
    const productName = (item.product_name || '').toLowerCase()
    // Exclure les cartouches du comptage des kits
    if (productName.includes('cartouche')) return false
    return kitTerms.some((term: string) => productName.includes(term))
  }

  Object.entries(ticketItems).forEach(([saleId, items]) => {
    const hasKit = items.some((item: any) => isRealKit(item))

    const hasEliquid = items.some((item: any) => isValidEliquid(item))

    if (hasKit && hasEliquid) {
      const firstItem = items[0]
      const kits = items.filter((item: any) => isRealKit(item))
      const eliquids = items.filter((item: any) => isValidEliquid(item))

      comboTickets.push({
        hiboutik_sale_id: parseInt(saleId),
        vendor_id: firstItem.vendor_id,
        vendor_name: normalizeVendorName(firstItem.vendor_name),
        store_id: firstItem.store_id,
        store_name: firstItem.store_name,
        sale_date: firstItem.sale_date,
        kit_count: kits.reduce((sum: number, k: any) => sum + (k.quantity || 1), 0),
        eliquid_count: eliquids.reduce((sum: number, e: any) => sum + (e.quantity || 1), 0),
        kit_products: [...new Set(kits.map((k: any) => k.product_name))],
        eliquid_products: [...new Set(eliquids.map((e: any) => e.product_name))],
        eliquid_categories: [...new Set(eliquids.map((e: any) => e.category_name).filter(Boolean))]
      })
    }
  })

  console.log(`[combo_challenge] Found ${comboTickets.length} combo tickets`)

  // Agréger par vendeur
  const vendorStats: Record<number, any> = {}
  comboTickets.forEach((ticket: any) => {
    const vid = ticket.vendor_id
    if (!vendorStats[vid]) {
      vendorStats[vid] = {
        vendor_id: vid,
        vendor_name: ticket.vendor_name,
        store_name: ticket.store_name,
        store_id: ticket.store_id,
        combo_count: 0,
        total_kits: 0,
        total_eliquids: 0,
        tickets: [],
        eliquid_categories_sold: new Set()
      }
    }
    vendorStats[vid].combo_count += 1
    vendorStats[vid].total_kits += ticket.kit_count
    vendorStats[vid].total_eliquids += ticket.eliquid_count
    vendorStats[vid].tickets.push({
      hiboutik_sale_id: ticket.hiboutik_sale_id,
      sale_date: ticket.sale_date,
      kit_products: ticket.kit_products,
      eliquid_products: ticket.eliquid_products
    })
    ticket.eliquid_categories.forEach((cat: string) => vendorStats[vid].eliquid_categories_sold.add(cat))
  })

  // Créer classement
  const rankings = Object.values(vendorStats)
    .sort((a: any, b: any) => b.combo_count - a.combo_count)
    .slice(0, limit)
    .map((v: any, index: number) => ({
      rank: index + 1,
      vendor_id: v.vendor_id,
      vendor_name: v.vendor_name,
      store_name: v.store_name,
      store_id: v.store_id,
      combo_count: v.combo_count,
      total_kits: v.total_kits,
      total_eliquids: v.total_eliquids,
      recent_combos: v.tickets.slice(0, 5)
    }))

  const totalCombos = rankings.reduce((sum, v) => sum + v.combo_count, 0)

  return {
    success: true,
    action: 'combo_challenge',
    version: VERSION,
    period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
    filters: {
      kit_query: kitQuery,
      eliquid_query: eliquidQuery || null,
      eliquid_brand: eliquidBrand || null,
      eliquid_category: eliquidCategory || null,
      variant_filter: variantFilter || null,
      include_category_percent: includeCategoryPercent,
      kit_terms: kitTerms,
      eliquid_terms: eliquidTerms.length > 0 ? eliquidTerms : null,
      store_id: params.store_id || null
    },
    data: {
      summary: {
        total_vendors: rankings.length,
        total_combos: totalCombos,
        leader: rankings[0] || null
      },
      rankings: rankings
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: allItems.length,
      tickets_analyzed: Object.keys(ticketItems).length,
      combo_tickets_found: comboTickets.length
    }
  }
}
