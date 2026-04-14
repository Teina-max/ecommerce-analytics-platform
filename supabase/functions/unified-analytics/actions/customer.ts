/**
 * Action: customer_acquisition
 * Analyse des nouveaux clients ayant effectué leur premier achat sur la période
 * Version: 3.4 - Utilise first_purchase_date depuis table customers (vraie date Hiboutik)
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '3.8-pagination-fix'

/**
 * Nouveaux clients basé sur first_purchase_date de la table customers
 *
 * Méthodologie V3 (avec vraies dates depuis historique ventes Hiboutik):
 * 1. Récupère TOUS les clients depuis la table customers avec leur first_purchase_date
 * 2. Un client est "nouveau" si son first_purchase_date tombe dans la période demandée
 * 3. Enrichit avec les stats de ventes depuis sale_items pour la période
 *
 * Note: first_purchase_date = MIN(sales[].created_at) depuis l'historique Hiboutik
 * C'est la vraie date du premier achat du client, pas calculée depuis sale_items locale
 */
export async function handleCustomerAcquisition(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period, previousPeriod } = context

  // 1. Récupérer TOUS les clients avec leur vraie date de 1er achat (first_purchase_date)
  // Utilise fetchAllRows pour dépasser la limite de 1000 lignes
  const customersQuery = supabase
    .from('customers')
    .select('id, hiboutik_customer_id, api_source, first_name, last_name, first_purchase_date, loyalty_points')
    .order('id')

  const allCustomers = await fetchAllRows(customersQuery, 1000, 10000)

  // 2. Filtrer les nouveaux clients (first_purchase_date dans la période demandée)
  const newCustomers = (allCustomers || []).filter(customer => {
    if (!customer.first_purchase_date) return false
    const purchaseDate = customer.first_purchase_date.split('T')[0]
    return purchaseDate >= period.startDate && purchaseDate <= period.endDate
  })

  // 3. Récupérer les ventes de la période pour enrichir avec les stats
  // IMPORTANT: Tri par sale_date ASC pour attribuer le vendeur de la PREMIÈRE vente chronologique
  let salesQuery = supabase
    .from('sale_items')
    .select('hiboutik_customer_id, api_source, store_id, store_name, canonical_vendor_id, canonical_vendor_name, total_line, hiboutik_sale_id, sale_date')
    .gt('hiboutik_customer_id', 0)
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)
    .order('sale_date', { ascending: true })
    .order('id')

  if (params.store_id) {
    salesQuery = salesQuery.eq('store_id', params.store_id)
  }

  const periodSales = await fetchAllRows(salesQuery, 1000, 50000)

  // 4. Créer un map pour les stats des nouveaux clients
  const newCustomerIds = new Set(newCustomers.map(c => `${c.hiboutik_customer_id}_${c.api_source}`))

  // Map customer key -> customer info
  const customerInfoMap = new Map(newCustomers.map(c => [
    `${c.hiboutik_customer_id}_${c.api_source}`,
    { first_name: c.first_name, last_name: c.last_name, first_purchase_date: c.first_purchase_date }
  ]))

  // Stats par nouveau client
  const customerStats: Map<string, {
    total_spent: number
    purchase_count: number
    first_store_id: number | null
    first_store_name: string | null
    first_vendor_id: number | null
    first_vendor_name: string | null
    first_sale_id: number | null
  }> = new Map()

  for (const sale of periodSales) {
    const key = `${sale.hiboutik_customer_id}_${sale.api_source}`
    if (!newCustomerIds.has(key)) continue

    if (!customerStats.has(key)) {
      customerStats.set(key, {
        total_spent: 0,
        purchase_count: 0,
        first_store_id: sale.store_id,
        first_store_name: sale.store_name,
        first_vendor_id: sale.canonical_vendor_id,
        first_vendor_name: sale.canonical_vendor_name,
        first_sale_id: sale.hiboutik_sale_id
      })
    }
    const stats = customerStats.get(key)!
    stats.total_spent += parseFloat(sale.total_line || '0')
    stats.purchase_count += 1
  }

  // 5. Agrégations par magasin (basé sur le premier magasin de vente dans la période)
  const byStore: Record<number, {
    store_id: number
    store_name: string
    new_customers: number
    total_revenue_from_new: number
  }> = {}

  // 6. Agrégations par vendeur
  const byVendor: Record<number, {
    vendor_id: number
    vendor_name: string
    new_customers: number
    total_revenue_from_new: number
  }> = {}

  // Parcourir les nouveaux clients et leurs stats
  for (const customer of newCustomers) {
    const key = `${customer.hiboutik_customer_id}_${customer.api_source}`
    const stats = customerStats.get(key)
    if (!stats) continue // Pas de ventes dans la période

    // Agrégation par magasin
    const storeId = stats.first_store_id
    if (storeId) {
      if (!byStore[storeId]) {
        byStore[storeId] = {
          store_id: storeId,
          store_name: stats.first_store_name || `Magasin ${storeId}`,
          new_customers: 0,
          total_revenue_from_new: 0
        }
      }
      byStore[storeId].new_customers += 1
      byStore[storeId].total_revenue_from_new += stats.total_spent
    }

    // Agrégation par vendeur
    const vendorId = stats.first_vendor_id
    if (vendorId) {
      if (!byVendor[vendorId]) {
        byVendor[vendorId] = {
          vendor_id: vendorId,
          vendor_name: stats.first_vendor_name || `Vendeur ${vendorId}`,
          new_customers: 0,
          total_revenue_from_new: 0
        }
      }
      byVendor[vendorId].new_customers += 1
      byVendor[vendorId].total_revenue_from_new += stats.total_spent
    }
  }

  // 7. Période précédente (comparaison) - basé sur first_purchase_date de la table customers
  let previousNewCustomers = 0
  if (previousPeriod) {
    previousNewCustomers = (allCustomers || []).filter(customer => {
      if (!customer.first_purchase_date) return false
      const purchaseDate = customer.first_purchase_date.split('T')[0]
      return purchaseDate >= previousPeriod.startDate && purchaseDate <= previousPeriod.endDate
    }).length
  }

  const evolution = previousNewCustomers > 0
    ? ((newCustomers.length - previousNewCustomers) / previousNewCustomers * 100)
    : (newCustomers.length > 0 ? 100 : 0)

  // 8. Calculer le CA total des nouveaux clients
  let totalRevenueFromNew = 0
  let totalPurchaseCount = 0
  for (const [, stats] of customerStats) {
    totalRevenueFromNew += stats.total_spent
    totalPurchaseCount += stats.purchase_count
  }

  const avgBasketNewCustomers = totalPurchaseCount > 0
    ? totalRevenueFromNew / totalPurchaseCount
    : 0

  // 9. Compter les clients avec date de création renseignée
  const customersWithDate = (allCustomers || []).filter(c => c.first_purchase_date).length
  const customersWithoutDate = (allCustomers || []).length - customersWithDate

  // 10. Format résultat
  const storeBreakdown = Object.values(byStore)
    .map(s => ({
      ...s,
      total_revenue_from_new: parseFloat(s.total_revenue_from_new.toFixed(2)),
      avg_revenue_per_new: s.new_customers > 0
        ? parseFloat((s.total_revenue_from_new / s.new_customers).toFixed(2))
        : 0
    }))
    .sort((a, b) => b.new_customers - a.new_customers)

  const vendorBreakdown = Object.values(byVendor)
    .map(v => ({
      ...v,
      total_revenue_from_new: parseFloat(v.total_revenue_from_new.toFixed(2)),
      avg_revenue_per_new: v.new_customers > 0
        ? parseFloat((v.total_revenue_from_new / v.new_customers).toFixed(2))
        : 0
    }))
    .sort((a, b) => b.new_customers - a.new_customers)
    .slice(0, params.limit || 20)

  // 11. NOUVEAU: Liste détaillée des clients avec leur vendeur (pour le challenge)
  const customerList: Array<{
    customer_name: string
    first_purchase_date: string
    vendor_name: string
    vendor_id: number
    store_name: string
    store_id: number
    total_spent: number
  }> = []

  for (const [key, stats] of customerStats) {
    const customerInfo = customerInfoMap.get(key)
    if (!customerInfo || !stats.first_vendor_id) continue

    customerList.push({
      customer_name: `${customerInfo.first_name || ''} ${customerInfo.last_name || ''}`.trim() || 'Client Anonyme',
      first_purchase_date: customerInfo.first_purchase_date?.split('T')[0] || '',
      vendor_name: stats.first_vendor_name || `Vendeur ${stats.first_vendor_id}`,
      vendor_id: stats.first_vendor_id,
      store_name: stats.first_store_name || '',
      store_id: stats.first_store_id || 0,
      total_spent: parseFloat(stats.total_spent.toFixed(2))
    })
  }

  // Trier par date puis par vendeur
  customerList.sort((a, b) => {
    const dateCompare = b.first_purchase_date.localeCompare(a.first_purchase_date)
    if (dateCompare !== 0) return dateCompare
    return a.vendor_name.localeCompare(b.vendor_name)
  })

  return {
    success: true,
    action: 'customer_acquisition',
    version: VERSION,
    period: {
      start_date: period.startDate,
      end_date: period.endDate,
      days: period.days
    },
    filters: {
      store_id: params.store_id || null
    },
    data: {
      summary: {
        total_customers_in_db: (allCustomers || []).length,
        customers_with_creation_date: customersWithDate,
        customers_without_creation_date: customersWithoutDate,
        new_customers: newCustomers.length,
        acquisition_rate: customersWithDate > 0
          ? parseFloat((newCustomers.length / customersWithDate * 100).toFixed(2))
          : 0,
        total_revenue_from_new: parseFloat(totalRevenueFromNew.toFixed(2)),
        avg_basket_new_customers: parseFloat(avgBasketNewCustomers.toFixed(2)),
        evolution: {
          previous_new_customers: previousNewCustomers,
          change_percent: parseFloat(evolution.toFixed(2))
        }
      },
      by_store: storeBreakdown,
      by_vendor: vendorBreakdown,
      // NOUVEAU: Liste détaillée des nouveaux clients avec le vendeur qui les a enregistrés
      new_customers_list: customerList.slice(0, params.limit || 50)
    },
    metadata: {
      generated_at: new Date().toISOString(),
      methodology: 'Uses first_purchase_date from customers table (MIN(sales[].created_at) from Hiboutik history)',
      data_quality: {
        pct_with_creation_date: customersWithDate > 0
          ? parseFloat((customersWithDate / (allCustomers || []).length * 100).toFixed(1))
          : 0
      }
    }
  }
}
