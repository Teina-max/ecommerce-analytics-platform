/**
 * Edge Function: sync-customers
 * Version: 2.0
 *
 * Synchronise les clients depuis Hiboutik vers Supabase
 * NOUVEAU: Récupère la vraie date de création du client (addresses[0].creation_date)
 *
 * Modes:
 * - full: Import tous les clients avec achats (depuis sale_items)
 * - batch: Import un batch de customer_ids spécifiques
 * - single: Import un seul client par ID
 * - resync: Re-synchronise tous les clients existants pour MAJ dates
 *
 * Usage:
 * GET /sync-customers?mode=full&api=both
 * GET /sync-customers?mode=single&customer_id=1234&api=main
 * GET /sync-customers?mode=resync&api=both (pour mettre à jour first_purchase_date)
 * POST /sync-customers?mode=batch (body: {customer_ids: [1,2,3], api_source: "main"})
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const VERSION = '2.1-sales-history'

// Configuration APIs
const APIS = {
  main: {
    url: Deno.env.get('HIBOUTIK_PRIMARY_API_URL') || 'https://your-store.hiboutik.com/api',
    user: Deno.env.get('HIBOUTIK_PRIMARY_API_USER') || '',
    key: Deno.env.get('HIBOUTIK_PRIMARY_API_KEY') || ''
  },
  secondary: {
    url: Deno.env.get('HIBOUTIK_SECONDARY_API_URL') || 'https://your-store-2.hiboutik.com/api',
    user: Deno.env.get('HIBOUTIK_SECONDARY_API_USER') || '',
    key: Deno.env.get('HIBOUTIK_SECONDARY_API_KEY') || ''
  }
}

interface HiboutikAddress {
  address_id: number
  creation_date: string  // "2022-10-06 12:02:10"
  first_name: string
  last_name: string
  email: string
  phone: string
}

interface HiboutikSale {
  sale_id: number
  created_at: string  // "2021-07-27 09:57:44" - Date de la vente
  completed_at: string
  store_id: number
  vendor_id: number
  total: string
}

interface HiboutikCustomer {
  customers_id: number
  first_name: string
  last_name: string
  company: string
  email: string
  phone: string
  country: string
  date_of_birth: string
  customers_code: string
  customers_ref_ext: string
  loyalty_points: number
  intial_loyalty_points: number
  store_credit: string
  prepaid_purchases: string
  last_order_date: string
  updated_at: string
  addresses?: HiboutikAddress[]
  sales?: HiboutikSale[]  // Historique complet des ventes - contient la vraie 1ère date d'achat
}

function parseDate(dateStr: string): string | null {
  if (!dateStr || dateStr === '0000-00-00') return null
  return dateStr
}

/**
 * Extrait la date du premier achat du client
 * Priorité 1: MIN(sales[].created_at) - date de la première vente réelle
 * Priorité 2: addresses[0].creation_date - fallback si pas de ventes
 */
function extractFirstPurchaseDate(c: HiboutikCustomer): string | null {
  // Priorité 1: Utiliser l'historique des ventes (plus fiable)
  if (c.sales && c.sales.length > 0) {
    // Trouver la vente la plus ancienne
    const firstSale = c.sales.reduce((oldest, sale) => {
      if (!oldest.created_at) return sale
      if (!sale.created_at) return oldest
      return sale.created_at < oldest.created_at ? sale : oldest
    }, c.sales[0])

    if (firstSale?.created_at) {
      // Format: "2021-07-27 09:57:44" -> "2021-07-27"
      return firstSale.created_at.split(' ')[0]
    }
  }

  // Priorité 2: Fallback vers addresses[0].creation_date (souvent vide)
  if (c.addresses && c.addresses.length > 0 && c.addresses[0].creation_date) {
    const creationDate = c.addresses[0].creation_date
    if (creationDate && creationDate !== '0000-00-00 00:00:00') {
      return creationDate.split(' ')[0]
    }
  }

  return null
}

function transformCustomer(c: HiboutikCustomer, apiSource: string) {
  const firstPurchaseDate = extractFirstPurchaseDate(c)

  return {
    hiboutik_customer_id: c.customers_id,
    api_source: apiSource,
    first_name: c.first_name?.trim() || null,
    last_name: c.last_name?.trim() || null,
    company: c.company?.trim() || null,
    email: c.email?.trim() || null,
    phone: c.phone?.trim() || null,
    country: c.country || 'FRA',
    date_of_birth: parseDate(c.date_of_birth),
    loyalty_points: c.loyalty_points || 0,
    initial_loyalty_points: c.intial_loyalty_points || 0,
    store_credit: parseFloat(c.store_credit) || 0,
    prepaid_purchases: parseFloat(c.prepaid_purchases) || 0,
    customers_code: c.customers_code?.trim() || null,
    customers_ref_ext: c.customers_ref_ext?.trim() || null,
    last_order_date: parseDate(c.last_order_date),
    // Date du 1er achat depuis l'historique Hiboutik (MIN sales[].created_at)
    first_purchase_date: firstPurchaseDate,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
}

async function fetchCustomerFromHiboutik(
  customerId: number,
  apiSource: 'main' | 'secondary'
): Promise<HiboutikCustomer | null> {
  const api = APIS[apiSource]
  const auth = btoa(`${api.user}:${api.key}`)

  try {
    const response = await fetch(`${api.url}/customer/${customerId}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    })

    if (!response.ok) {
      if (response.status === 404) return null
      console.error(`Hiboutik error for customer ${customerId}: ${response.status}`)
      return null
    }

    const data = await response.json()
    // L'API retourne un array avec un seul élément
    return Array.isArray(data) ? data[0] : data
  } catch (error) {
    console.error(`Error fetching customer ${customerId}:`, error)
    return null
  }
}

async function fetchCustomerBatch(
  customerIds: number[],
  apiSource: 'main' | 'secondary'
): Promise<HiboutikCustomer[]> {
  const results: HiboutikCustomer[] = []
  const batchSize = 10 // Paralléliser par groupes de 10

  for (let i = 0; i < customerIds.length; i += batchSize) {
    const batch = customerIds.slice(i, i + batchSize)
    const promises = batch.map(id => fetchCustomerFromHiboutik(id, apiSource))
    const batchResults = await Promise.all(promises)

    for (const customer of batchResults) {
      if (customer) results.push(customer)
    }

    // Rate limiting
    if (i + batchSize < customerIds.length) {
      await new Promise(r => setTimeout(r, 100))
    }
  }

  return results
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startTime = Date.now()

  try {
    const url = new URL(req.url)
    const mode = url.searchParams.get('mode') || 'full'
    const apiParam = url.searchParams.get('api') || 'both'
    const customerId = url.searchParams.get('customer_id')
    const limit = parseInt(url.searchParams.get('limit') || '500')
    const offset = parseInt(url.searchParams.get('offset') || '0')

    // Créer client Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const stats = {
      mode,
      api: apiParam,
      customers_fetched: 0,
      customers_inserted: 0,
      customers_updated: 0,
      errors: 0,
      duration_ms: 0
    }

    if (mode === 'single' && customerId) {
      // Mode single: importer un seul client
      const apiSource = apiParam === 'secondary' ? 'secondary' : 'main'
      const customer = await fetchCustomerFromHiboutik(parseInt(customerId), apiSource as 'main' | 'secondary')

      if (customer) {
        const transformed = transformCustomer(customer, apiSource)
        const { error } = await supabase
          .from('customers')
          .upsert(transformed, { onConflict: 'hiboutik_customer_id,api_source' })

        if (error) {
          stats.errors++
          console.error('Upsert error:', error)
        } else {
          stats.customers_inserted++
        }
        stats.customers_fetched = 1
      }

    } else if (mode === 'batch' && req.method === 'POST') {
      // Mode batch: importer une liste de customer_ids
      const body = await req.json()
      const customerIds: number[] = body.customer_ids || []
      const apiSource = (body.api_source || 'main') as 'main' | 'secondary'

      const customers = await fetchCustomerBatch(customerIds, apiSource)
      stats.customers_fetched = customers.length

      if (customers.length > 0) {
        const transformed = customers.map(c => transformCustomer(c, apiSource))
        const { error } = await supabase
          .from('customers')
          .upsert(transformed, { onConflict: 'hiboutik_customer_id,api_source' })

        if (error) {
          stats.errors++
          console.error('Batch upsert error:', error)
        } else {
          stats.customers_inserted = customers.length
        }
      }

    } else if (mode === 'full') {
      // Mode full: récupérer les customer_ids depuis sale_items et importer
      const apisToSync: ('main' | 'secondary')[] =
        apiParam === 'main' ? ['main'] :
        apiParam === 'secondary' ? ['secondary'] :
        ['main', 'secondary']

      for (const apiSource of apisToSync) {
        console.log(`Syncing customers for ${apiSource} API...`)

        // Récupérer les customer_ids uniques depuis sale_items
        const { data: customerData, error: fetchError } = await supabase
          .from('sale_items')
          .select('hiboutik_customer_id')
          .eq('api_source', apiSource)
          .gt('hiboutik_customer_id', 0)
          .order('hiboutik_customer_id')
          .range(offset, offset + limit - 1)

        if (fetchError) {
          console.error('Error fetching customer IDs:', fetchError)
          continue
        }

        // Dédupliquer
        const uniqueIds = [...new Set(customerData.map(r => r.hiboutik_customer_id))]
        console.log(`Found ${uniqueIds.length} unique customer IDs for ${apiSource}`)

        // Vérifier lesquels existent déjà
        const { data: existingCustomers } = await supabase
          .from('customers')
          .select('hiboutik_customer_id')
          .eq('api_source', apiSource)
          .in('hiboutik_customer_id', uniqueIds)

        const existingIds = new Set(existingCustomers?.map(c => c.hiboutik_customer_id) || [])
        const newIds = uniqueIds.filter(id => !existingIds.has(id))

        console.log(`${existingIds.size} already exist, ${newIds.length} to import`)

        // Importer les nouveaux clients
        if (newIds.length > 0) {
          const customers = await fetchCustomerBatch(newIds, apiSource)
          stats.customers_fetched += customers.length

          if (customers.length > 0) {
            const transformed = customers.map(c => transformCustomer(c, apiSource))

            // Insérer par batches de 100
            for (let i = 0; i < transformed.length; i += 100) {
              const batch = transformed.slice(i, i + 100)
              const { error } = await supabase
                .from('customers')
                .upsert(batch, { onConflict: 'hiboutik_customer_id,api_source' })

              if (error) {
                stats.errors++
                console.error('Batch insert error:', error)
              } else {
                stats.customers_inserted += batch.length
              }
            }
          }
        }
      }

    } else if (mode === 'resync') {
      // Mode resync: Re-synchroniser TOUS les clients existants pour MAJ first_purchase_date
      const apisToSync: ('main' | 'secondary')[] =
        apiParam === 'main' ? ['main'] :
        apiParam === 'secondary' ? ['secondary'] :
        ['main', 'secondary']

      for (const apiSource of apisToSync) {
        console.log(`Re-syncing ALL customers for ${apiSource} API...`)

        // Récupérer tous les customer_ids existants
        const { data: existingCustomers, error: fetchError } = await supabase
          .from('customers')
          .select('hiboutik_customer_id')
          .eq('api_source', apiSource)
          .range(offset, offset + limit - 1)

        if (fetchError) {
          console.error('Error fetching existing customers:', fetchError)
          continue
        }

        const customerIds = existingCustomers?.map(c => c.hiboutik_customer_id) || []
        console.log(`Found ${customerIds.length} customers to re-sync for ${apiSource}`)

        if (customerIds.length > 0) {
          const customers = await fetchCustomerBatch(customerIds, apiSource)
          stats.customers_fetched += customers.length

          if (customers.length > 0) {
            const transformed = customers.map(c => transformCustomer(c, apiSource))

            // Update par batches de 100
            for (let i = 0; i < transformed.length; i += 100) {
              const batch = transformed.slice(i, i + 100)
              const { error } = await supabase
                .from('customers')
                .upsert(batch, { onConflict: 'hiboutik_customer_id,api_source' })

              if (error) {
                stats.errors++
                console.error('Batch update error:', error)
              } else {
                stats.customers_updated += batch.length
              }
            }
          }
        }
      }
    }

    stats.duration_ms = Date.now() - startTime

    // Log sync
    await supabase.from('sync_logs').insert({
      sync_type: 'sync_customers',
      status: stats.errors > 0 ? 'partial' : 'success',
      records_synced: stats.customers_inserted,
      records_failed: stats.errors,
      duration_seconds: Math.round(stats.duration_ms / 1000),
      sync_metadata: stats
    })

    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      ...stats
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Error:', error)
    const errorId = crypto.randomUUID().slice(0, 8)
    return new Response(JSON.stringify({
      success: false,
      error: "Erreur interne du serveur",
      error_id: errorId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
