/**
 * Action: dashboard
 * Dashboard global avec Z reports + ventes temps réel
 * Version DENORMALISEE - utilise uniquement sale_items
 */

import { fetchAllRows } from '../../_shared/pagination.ts'
import { STORE_NAMES, TVA_RATE } from '../../_shared/constants.ts'
import { calculateHT, type DisplayMode } from '../../_shared/pricing.ts'
import type { AnalyticsResult, ExecutionContext } from '../types.ts'

const VERSION = '2.3-pagination-fix'

export async function handleDashboard(context: ExecutionContext): Promise<AnalyticsResult> {
  const { supabase, params, period } = context

  // 1. Récupérer les Z Reports
  let zReportsQuery = supabase
    .from('daily_z_reports')
    .select(`
      id, store_id, report_date,
      total_ttc, total_ht, sales_count,
      cash_total, card_total
    `)
    .gte('report_date', period.startDate)
    .lte('report_date', period.endDate)
    .order('report_date', { ascending: false })

  if (params.store_id) {
    zReportsQuery = zReportsQuery.eq('store_id', params.store_id)
  }

  const { data: zReports, error: zError } = await zReportsQuery

  if (zError) throw zError

  // 2. Récupérer les ventes temps réel DEPUIS SALE_ITEMS (utilise canonical_vendor)
  let itemsQuery = supabase
    .from('sale_items')
    .select('hiboutik_sale_id, canonical_vendor_id, canonical_vendor_name, store_id, store_name, total_line, sale_date, payment_method')
    .gte('sale_date', period.startDateTime)
    .lte('sale_date', period.endDateTime)

  if (params.store_id) {
    itemsQuery = itemsQuery.eq('store_id', params.store_id)
  }

  const saleItems = await fetchAllRows(itemsQuery.order('id'))

  // 3. Agréger les items par vente unique (utilise canonical_vendor)
  const salesMap = new Map<number, {
    hiboutik_sale_id: number,
    canonical_vendor_id: number | null,
    canonical_vendor_name: string | null,
    store_id: number,
    store_name: string,
    total: number,
    payment_method: string
  }>()

  saleItems.forEach(item => {
    const saleId = item.hiboutik_sale_id
    if (!saleId) return

    if (!salesMap.has(saleId)) {
      salesMap.set(saleId, {
        hiboutik_sale_id: saleId,
        canonical_vendor_id: item.canonical_vendor_id,
        canonical_vendor_name: item.canonical_vendor_name,
        store_id: item.store_id,
        store_name: item.store_name,
        total: 0,
        payment_method: item.payment_method
      })
    }
    salesMap.get(saleId)!.total += parseFloat(item.total_line || '0')
  })

  const sales = Array.from(salesMap.values())

  // 5. Agréger par magasin (Z Reports)
  const storeStats: Record<number, any> = {}

  for (const report of zReports || []) {
    const storeId = report.store_id
    if (!storeStats[storeId]) {
      storeStats[storeId] = {
        store_id: storeId,
        store_name: STORE_NAMES[storeId] || `Magasin ${storeId}`,
        z_reports: {
          total_ttc: 0,
          total_ht: 0,
          sales_count: 0,
          cash_total: 0,
          card_total: 0,
          days_reported: 0
        },
        real_time: {
          total_ttc: 0,
          sales_count: 0
        }
      }
    }

    const stats = storeStats[storeId].z_reports
    stats.total_ttc += report.total_ttc || 0
    stats.total_ht += report.total_ht || 0
    stats.sales_count += report.sales_count || 0
    stats.cash_total += report.cash_total || 0
    stats.card_total += report.card_total || 0
    stats.days_reported += 1
  }

  // 6. Ajouter les ventes temps réel
  for (const sale of sales) {
    const storeId = sale.store_id
    if (!storeId) continue

    if (!storeStats[storeId]) {
      storeStats[storeId] = {
        store_id: storeId,
        store_name: sale.store_name || STORE_NAMES[storeId] || `Magasin ${storeId}`,
        z_reports: {
          total_ttc: 0,
          total_ht: 0,
          sales_count: 0,
          cash_total: 0,
          card_total: 0,
          days_reported: 0
        },
        real_time: {
          total_ttc: 0,
          sales_count: 0
        }
      }
    }

    storeStats[storeId].real_time.total_ttc += sale.total
    storeStats[storeId].real_time.sales_count += 1
  }

  // 7. Agréger par vendeur canonique (temps réel) - utilise canonical_vendor_id
  const vendorStats: Record<number, any> = {}

  for (const sale of sales) {
    if (!sale.canonical_vendor_id) continue

    const vendorName = sale.canonical_vendor_name || `Vendeur ${sale.canonical_vendor_id}`

    if (!vendorStats[sale.canonical_vendor_id]) {
      vendorStats[sale.canonical_vendor_id] = {
        vendor_id: sale.canonical_vendor_id,
        vendor_name: vendorName,
        total_revenue: 0,
        total_transactions: 0,
        avg_basket: 0
      }
    }

    vendorStats[sale.canonical_vendor_id].total_revenue += sale.total
    vendorStats[sale.canonical_vendor_id].total_transactions += 1
  }

  // Calculer le panier moyen et trier
  const topVendors = Object.values(vendorStats)
    .map((v: any) => ({
      ...v,
      total_revenue: parseFloat(v.total_revenue.toFixed(2)),
      avg_basket: v.total_transactions > 0
        ? parseFloat((v.total_revenue / v.total_transactions).toFixed(2))
        : 0
    }))
    .sort((a: any, b: any) => b.total_revenue - a.total_revenue)
    .slice(0, params.limit || 10)
    .map((v: any, index: number) => ({ ...v, rank: index + 1 }))

  // 8. Totaux globaux
  const display = (params.display as DisplayMode) || 'ttc'
  const stores = Object.values(storeStats).sort((a: any, b: any) =>
    b.z_reports.total_ttc - a.z_reports.total_ttc
  )

  const totalZReports = {
    total_ttc: stores.reduce((sum, s: any) => sum + s.z_reports.total_ttc, 0),
    total_ht: stores.reduce((sum, s: any) => sum + s.z_reports.total_ht, 0),
    sales_count: stores.reduce((sum, s: any) => sum + s.z_reports.sales_count, 0),
    cash_total: stores.reduce((sum, s: any) => sum + s.z_reports.cash_total, 0),
    card_total: stores.reduce((sum, s: any) => sum + s.z_reports.card_total, 0)
  }

  const totalRealTime = {
    total_ttc: stores.reduce((sum, s: any) => sum + s.real_time.total_ttc, 0),
    sales_count: stores.reduce((sum, s: any) => sum + s.real_time.sales_count, 0)
  }

  // Différence Z reports vs Real-time (pour détecter les écarts)
  const syncStatus = {
    z_reports_total: parseFloat(totalZReports.total_ttc.toFixed(2)),
    real_time_total: parseFloat(totalRealTime.total_ttc.toFixed(2)),
    difference: parseFloat((totalRealTime.total_ttc - totalZReports.total_ttc).toFixed(2)),
    in_sync: Math.abs(totalRealTime.total_ttc - totalZReports.total_ttc) < 1
  }

  return {
    success: true,
    action: 'dashboard',
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
        // Montants selon display mode
        ...(display === 'both' ? {
          total_ttc: parseFloat(totalZReports.total_ttc.toFixed(2)),
          total_ht: parseFloat(totalZReports.total_ht.toFixed(2))
        } : display === 'ht' ? {
          total: parseFloat(totalZReports.total_ht.toFixed(2))
        } : {
          total: parseFloat(totalZReports.total_ttc.toFixed(2))
        }),
        display_mode: display,
        total_sales: totalZReports.sales_count,
        total_stores: stores.length,
        total_vendors: topVendors.length,
        payment_breakdown: {
          cash: parseFloat(totalZReports.cash_total.toFixed(2)),
          card: parseFloat(totalZReports.card_total.toFixed(2)),
          cash_percent: totalZReports.total_ttc > 0
            ? parseFloat((totalZReports.cash_total / totalZReports.total_ttc * 100).toFixed(2))
            : 0,
          card_percent: totalZReports.total_ttc > 0
            ? parseFloat((totalZReports.card_total / totalZReports.total_ttc * 100).toFixed(2))
            : 0
        }
      },
      by_store: stores.map((s: any) => ({
        store_id: s.store_id,
        store_name: s.store_name,
        z_reports: {
          ...s.z_reports,
          total_ttc: parseFloat(s.z_reports.total_ttc.toFixed(2)),
          total_ht: parseFloat(s.z_reports.total_ht.toFixed(2)),
          cash_total: parseFloat(s.z_reports.cash_total.toFixed(2)),
          card_total: parseFloat(s.z_reports.card_total.toFixed(2))
        },
        real_time: {
          ...s.real_time,
          total_ttc: parseFloat(s.real_time.total_ttc.toFixed(2))
        }
      })),
      top_vendors: topVendors,
      sync_status: syncStatus
    },
    metadata: {
      generated_at: new Date().toISOString(),
      rows_fetched: (zReports?.length || 0) + saleItems.length,
      denormalized: true
    }
  }
}
