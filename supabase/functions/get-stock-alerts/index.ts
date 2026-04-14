// ============================================
// EDGE FUNCTION: get-stock-alerts
// Description: Alertes de rupture de stock par magasin
// Version: 3.0 - DENORMALISEE: utilise sale_items directement (plus de JOIN sales)
// ============================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // V2.1: Utiliser SERVICE_ROLE_KEY pour bypasser RLS et accéder à tous les magasins
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const url = new URL(req.url)
    const storeId = url.searchParams.get('store_id')
    const severity = url.searchParams.get('severity') || 'all' // all, critical, warning
    const limit = parseInt(url.searchParams.get('limit') || '50')

    // ============================================
    // 1. RÉCUPÉRER LES ALERTES STOCK
    // V2.2: Récupérer TOUS les stocks en alerte, filtrer après
    // ============================================
    let stockQuery = supabaseClient
      .from('stock')
      .select(`
        id,
        store_id,
        available_stock,
        stock_alert_threshold,
        is_below_threshold,
        updated_at,
        stores (
          id,
          name,
          city
        ),
        products!inner (
          id,
          hiboutik_product_id,
          product_name,
          product_brand,
          category_name,
          product_price_with_tax,
          is_virtual
        )
      `)
      .eq('is_below_threshold', true)
      .order('available_stock', { ascending: true })

    if (storeId) {
      stockQuery = stockQuery.eq('store_id', parseInt(storeId))
    }

    // V2.2: Récupérer les alertes avec pagination si nécessaire
    let stockAlerts: any[] = []
    let stockError: any = null

    if (storeId) {
      // Pour un magasin spécifique, pas besoin de pagination
      const result = await stockQuery.limit(limit * 2)
      stockAlerts = result.data || []
      stockError = result.error
    } else {
      // Pour tous les magasins, utiliser la pagination (Supabase limite à 1000 par défaut)
      const PAGE_SIZE = 1000
      let from = 0
      let hasMore = true

      while (hasMore) {
        const { data, error } = await stockQuery.range(from, from + PAGE_SIZE - 1)

        if (error) {
          stockError = error
          break
        }

        if (data && data.length > 0) {
          stockAlerts = stockAlerts.concat(data)
          from += PAGE_SIZE
          hasMore = data.length === PAGE_SIZE
        } else {
          hasMore = false
        }

        // Sécurité: limiter à 20000 max
        if (stockAlerts.length >= 20000) {
          hasMore = false
        }
      }
    }

    if (stockError) throw stockError

    // ============================================
    // ✅ FILTRER : Exclure produits virtuels et invalides
    // ============================================
    const validAlerts = (stockAlerts || []).filter(alert => {
      // Exclure si pas de store
      if (!alert.stores) {
        console.warn(`⚠️ Stock alert ${alert.id} has no store (store_id: ${alert.store_id})`)
        return false
      }
      // Exclure si pas de product
      if (!alert.products) {
        console.warn(`⚠️ Stock alert ${alert.id} has no product`)
        return false
      }
      // ✅ NOUVEAU: Exclure les produits virtuels
      if (alert.products.is_virtual === true) {
        return false
      }
      // Exclure les produits avec prix négatif (codes promo)
      if (alert.products.product_price_with_tax < 0) {
        return false
      }
      // Exclure par nom (fallback si is_virtual pas renseigné)
      const name = (alert.products.product_name || '').toLowerCase()
      if (
        name.includes('bon d\'achat') ||
        name.includes('cadeau') ||
        name.includes('offre') ||
        name.includes('parrainage') ||
        name.includes('livraison') ||
        name.includes('frais de port') ||
        name.includes('carte cadeau')
      ) {
        return false
      }
      return true
    })

    // V2.2: Distribuer le limit équitablement entre les magasins
    // Grouper par store_id
    const alertsByStore: { [key: number]: any[] } = {}
    validAlerts.forEach(alert => {
      const sid = alert.store_id
      if (!alertsByStore[sid]) alertsByStore[sid] = []
      alertsByStore[sid].push(alert)
    })

    // Prendre un nombre équitable par magasin (au moins limit/6, arrondi supérieur)
    const storeCount = Object.keys(alertsByStore).length
    const perStore = Math.ceil(limit / Math.max(storeCount, 1))

    let limitedAlerts: any[] = []
    Object.values(alertsByStore).forEach(storeAlerts => {
      // Trier par stock croissant (les plus critiques d'abord)
      storeAlerts.sort((a, b) => a.available_stock - b.available_stock)
      limitedAlerts.push(...storeAlerts.slice(0, perStore))
    })

    // Trier tous les résultats par stock croissant et limiter au total demandé
    limitedAlerts.sort((a, b) => a.available_stock - b.available_stock)
    limitedAlerts = limitedAlerts.slice(0, limit)

    // Si aucune alerte valide, retourner réponse vide
    if (limitedAlerts.length === 0) {
      return new Response(
        JSON.stringify({ 
          summary: { 
            total_alerts: 0, 
            by_severity: { critical: 0, high: 0, warning: 0, low: 0 }, 
            by_store: {}, 
            recommendations: { immediate_action: 0, urgent_restock: 0 }
          },
          alerts: [],
          filters: { 
            store_id: storeId ? parseInt(storeId) : null, 
            severity, 
            limit 
          },
          metadata: { 
            generated_at: new Date().toISOString(), 
            total_stores_checked: 0,
            note: 'Aucune alerte de stock (produits virtuels exclus)'
          }
        }),
        { 
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json' 
          } 
        }
      )
    }

    // ============================================
    // 2. CALCULER LA SÉVÉRITÉ ET JOURS RESTANTS
    // ============================================
    const enrichedAlerts = await Promise.all(
      limitedAlerts.map(async (alert) => {
        // Calculer les ventes moyennes des 30 derniers jours
        // V3.0: Utilise sale_items directement (dénormalisé, plus de JOIN avec sales)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const { data: recentSales } = await supabaseClient
          .from('sale_items')
          .select('quantity, hiboutik_product_id, store_id, sale_date')
          .eq('hiboutik_product_id', alert.products.hiboutik_product_id || alert.products.id)
          .eq('store_id', alert.store_id)
          .gte('sale_date', thirtyDaysAgo)

        const totalSold = recentSales?.reduce((sum, item) => sum + item.quantity, 0) || 0
        const avgDailySales = totalSold / 30

        let daysRemaining = null
        let severityLevel = 'warning'

        if (avgDailySales > 0) {
          daysRemaining = Math.floor(alert.available_stock / avgDailySales)
          
          if (daysRemaining <= 3) {
            severityLevel = 'critical'
          } else if (daysRemaining <= 7) {
            severityLevel = 'high'
          } else {
            severityLevel = 'warning'
          }
        } else {
          // Pas de ventes récentes, faible priorité
          severityLevel = 'low'
          daysRemaining = 999
        }

        // Stock critique si < 5 unités ET ventes récentes
        if (alert.available_stock < 5 && totalSold > 0) {
          severityLevel = 'critical'
        }

        return {
          product_id: alert.products.id,
          product_name: alert.products.product_name,
          product_brand: alert.products.product_brand,
          category: alert.products.category_name,
          price: alert.products.product_price_with_tax,
          store: {
            id: alert.stores.id,
            name: alert.stores.name,
            city: alert.stores.city
          },
          stock: {
            available: alert.available_stock,
            threshold: alert.stock_alert_threshold,
            last_updated: alert.updated_at
          },
          analytics: {
            avg_daily_sales: parseFloat(avgDailySales.toFixed(2)),
            total_sold_last_30_days: totalSold,
            estimated_days_remaining: daysRemaining,
            severity: severityLevel
          }
        }
      })
    )

    // ============================================
    // 3. FILTRER PAR SÉVÉRITÉ SI DEMANDÉ
    // ============================================
    let filteredAlerts = enrichedAlerts

    if (severity !== 'all') {
      filteredAlerts = enrichedAlerts.filter(alert => {
        if (severity === 'critical') {
          return alert.analytics.severity === 'critical'
        } else if (severity === 'warning') {
          return alert.analytics.severity === 'critical' || alert.analytics.severity === 'high'
        }
        return true
      })
    }

    // Trier par sévérité puis par jours restants
    const severityOrder = { critical: 0, high: 1, warning: 2, low: 3 }
    filteredAlerts.sort((a, b) => {
      const severityDiff = severityOrder[a.analytics.severity] - severityOrder[b.analytics.severity]
      if (severityDiff !== 0) return severityDiff
      return a.analytics.estimated_days_remaining - b.analytics.estimated_days_remaining
    })

    // ============================================
    // 4. STATISTIQUES GLOBALES
    // ============================================
    const summary = {
      total_alerts: filteredAlerts.length,
      by_severity: {
        critical: filteredAlerts.filter(a => a.analytics.severity === 'critical').length,
        high: filteredAlerts.filter(a => a.analytics.severity === 'high').length,
        warning: filteredAlerts.filter(a => a.analytics.severity === 'warning').length,
        low: filteredAlerts.filter(a => a.analytics.severity === 'low').length
      },
      by_store: filteredAlerts.reduce((acc, alert) => {
        const storeName = alert.store.name
        acc[storeName] = (acc[storeName] || 0) + 1
        return acc
      }, {}),
      recommendations: {
        immediate_action: filteredAlerts.filter(a => 
          a.analytics.severity === 'critical' && a.analytics.estimated_days_remaining <= 3
        ).length,
        urgent_restock: filteredAlerts.filter(a => 
          a.analytics.estimated_days_remaining <= 7
        ).length
      }
    }

    // ============================================
    // RÉPONSE FINALE
    // ============================================
    const response = {
      summary,
      alerts: filteredAlerts,
      filters: {
        store_id: storeId ? parseInt(storeId) : null,
        severity,
        limit
      },
      metadata: {
        generated_at: new Date().toISOString(),
        total_stores_checked: storeId ? 1 : new Set(filteredAlerts.map(a => a.store.id)).size,
        virtual_products_excluded: true,
        debug: {
          fetched_from_db: stockAlerts?.length || 0,
          after_filter: validAlerts.length,
          stores_in_fetch: Object.keys(alertsByStore).length,
          per_store_limit: perStore
        }
      }
    }

    return new Response(
      JSON.stringify(response),
      { 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    )

  } catch (error) {
    console.error('Error in get-stock-alerts:', error)
    const errorId = crypto.randomUUID().slice(0, 8)
    return new Response(
      JSON.stringify({
        error: 'Erreur interne du serveur',
        error_id: errorId
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 500
      }
    )
  }
})