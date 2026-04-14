/**
 * ============================================
 * EDGE FUNCTION: unified-analytics
 * Description: Consolidated analytics edge function
 * Version: 3.7 - With integrated challenges (migrated from get-product-challenge-ranking)
 *
 * Available Actions (22):
 *
 * BASE:
 * - dashboard: Global dashboard (Z reports + real-time)
 * - vendor_details: Specific vendor details
 * - vendor_ranking: All vendors ranking
 * - category_sales: Sales by category
 * - product_performance: Product performance
 * - customer_acquisition: New customers (first purchase in period)
 * - cross_analysis: Advanced cross-analysis
 *
 * CHALLENGES:
 * - product_challenge: Vendor challenge by product/brand
 * - team_challenge: Team revenue challenge with store objectives
 * - combo_challenge: Kit + e-liquid in same transaction
 *
 * REAL-TIME:
 * - realtime_sales: Sales by interval (15min, 1h) + historical comparison
 * - velocity_products: Fast-selling products
 *
 * ANOMALIES:
 * - anomaly_detection: Anomaly detection (products, vendors, categories)
 * - vendors_underperforming: Underperforming vendors vs history/team
 *
 * ADVANCED PRODUCTS:
 * - products_margin: Most profitable products (margin)
 * - products_declining: Declining products vs previous period
 * - product_rotation: Product rotation rate
 * - vendors_high_margin: Vendors on high-margin products
 *
 * BENCHMARKS:
 * - vendor_benchmark: Complete vendor benchmarking
 * - comparative: Multi-entity comparisons
 *
 * ADVANCED ANALYSES:
 * - discount_analysis: Discount correlation/volume sold
 * - trend_analysis: Period trends (daily/weekly/monthly)
 * - brand_share: Brand market share
 * ============================================
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

import { handleCors, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { safeErrorResponse } from '../_shared/errors.ts'
import { checkRateLimit, getClientIp, rateLimitResponse } from '../_shared/rate-limiter.ts'
import { calculatePeriod, calculatePreviousPeriod } from '../_shared/dates.ts'
import { DEFAULT_CONFIG } from '../_shared/constants.ts'

import type { AnalyticsAction, AnalyticsResult, ExecutionContext, CommonParams } from './types.ts'

// Import des actions de base
import { handleDashboard } from './actions/dashboard.ts'
import { handleVendorDetails, handleVendorRanking } from './actions/vendor.ts'
import { handleCategorySales } from './actions/category.ts'
import { handleProductPerformance } from './actions/product.ts'
import { handleCrossAnalysis } from './actions/cross-analysis.ts'

// Import des nouvelles actions
import { handleRealtimeSales, handleVelocityProducts } from './actions/realtime.ts'
import { handleAnomalyDetection, handleVendorsUnderperforming } from './actions/anomaly.ts'
import { handleProductsMargin, handleProductsDeclining, handleProductRotation, handleVendorsHighMargin } from './actions/margin.ts'
import { handleVendorBenchmark } from './actions/benchmark.ts'
import { handleDiscountAnalysis, handleTrendAnalysis, handleBrandShare } from './actions/advanced.ts'
import { handleCustomerAcquisition } from './actions/customer.ts'
import { handleProductChallenge, handleTeamChallenge, handleComboChallenge } from './actions/challenge.ts'

const VERSION = '3.7.2-challenges-enabled'

serve(async (req) => {
  // Gestion CORS
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const startTime = Date.now()

  // Rate limiting
  const rateLimit = await checkRateLimit('unified-analytics', getClientIp(req))
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds || 60)
  }

  try {
    // Client Supabase avec SERVICE_ROLE pour bypasser RLS
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Parser les paramètres
    const url = new URL(req.url)
    const params = parseParams(url.searchParams)

    // Action requise
    const action = url.searchParams.get('action') as AnalyticsAction
    if (!action) {
      return errorResponse('Parameter "action" required. Actions: dashboard, vendor_details, vendor_ranking, category_sales, product_performance, customer_acquisition, cross_analysis, product_challenge, team_challenge, combo_challenge, realtime_sales, velocity_products, anomaly_detection, vendors_underperforming, products_margin, products_declining, product_rotation, vendors_high_margin, vendor_benchmark, discount_analysis, trend_analysis, brand_share')
    }

    // Calculer la période
    const period = calculatePeriod(params.start_date, params.end_date)
    const previousPeriod = params.include_previous_period
      ? calculatePreviousPeriod(period)
      : undefined

    // Contexte d'exécution
    const context: ExecutionContext = {
      supabase,
      params,
      period,
      previousPeriod,
      startTime
    }

    console.log(`[unified-analytics] Action: ${action}, Period: ${period.startDate} -> ${period.endDate} (ExecutionContext initialized)`)

    // Router vers l'action appropriée
    let result: AnalyticsResult

    switch (action) {
      case 'dashboard':
        result = await handleDashboard(context)
        break

      case 'vendor_details':
        result = await handleVendorDetails(context)
        break

      case 'vendor_ranking':
        result = await handleVendorRanking(context)
        break

      case 'category_sales':
        result = await handleCategorySales(context)
        break

      case 'product_performance':
        result = await handleProductPerformance(context)
        break

      case 'customer_acquisition':
        result = await handleCustomerAcquisition(context)
        break

      case 'cross_analysis':
        result = await handleCrossAnalysis(context)
        break

      // ============================================
      // CHALLENGES
      // ============================================
      case 'product_challenge':
        result = await handleProductChallenge(context)
        break

      case 'team_challenge':
        result = await handleTeamChallenge(context)
        break

      case 'combo_challenge':
        result = await handleComboChallenge(context)
        break

      // ============================================
      // TEMPS RÉEL
      // ============================================
      case 'realtime_sales':
        result = await handleRealtimeSales(context)
        break

      case 'velocity_products':
        result = await handleVelocityProducts(context)
        break

      // ============================================
      // ANOMALIES
      // ============================================
      case 'anomaly_detection':
        result = await handleAnomalyDetection(context)
        break

      case 'vendors_underperforming':
        result = await handleVendorsUnderperforming(context)
        break

      // ============================================
      // PRODUITS AVANCÉS
      // ============================================
      case 'products_margin':
        result = await handleProductsMargin(context)
        break

      case 'products_declining':
        result = await handleProductsDeclining(context)
        break

      case 'product_rotation':
        result = await handleProductRotation(context)
        break

      case 'vendors_high_margin':
        result = await handleVendorsHighMargin(context)
        break

      // ============================================
      // BENCHMARKS
      // ============================================
      case 'vendor_benchmark':
        result = await handleVendorBenchmark(context)
        break

      case 'comparative':
        // TODO: Implémenter comparaisons multi-entités
        result = {
          success: false,
          action,
          version: VERSION,
          period: { start_date: period.startDate, end_date: period.endDate, days: period.days },
          data: null,
          metadata: { generated_at: new Date().toISOString(), execution_time_ms: Date.now() - startTime },
          debug: { message: `Action "${action}" en cours d'implémentation` }
        }
        break

      // ============================================
      // ANALYSES AVANCÉES
      // ============================================
      case 'discount_analysis':
        result = await handleDiscountAnalysis(context)
        break

      case 'trend_analysis':
        result = await handleTrendAnalysis(context)
        break

      case 'brand_share':
        result = await handleBrandShare(context)
        break

      default:
        return errorResponse(`Action inconnue: "${action}"`, 400)
    }

    // Ajouter les métadonnées d'exécution
    result.metadata.execution_time_ms = Date.now() - startTime

    return jsonResponse(result)

  } catch (error: any) {
    return safeErrorResponse(error, 'unified-analytics')
  }
})

/**
 * Parse URL parameters
 */
function parseParams(searchParams: URLSearchParams): CommonParams & Record<string, any> {
  const params: CommonParams & Record<string, any> = {}

  // Common parameters
  params.start_date = searchParams.get('start_date') || undefined
  params.end_date = searchParams.get('end_date') || undefined
  params.limit = parseInt(searchParams.get('limit') || String(DEFAULT_CONFIG.limit)) || DEFAULT_CONFIG.limit
  params.debug = searchParams.get('debug') === 'true'
  params.include_previous_period = searchParams.get('include_previous_period') !== 'false'

  // Store filter
  const storeId = searchParams.get('store_id')
  if (storeId && storeId !== '0' && storeId !== '') {
    params.store_id = parseInt(storeId)
  }

  // API source
  const apiSource = searchParams.get('api_source')
  if (apiSource === 'main' || apiSource === 'secondary') {
    params.api_source = apiSource
  }

  // Vendor params
  const vendorId = searchParams.get('vendor_id')
  if (vendorId && vendorId !== 'NaN' && vendorId !== 'null') {
    params.vendor_id = parseInt(vendorId)
  }
  params.vendor_name = searchParams.get('vendor_name') || undefined

  // Category params
  params.category_name = searchParams.get('category_name') || undefined
  params.parent_category_name = searchParams.get('parent_category_name') || undefined
  const canonicalCategoryId = searchParams.get('canonical_category_id')
  if (canonicalCategoryId) {
    params.canonical_category_id = parseInt(canonicalCategoryId)
  }
  params.canonical_category_name = searchParams.get('canonical_category_name') || undefined

  // Product params
  params.product_query = searchParams.get('product_query') || undefined
  params.brand_name = searchParams.get('brand_name') || undefined
  const productIds = searchParams.get('product_ids')
  if (productIds) {
    params.product_ids = productIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
  }
  // Single product filters
  const productId = searchParams.get('product_id')
  if (productId) {
    params.product_id = parseInt(productId)
  }
  params.product_name = searchParams.get('product_name') || undefined

  // Mode params
  params.mode = searchParams.get('mode') || undefined

  // Include options
  params.include_daily = searchParams.get('include_daily') === 'true'
  params.include_categories = searchParams.get('include_categories') === 'true'
  params.include_products = searchParams.get('include_products') !== 'false'
  params.include_brands = searchParams.get('include_brands') === 'true'
  params.include_payment_breakdown = searchParams.get('include_payment_breakdown') !== 'false'
  params.include_breakdown = searchParams.get('include_breakdown') === 'true'
  params.include_analytics360 = searchParams.get('include_analytics360') !== 'false' // Default: true

  // Cross-analysis params
  params.compare_with = searchParams.get('compare_with') || undefined
  const targetValue = searchParams.get('target_value')
  if (targetValue) {
    params.target_value = parseFloat(targetValue)
  }

  // Trend params
  params.granularity = searchParams.get('granularity') || 'daily'
  params.compare_previous = searchParams.get('compare_previous') !== 'false'

  // Comparative params
  params.compare_type = searchParams.get('compare_type') || undefined
  const entityIds = searchParams.get('entity_ids')
  if (entityIds) {
    params.entity_ids = entityIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
  }
  const entityNames = searchParams.get('entity_names')
  if (entityNames) {
    params.entity_names = entityNames.split(',').map(n => n.trim())
  }

  // Benchmark params
  params.benchmark_against = searchParams.get('benchmark_against') || 'team'
  const metrics = searchParams.get('metrics')
  if (metrics) {
    params.metrics = metrics.split(',').map(m => m.trim())
  }

  // Brand share
  params.include_competitors = searchParams.get('include_competitors') === 'true'

  // Challenge params
  params.brand_query = searchParams.get('brand_query') || undefined
  const minQty = searchParams.get('min_qty')
  if (minQty) {
    params.min_qty = parseInt(minQty)
  }
  params.search_mode = searchParams.get('search_mode') || 'AND'
  params.normalize_quantities = searchParams.get('normalize_quantities') !== 'false'
  params.show_raw_quantities = searchParams.get('show_raw_quantities') === 'true'
  params.include_category_percent = searchParams.get('include_category_percent') === 'true'
  params.sort_by_category_percent = searchParams.get('sort_by_category_percent') === 'true'
  params.compare_category_name = searchParams.get('compare_category_name') || undefined
  params.exclude_virtual = searchParams.get('exclude_virtual') !== 'false'

  // Team challenge params
  const targetAmount = searchParams.get('target_amount')
  if (targetAmount) {
    params.target_amount = parseFloat(targetAmount)
  }
  params.target_per_store = searchParams.get('target_per_store') || undefined
  const bonusPercent = searchParams.get('bonus_percent')
  if (bonusPercent) {
    params.bonus_percent = parseFloat(bonusPercent)
  }
  const minVendorsForBonus = searchParams.get('min_vendors_for_bonus')
  if (minVendorsForBonus) {
    params.min_vendors_for_bonus = parseInt(minVendorsForBonus)
  }

  // Combo challenge params
  params.kit_query = searchParams.get('kit_query') || undefined
  params.eliquid_query = searchParams.get('eliquid_query') || undefined
  params.eliquid_brand = searchParams.get('eliquid_brand') || undefined
  params.eliquid_category = searchParams.get('eliquid_category') || undefined
  params.variant_filter = searchParams.get('variant_filter') || undefined // ex: "20mg", "20", "salt"

  // Display mode: 'ttc' (default), 'ht', or 'both'
  const display = searchParams.get('display')
  if (display === 'ht' || display === 'ttc' || display === 'both') {
    params.display = display
  } else {
    params.display = 'ttc' // Default: TTC
  }

  return params
}
