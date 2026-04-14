/**
 * Types partagés pour unified-analytics
 * Version: 1.0
 */

import { DatePeriod } from '../_shared/dates.ts'

/**
 * Actions disponibles dans unified-analytics
 */
export type AnalyticsAction =
  // Actions de base
  | 'dashboard'           // Dashboard global (Z reports + real-time)
  | 'vendor_details'      // Détails d'un vendeur spécifique
  | 'vendor_ranking'      // Classement de tous les vendeurs
  | 'category_sales'      // Ventes par catégorie
  | 'product_performance' // Performance produits
  | 'customer_acquisition'// Nouveaux clients (premier achat sur la période)
  | 'cross_analysis'      // Croisements avancés

  // Challenges
  | 'product_challenge'   // Challenge vendeurs par produit/marque
  | 'team_challenge'      // Challenge équipe CA avec objectifs
  | 'combo_challenge'     // Challenge kit + e-liquide

  // Temps réel
  | 'realtime_sales'      // Ventes en temps réel avec intervalles
  | 'velocity_products'   // Produits qui se vendent le plus rapidement

  // Anomalies
  | 'anomaly_detection'      // Détection anomalies (produits, vendeurs, catégories)
  | 'vendors_underperforming' // Vendeurs en sous-performance

  // Produits avancés
  | 'products_margin'     // Produits les plus rentables (marge)
  | 'products_declining'  // Produits en perte de vitesse
  | 'product_rotation'    // Taux de rotation par produit
  | 'vendors_high_margin' // Vendeurs sur produits haute marge

  // Benchmarks
  | 'vendor_benchmark'    // Benchmarking vendeurs complet
  | 'comparative'         // Comparaisons (marques, vendeurs)

  // Analyses avancées
  | 'discount_analysis'   // Corrélation remise/volume
  | 'trend_analysis'      // Tendances sur période
  | 'brand_share'         // Part de marché marque

/**
 * Type d'affichage des montants
 */
export type DisplayMode = 'ttc' | 'ht' | 'both'

/**
 * Paramètres communs à toutes les actions
 */
export interface CommonParams {
  // Période
  start_date?: string
  end_date?: string
  period?: DatePeriod

  // Filtres globaux
  store_id?: number
  api_source?: 'main' | 'secondary' | 'all'

  // Options
  limit?: number
  debug?: boolean
  include_previous_period?: boolean

  // Affichage montants: 'ttc' (défaut), 'ht', ou 'both'
  display?: DisplayMode
}

/**
 * Paramètres pour vendor_details
 */
export interface VendorDetailsParams extends CommonParams {
  vendor_id?: number
  vendor_name?: string
  include_daily?: boolean
  include_categories?: boolean
  include_products?: boolean
  include_payment_breakdown?: boolean
}

/**
 * Paramètres pour vendor_ranking
 */
export interface VendorRankingParams extends CommonParams {
  sort_by?: 'revenue' | 'transactions' | 'avg_basket' | 'evolution'
}

/**
 * Paramètres pour category_sales
 */
export interface CategorySalesParams extends CommonParams {
  category_name?: string
  category_id?: number
  parent_category_name?: string
  parent_category_id?: number
  canonical_category_id?: number
  canonical_category_name?: string
  vendor_id?: number
  vendor_name?: string
  include_products?: boolean
  include_brands?: boolean
}

/**
 * Paramètres pour product_performance
 */
export interface ProductPerformanceParams extends CommonParams {
  product_query?: string
  product_ids?: number[]
  brand_name?: string
  category_name?: string
  mode?: 'summary' | 'detailed' | 'top_sellers'
}

/**
 * Paramètres pour comparative
 */
export interface ComparativeParams extends CommonParams {
  compare_type?: 'vendors' | 'brands' | 'stores' | 'categories'
  entity_ids?: number[]
  entity_names?: string[]
}

/**
 * Paramètres pour vendor_benchmark
 */
export interface VendorBenchmarkParams extends CommonParams {
  vendor_id?: number
  vendor_name?: string
  benchmark_against?: 'team' | 'store' | 'all'
  metrics?: ('revenue' | 'transactions' | 'avg_basket' | 'categories')[]
}

/**
 * Paramètres pour cross_analysis (NOUVEAU)
 */
export interface CrossAnalysisParams extends CommonParams {
  // Dimensions à croiser
  vendor_id?: number
  vendor_name?: string
  category_name?: string
  canonical_category_id?: number
  brand_name?: string
  product_query?: string

  // Type de comparaison
  compare_with?: 'team_avg' | 'store_avg' | 'previous_period' | 'target'
  target_value?: number

  // Options
  include_breakdown?: boolean
}

/**
 * Paramètres pour trend_analysis (NOUVEAU)
 */
export interface TrendAnalysisParams extends CommonParams {
  // Entité à analyser
  vendor_id?: number
  vendor_name?: string
  category_name?: string
  brand_name?: string

  // Granularité
  granularity?: 'daily' | 'weekly' | 'monthly'
  compare_previous?: boolean
}

/**
 * Paramètres pour brand_share (NOUVEAU)
 */
export interface BrandShareParams extends CommonParams {
  brand_name: string
  category_name?: string
  parent_category_name?: string
  include_competitors?: boolean
}

/**
 * Union de tous les paramètres
 */
export type ActionParams =
  | VendorDetailsParams
  | VendorRankingParams
  | CategorySalesParams
  | ProductPerformanceParams
  | ComparativeParams
  | VendorBenchmarkParams
  | CrossAnalysisParams
  | TrendAnalysisParams
  | BrandShareParams

/**
 * Résultat standard
 */
export interface AnalyticsResult {
  success: boolean
  action: AnalyticsAction
  version: string
  period: {
    start_date: string
    end_date: string
    days: number
  }
  filters?: Record<string, any>
  data: any
  metadata: {
    generated_at: string
    execution_time_ms?: number
    rows_fetched?: number
    cache_used?: boolean
  }
  debug?: any
}

/**
 * Contexte d'exécution
 */
export interface ExecutionContext {
  supabase: any
  params: CommonParams
  period: DatePeriod
  previousPeriod?: DatePeriod
  startTime: number
}
