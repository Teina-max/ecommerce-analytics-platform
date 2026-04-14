import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createMainClient,
  createSecondaryClient,
  VENDOR_SECONDARY_TO_PRIMARY,
  type ApiSource,
} from "../_shared/hiboutik-client.ts";
import { verifyHiboutikHmac, safeErrorResponse } from "../_shared/errors.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VERSION = "3.15-security";

/**
 * Webhook Hiboutik pour les ventes - Version enrichie avec IDs internes
 *
 * v3.7-category-hierarchy:
 * - Récupère les line items EMBARQUÉS dans la réponse de GET /sales/{id}
 * - Enrichit chaque item avec product/category/brand depuis Hiboutik
 * - POST-TRAITEMENT: Enrichit parent_category_name et grandparent_category_name
 *   via lookup dans la table categories (hiboutik_category_id -> hierarchy)
 * - AUTO-ENRICHIT les clients inconnus depuis Hiboutik (avec vraie date de création)
 * - Insère directement dans sale_items (table dénormalisée)
 * - Capture les données au moment de la vente
 */

interface HiboutikSaleWebhook {
  sale_id: number;
  store_id: number;
  vendor_id: number;
  customer_id?: number;
  completed_at?: string;
  created_at?: string;
  total?: string;
  payment?: string;
  unique_sale_id?: string;
  currency?: string;
  [key: string]: any;
}

// Cache pour éviter les appels API répétés
const categoryCache = new Map<number, any>();
const brandCache = new Map<number, any>();
const customerCache = new Map<string, any>();
const categoryHierarchyCache = new Map<string, any>();
const productCache = new Map<string, any>();
const vendorMappingCache = new Map<string, any>(); // Cache vendor_mapping lookups

interface CategoryHierarchy {
  category_id: number | null;
  category_name: string | null;
  parent_category_id: number | null;
  parent_category_name: string | null;
  grandparent_category_id: number | null;
  grandparent_category_name: string | null;
}

/**
 * Enrichit la hiérarchie des catégories pour les sale_items insérés
 * Utilise hiboutik_category_id pour faire le lookup dans la table categories
 */
async function enrichCategoryHierarchy(
  supabase: any,
  saleItemIds: number[],
  hiboutikCategoryIds: Map<number, number>, // sale_item_id -> hiboutik_category_id
  apiSource: string
): Promise<number> {
  if (saleItemIds.length === 0) return 0;

  console.log(`[enrichCategoryHierarchy] Processing ${saleItemIds.length} items for ${apiSource} API`);

  // Collecter les hiboutik_category_ids uniques
  const uniqueCategoryIds = new Set<number>();
  hiboutikCategoryIds.forEach((catId) => {
    if (catId && catId > 0) uniqueCategoryIds.add(catId);
  });

  if (uniqueCategoryIds.size === 0) {
    console.log("[enrichCategoryHierarchy] No categories to enrich");
    return 0;
  }

  console.log(`[enrichCategoryHierarchy] Found ${uniqueCategoryIds.size} unique category IDs`);

  // Construire le cache de hiérarchie pour chaque catégorie
  const hierarchyMap = new Map<number, CategoryHierarchy>();

  for (const hiboutikCatId of uniqueCategoryIds) {
    const cacheKey = `${hiboutikCatId}_${apiSource}`;

    // Vérifier le cache mémoire
    if (categoryHierarchyCache.has(cacheKey)) {
      hierarchyMap.set(hiboutikCatId, categoryHierarchyCache.get(cacheKey));
      continue;
    }

    // Lookup catégorie dans la table categories
    const { data: category } = await supabase
      .from("categories")
      .select("id, category_name, hiboutik_category_id_parent")
      .eq("hiboutik_category_id", hiboutikCatId)
      .eq("api_source", apiSource)
      .single();

    if (!category) {
      console.warn(`[enrichCategoryHierarchy] Category ${hiboutikCatId} not found for ${apiSource}`);
      hierarchyMap.set(hiboutikCatId, {
        category_id: null,
        category_name: null,
        parent_category_id: null,
        parent_category_name: null,
        grandparent_category_id: null,
        grandparent_category_name: null,
      });
      continue;
    }

    const hierarchy: CategoryHierarchy = {
      category_id: category.id,
      category_name: category.category_name,
      parent_category_id: null,
      parent_category_name: null,
      grandparent_category_id: null,
      grandparent_category_name: null,
    };

    // Lookup parent si existe
    if (category.hiboutik_category_id_parent) {
      const { data: parent } = await supabase
        .from("categories")
        .select("id, category_name, hiboutik_category_id_parent")
        .eq("hiboutik_category_id", category.hiboutik_category_id_parent)
        .eq("api_source", apiSource)
        .single();

      if (parent) {
        hierarchy.parent_category_id = parent.id;
        hierarchy.parent_category_name = parent.category_name;

        // Lookup grandparent si existe
        if (parent.hiboutik_category_id_parent) {
          const { data: grandparent } = await supabase
            .from("categories")
            .select("id, category_name")
            .eq("hiboutik_category_id", parent.hiboutik_category_id_parent)
            .eq("api_source", apiSource)
            .single();

          if (grandparent) {
            hierarchy.grandparent_category_id = grandparent.id;
            hierarchy.grandparent_category_name = grandparent.category_name;
          }
        }
      }
    }

    hierarchyMap.set(hiboutikCatId, hierarchy);
    categoryHierarchyCache.set(cacheKey, hierarchy);

    console.log(
      `[enrichCategoryHierarchy] Category ${hiboutikCatId}: ${hierarchy.category_name} -> ${hierarchy.parent_category_name} -> ${hierarchy.grandparent_category_name}`
    );
  }

  // Mettre à jour chaque sale_item avec sa hiérarchie
  let updatedCount = 0;
  for (const [saleItemId, hiboutikCatId] of hiboutikCategoryIds) {
    if (!hiboutikCatId || hiboutikCatId <= 0) continue;

    const hierarchy = hierarchyMap.get(hiboutikCatId);
    if (!hierarchy) continue;

    // Seulement mettre à jour si on a des données parent/grandparent
    if (hierarchy.parent_category_name || hierarchy.grandparent_category_name) {
      const { error } = await supabase
        .from("sale_items")
        .update({
          category_id: hierarchy.category_id,
          parent_category_id: hierarchy.parent_category_id,
          parent_category_name: hierarchy.parent_category_name,
          grandparent_category_id: hierarchy.grandparent_category_id,
          grandparent_category_name: hierarchy.grandparent_category_name,
        })
        .eq("id", saleItemId);

      if (error) {
        console.error(`[enrichCategoryHierarchy] Error updating sale_item ${saleItemId}:`, error);
      } else {
        updatedCount++;
      }
    }
  }

  console.log(`[enrichCategoryHierarchy] Updated ${updatedCount}/${saleItemIds.length} sale_items with category hierarchy`);
  return updatedCount;
}

/**
 * Enrichit un client depuis Hiboutik et l'insère dans la table customers
 * Récupère la date du 1er achat depuis MIN(sales[].created_at)
 */
async function enrichCustomer(
  supabase: any,
  hiboutikClient: any,
  customerId: number,
  apiSource: string
): Promise<{ id: number; name: string } | null> {
  if (!customerId || customerId <= 0) return null;

  const cacheKey = `${customerId}_${apiSource}`;

  // Vérifier le cache mémoire
  if (customerCache.has(cacheKey)) {
    return customerCache.get(cacheKey);
  }

  // Vérifier si le client existe déjà dans la base
  const { data: existingCustomer } = await supabase
    .from("customers")
    .select("id, first_name, last_name, first_purchase_date")
    .eq("hiboutik_customer_id", customerId)
    .eq("api_source", apiSource)
    .single();

  if (existingCustomer) {
    const result = {
      id: existingCustomer.id,
      name: `${existingCustomer.first_name || ''} ${existingCustomer.last_name || ''}`.trim()
    };
    customerCache.set(cacheKey, result);
    return result;
  }

  // Client inconnu: le récupérer depuis Hiboutik
  console.log(`Auto-enriching customer ${customerId} from Hiboutik...`);

  try {
    const customerData = await hiboutikClient.fetchCustomer(customerId);
    if (!customerData) {
      console.warn(`Customer ${customerId} not found in Hiboutik`);
      return null;
    }

    // Extraire la date du 1er achat depuis l'historique des ventes
    let firstPurchaseDate: string | null = null;

    // Priorité 1: MIN(sales[].created_at) - plus fiable
    if (customerData.sales && customerData.sales.length > 0) {
      const firstSale = customerData.sales.reduce((oldest: any, sale: any) => {
        if (!oldest.created_at) return sale;
        if (!sale.created_at) return oldest;
        return sale.created_at < oldest.created_at ? sale : oldest;
      }, customerData.sales[0]);

      if (firstSale?.created_at) {
        firstPurchaseDate = firstSale.created_at.split(' ')[0];
      }
    }

    // Priorité 2: Fallback addresses[0].creation_date (souvent vide)
    if (!firstPurchaseDate && customerData.addresses && customerData.addresses.length > 0) {
      const creationDate = customerData.addresses[0].creation_date;
      if (creationDate && creationDate !== '0000-00-00 00:00:00') {
        firstPurchaseDate = creationDate.split(' ')[0];
      }
    }

    // Insérer le client dans la base
    const customerToInsert = {
      hiboutik_customer_id: customerId,
      api_source: apiSource,
      first_name: customerData.first_name?.trim() || null,
      last_name: customerData.last_name?.trim() || null,
      company: customerData.company?.trim() || null,
      email: customerData.email?.trim() || null,
      phone: customerData.phone?.trim() || null,
      country: customerData.country || 'FRA',
      date_of_birth: customerData.date_of_birth !== '0000-00-00' ? customerData.date_of_birth : null,
      loyalty_points: customerData.loyalty_points || 0,
      initial_loyalty_points: customerData.intial_loyalty_points || 0,
      store_credit: parseFloat(customerData.store_credit) || 0,
      prepaid_purchases: parseFloat(customerData.prepaid_purchases) || 0,
      customers_code: customerData.customers_code?.trim() || null,
      customers_ref_ext: customerData.customers_ref_ext?.trim() || null,
      last_order_date: customerData.last_order_date !== '0000-00-00' ? customerData.last_order_date : null,
      first_purchase_date: firstPurchaseDate, // VRAIE date de création depuis Hiboutik!
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: inserted, error } = await supabase
      .from("customers")
      .upsert(customerToInsert, { onConflict: "hiboutik_customer_id,api_source" })
      .select("id")
      .single();

    if (error) {
      console.error(`Error inserting customer ${customerId}:`, error);
      return null;
    }

    console.log(`Customer ${customerId} auto-enriched with first_purchase_date: ${firstPurchaseDate}`);

    const result = {
      id: inserted.id,
      name: `${customerData.first_name || ''} ${customerData.last_name || ''}`.trim()
    };
    customerCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`Error fetching customer ${customerId} from Hiboutik:`, e);
    return null;
  }
}

/**
 * Auto-enrichit un produit depuis les données Hiboutik
 * Insère le produit s'il n'existe pas dans la table products
 */
async function enrichProduct(
  supabase: any,
  hiboutikProductId: number,
  productData: any,
  apiSource: string
): Promise<{ id: number; name: string } | null> {
  if (!hiboutikProductId || hiboutikProductId <= 0) return null;

  const cacheKey = `${hiboutikProductId}_${apiSource}`;

  // Vérifier le cache mémoire
  if (productCache.has(cacheKey)) {
    return productCache.get(cacheKey);
  }

  // Vérifier si le produit existe déjà dans la base
  const { data: existingProduct } = await supabase
    .from("products")
    .select("id, product_model")
    .eq("hiboutik_product_id", hiboutikProductId)
    .eq("api_source", apiSource)
    .single();

  if (existingProduct) {
    const result = {
      id: existingProduct.id,
      name: existingProduct.product_model
    };
    productCache.set(cacheKey, result);
    return result;
  }

  // Produit inconnu: l'insérer depuis les données du line item
  console.log(`[enrichProduct] Auto-inserting product ${hiboutikProductId} from sale data...`);

  try {
    const productToInsert = {
      hiboutik_product_id: hiboutikProductId,
      api_source: apiSource,
      product_model: productData.product_model || productData.product_name || `Product ${hiboutikProductId}`,
      product_brand: productData.brand_name || null,
      product_price: parseFloat(productData.product_price || productData.item_unit_gross || '0'),
      product_price_ttc: parseFloat(productData.item_unit_gross || productData.product_price || '0'),
      product_supply_price: parseFloat(productData.product_supply_price || '0'),
      product_category: productData.product_category || null,
      brand_id: productData.product_brand || null,
      hiboutik_category_id: productData.product_category || null,
      vat: parseFloat(productData.vat || '0.2'),
      is_active: true,
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: inserted, error } = await supabase
      .from("products")
      .upsert(productToInsert, { onConflict: "hiboutik_product_id,api_source" })
      .select("id")
      .single();

    if (error) {
      console.error(`[enrichProduct] Error inserting product ${hiboutikProductId}:`, error);
      return null;
    }

    console.log(`[enrichProduct] Product ${hiboutikProductId} auto-inserted: ${productToInsert.product_model}`);

    const result = {
      id: inserted.id,
      name: productToInsert.product_model
    };
    productCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[enrichProduct] Error enriching product ${hiboutikProductId}:`, e);
    return null;
  }
}

/**
 * Auto-enrichit une marque depuis les données Hiboutik
 * Insère la marque si elle n'existe pas dans la table brands
 */
async function enrichBrand(
  supabase: any,
  hiboutikBrandId: number,
  brandName: string | null,
  apiSource: string
): Promise<{ id: number; name: string } | null> {
  if (!hiboutikBrandId || hiboutikBrandId <= 0) return null;

  const cacheKey = `brand_${hiboutikBrandId}_${apiSource}`;

  // Vérifier le cache mémoire
  if (brandCache.has(cacheKey)) {
    return brandCache.get(cacheKey);
  }

  // Vérifier si la marque existe déjà dans la base
  const { data: existingBrand } = await supabase
    .from("brands")
    .select("id, brand_name")
    .eq("hiboutik_brand_id", hiboutikBrandId)
    .eq("api_source", apiSource)
    .single();

  if (existingBrand) {
    const result = {
      id: existingBrand.id,
      name: existingBrand.brand_name
    };
    brandCache.set(cacheKey, result);
    return result;
  }

  // Marque inconnue: l'insérer
  if (!brandName) {
    console.log(`[enrichBrand] Brand ${hiboutikBrandId} has no name, skipping`);
    return null;
  }

  console.log(`[enrichBrand] Auto-inserting brand ${hiboutikBrandId}: ${brandName}`);

  try {
    const brandToInsert = {
      hiboutik_brand_id: hiboutikBrandId,
      api_source: apiSource,
      brand_name: brandName,
      last_sync_at: new Date().toISOString()
    };

    const { data: inserted, error } = await supabase
      .from("brands")
      .upsert(brandToInsert, { onConflict: "hiboutik_brand_id,api_source" })
      .select("id")
      .single();

    if (error) {
      console.error(`[enrichBrand] Error inserting brand ${hiboutikBrandId}:`, error);
      return null;
    }

    console.log(`[enrichBrand] Brand ${hiboutikBrandId} auto-inserted: ${brandName}`);

    const result = {
      id: inserted.id,
      name: brandName
    };
    brandCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[enrichBrand] Error enriching brand ${hiboutikBrandId}:`, e);
    return null;
  }
}

/**
 * Lookup canonical vendor info from vendor_mapping table
 * Works for both main and secondary APIs
 * Returns { id, canonical_name } or null if not found
 */
async function lookupCanonicalVendor(
  supabase: any,
  hiboutikVendorId: number,
  apiSource: string
): Promise<{ id: number; canonical_name: string } | null> {
  if (!hiboutikVendorId || hiboutikVendorId <= 0) return null;

  const cacheKey = `vendor_${hiboutikVendorId}_${apiSource}`;

  // Check cache first
  if (vendorMappingCache.has(cacheKey)) {
    return vendorMappingCache.get(cacheKey);
  }

  // Build query based on API source
  const columnToMatch = apiSource === "secondary" ? "vendor_id_secondary" : "vendor_id_main";

  const { data: mapping } = await supabase
    .from("vendor_mapping")
    .select("id, canonical_name")
    .eq(columnToMatch, hiboutikVendorId)
    .eq("is_active", true)
    .single();

  if (mapping) {
    const result = { id: mapping.id, canonical_name: mapping.canonical_name };
    vendorMappingCache.set(cacheKey, result);
    console.log(`[lookupCanonicalVendor] ${apiSource} vendor ${hiboutikVendorId} → canonical_vendor_id=${mapping.id} (${mapping.canonical_name})`);
    return result;
  }

  // Not found in vendor_mapping
  console.warn(`[lookupCanonicalVendor] Vendor ${hiboutikVendorId} (${apiSource}) not found in vendor_mapping`);
  vendorMappingCache.set(cacheKey, null);
  return null;
}

// === v3.14 Monitoring: Raw payload backup ===
async function backupRawPayload(
  supabase: any,
  saleId: number,
  apiSource: string,
  rawPayload: any,
  lineItemsCount: number
): Promise<void> {
  try {
    await supabase.from("webhook_raw_payloads").upsert({
      hiboutik_sale_id: saleId,
      api_source: apiSource,
      raw_payload: rawPayload,
      line_items_count: lineItemsCount,
      processing_status: "pending",
      webhook_version: VERSION,
      received_at: new Date().toISOString(),
    }, { onConflict: "hiboutik_sale_id,api_source" });
  } catch (e) {
    console.error("[backupRawPayload] Error:", e);
  }
}

async function markPayloadProcessed(
  supabase: any,
  saleId: number,
  apiSource: string,
  durationMs: number
): Promise<void> {
  try {
    await supabase.from("webhook_raw_payloads")
      .update({
        processing_status: "success",
        processed_at: new Date().toISOString(),
        processing_duration_ms: durationMs,
      })
      .eq("hiboutik_sale_id", saleId)
      .eq("api_source", apiSource);
  } catch (e) {
    console.error("[markPayloadProcessed] Error:", e);
  }
}

async function markPayloadError(
  supabase: any,
  saleId: number,
  apiSource: string,
  error: Error,
  durationMs: number
): Promise<void> {
  try {
    await supabase.from("webhook_raw_payloads")
      .update({
        processing_status: "error",
        error_message: error.message,
        error_details: { stack: error.stack },
        processed_at: new Date().toISOString(),
        processing_duration_ms: durationMs,
      })
      .eq("hiboutik_sale_id", saleId)
      .eq("api_source", apiSource);
  } catch (e) {
    console.error("[markPayloadError] Error:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();
  let _saleId = 0;
  let _apiSource = "main";

  try {
    // Déterminer l'API source
    const url = new URL(req.url);
    const apiSourceParam = url.searchParams.get("api") as ApiSource | null;
    const apiSource: ApiSource = apiSourceParam === "secondary" ? "secondary" : "main";

    console.log(`[${VERSION}] Webhook received from ${apiSource} API`);

    // Lire le body
    const rawBody = await req.text();
    const contentType = req.headers.get("content-type") || "";

    // v3.15: Vérification HMAC-SHA256 Hiboutik
    const receivedHmac = req.headers.get("x-hiboutik-hmac-sha256");
    const webhookSecret = apiSource === "secondary"
      ? Deno.env.get("HIBOUTIK_WEBHOOK_SECRET_SECONDARY")
      : Deno.env.get("HIBOUTIK_WEBHOOK_SECRET_MAIN");

    if (webhookSecret) {
      // Si le secret est configuré, on vérifie le HMAC
      if (!receivedHmac) {
        console.error(`[${VERSION}] Missing HMAC header from ${apiSource} API`);
        return new Response(
          JSON.stringify({ error: "Non autorisé" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const isValid = await verifyHiboutikHmac(rawBody, receivedHmac, webhookSecret);
      if (!isValid) {
        console.error(`[${VERSION}] Invalid HMAC signature from ${apiSource} API`);
        return new Response(
          JSON.stringify({ error: "Non autorisé" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log(`[${VERSION}] HMAC verification passed`);
    } else {
      console.warn(`[${VERSION}] No webhook secret configured for ${apiSource} - HMAC verification skipped`);
    }

    let payload: HiboutikSaleWebhook;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawBody);
      payload = Object.fromEntries(params.entries()) as any;
      payload.sale_id = parseInt(payload.sale_id as any);
      payload.store_id = parseInt(payload.store_id as any);
      payload.vendor_id = parseInt(payload.vendor_id as any);
    } else if (rawBody.length === 0) {
      // Empty body - health check
      return new Response(
        JSON.stringify({ status: "ok", version: VERSION }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      payload = JSON.parse(rawBody);
    }

    _saleId = payload.sale_id;
    _apiSource = apiSource;

    console.log(`Processing sale_id: ${payload.sale_id}`);

    if (!payload.sale_id) {
      throw new Error("Missing sale_id in webhook payload");
    }

    // Initialize clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const hiboutikClient = apiSource === "secondary"
      ? createSecondaryClient()
      : createMainClient();

    // v3.14: Backup raw payload BEFORE processing
    await backupRawPayload(supabase, payload.sale_id, apiSource, payload, 0);

    // Récupérer les détails complets de la vente avec line items enrichis
    console.log("Fetching complete sale data with line items...");
    const saleDetails = await hiboutikClient.fetchSaleWithDetails(payload.sale_id);

    if (!saleDetails) {
      throw new Error(`Sale ${payload.sale_id} not found in Hiboutik API`);
    }

    const { sale, lineItems } = saleDetails;
    console.log(`Found ${lineItems.length} line items`);

    // Mapping vendor_id pour l'API secondary
    let vendorHiboutikId = sale.vendor_id || payload.vendor_id;
    let vendorMappedId = vendorHiboutikId;

    if (apiSource === "secondary") {
      // Utilise vendor_mapping (37 lignes, plus complet) au lieu de vendor_cross_api_mapping
      const { data: vendorMappingData } = await supabase
        .from("vendor_mapping")
        .select("vendor_id_main, canonical_name")
        .eq("vendor_id_secondary", vendorHiboutikId)
        .single();

      if (vendorMappingData?.vendor_id_main) {
        vendorMappedId = vendorMappingData.vendor_id_main;
        console.log(`Vendor mapped: secondary ${vendorHiboutikId} → main ${vendorMappedId} (${vendorMappingData.canonical_name})`);
      } else {
        // Fallback vers le mapping hardcodé si non trouvé
        const hardcodedMapping = VENDOR_SECONDARY_TO_PRIMARY[vendorHiboutikId];
        if (hardcodedMapping) {
          vendorMappedId = hardcodedMapping;
          console.log(`Vendor mapped (hardcoded fallback): secondary ${vendorHiboutikId} → main ${vendorMappedId}`);
        }
      }
    }

    // Chercher le vendor dans notre base
    let vendor;
    if (apiSource === "secondary" && vendorHiboutikId !== vendorMappedId) {
      const { data } = await supabase
        .from("vendors")
        .select("id, first_name, last_name")
        .eq("hiboutik_user_id", vendorMappedId)
        .eq("api_source", "main")
        .single();
      vendor = data;
    } else {
      const { data } = await supabase
        .from("vendors")
        .select("id, first_name, last_name")
        .eq("hiboutik_user_id", vendorHiboutikId)
        .eq("api_source", apiSource)
        .single();
      vendor = data;
    }

    // Chercher le store
    const { data: store } = await supabase
      .from("stores")
      .select("id, name")
      .eq("hiboutik_store_id", sale.store_id || payload.store_id)
      .eq("api_source", apiSource)
      .single();

    // AUTO-ENRICHIR le client si présent
    const customerId = sale.customer_id || payload.customer_id || 0;
    let customer: { id: number; name: string } | null = null;
    if (customerId > 0) {
      customer = await enrichCustomer(supabase, hiboutikClient, customerId, apiSource);
    }

    const vendorName = vendor
      ? `${vendor.first_name || ''} ${vendor.last_name || ''}`.trim()
      : null;

    // LOOKUP canonical_vendor_id from vendor_mapping (NEW in v3.12)
    const canonicalVendor = await lookupCanonicalVendor(supabase, vendorHiboutikId, apiSource);

    // Préparer la date de vente (gérer les dates invalides "0000-00-00")
    let saleDate = sale.completed_at || sale.created_at || payload.completed_at || new Date().toISOString();
    if (saleDate.startsWith("0000-00-00") || saleDate === "0000-00-00 00:00:00") {
      console.warn(`Invalid sale date "${saleDate}" for sale ${payload.sale_id}, using current date`);
      saleDate = new Date().toISOString();
    }

    // Préparer les sale_items à insérer
    // NOTE: Les line_items sont maintenant EMBARQUÉS dans la réponse de l'API Hiboutik
    // avec tous les détails produit/catégorie/marque déjà inclus

    // Map pour tracker les hiboutik_category_id par index (pour enrichissement post-insert)
    const lineItemCategoryIds: number[] = [];

    // Compteurs pour les auto-enrichissements
    let productsEnriched = 0;
    let brandsEnriched = 0;

    // Traitement async pour chaque line item avec auto-enrichissement
    const saleItemsToInsert: any[] = [];

    for (let index = 0; index < lineItems.length; index++) {
      const item = lineItems[index];
      const product = item._product;
      const category = item._category;
      const brand = item._brand;

      // Calculer le prix unitaire et total (format embarqué Hiboutik)
      // item_unit_gross = prix TTC unitaire, item_total_gross = total TTC ligne
      const quantity = parseInt(item.quantity || item.line_quantity || '1');
      const unitPrice = parseFloat(item.item_unit_gross || item.product_price || item.line_price || '0');
      const totalLine = parseFloat(item.item_total_gross || item.line_total || (unitPrice * quantity).toString());

      // Données additionnelles du format embarqué
      const discount = parseFloat(item.discount || '0');
      const taxRate = parseFloat(item.vat || '0.2');
      const supplyPrice = parseFloat(item.product_supply_price || '0');

      // Catégorie - directement disponible dans le line_item embarqué
      const categoryName = item.category_name || category?.category_name || null;
      // Stocker le hiboutik_category_id pour enrichissement ultérieur
      const hiboutikCategoryId = item.product_category || product?.product_category || 0;
      lineItemCategoryIds.push(hiboutikCategoryId);

      // AUTO-ENRICHIR le produit s'il n'existe pas
      const hiboutikProductId = item.product_id || product?.product_id || null;
      let productId: number | null = null;
      if (hiboutikProductId) {
        const enrichedProduct = await enrichProduct(supabase, hiboutikProductId, item, apiSource);
        if (enrichedProduct) {
          productId = enrichedProduct.id;
          // Vérifier si c'était une nouvelle insertion (pas dans le cache avant)
          const cacheKey = `${hiboutikProductId}_${apiSource}`;
          if (!productCache.has(cacheKey)) productsEnriched++;
        }
      }

      // AUTO-ENRICHIR la marque si elle n'existe pas
      const hiboutikBrandId = item.product_brand || product?.product_brand || null;
      let brandId: number | null = null;
      const brandName = item.brand_name || brand?.brand_name || null;
      if (hiboutikBrandId) {
        const enrichedBrand = await enrichBrand(supabase, hiboutikBrandId, brandName, apiSource);
        if (enrichedBrand) {
          brandId = enrichedBrand.id;
          const cacheKey = `brand_${hiboutikBrandId}_${apiSource}`;
          if (!brandCache.has(cacheKey)) brandsEnriched++;
        }
      }

      saleItemsToInsert.push({
        // Identifiants (hiboutik_line_item_id est le nom de la colonne dans sale_items)
        hiboutik_sale_id: payload.sale_id,
        hiboutik_line_item_id: item.line_item_id || item.detail_commande_id || item.line_id || index + 1,
        api_source: apiSource,

        // Vente
        sale_date: saleDate,
        external_reference: sale.unique_sale_id || payload.unique_sale_id || null,
        payment_method: sale.payment || payload.payment || null,

        // Magasin
        store_id: store?.id || null,
        store_name: store?.name || null,
        hiboutik_store_id: sale.store_id || payload.store_id || null,

        // Vendeur (utilise vendor_id interne Supabase)
        vendor_id: vendor?.id || null,
        vendor_name: vendorName,
        hiboutik_vendor_id: vendorHiboutikId,
        // Canonical vendor for cross-API deduplication (NEW in v3.12)
        canonical_vendor_id: canonicalVendor?.id || null,
        canonical_vendor_name: canonicalVendor?.canonical_name || vendorName,

        // Produit (depuis le line_item embarqué Hiboutik) - ENRICHI avec product_id interne!
        product_id: productId, // NOW populated from auto-enrichment
        hiboutik_product_id: hiboutikProductId,
        product_name: item.product_model || product?.product_model || `Product ${item.product_id}`,

        // Catégorie (depuis le line_item embarqué)
        // Note: parent/grandparent seront enrichis via enrichCategoryHierarchy() après insert
        category_name: categoryName,

        // Marque (depuis le line_item embarqué) - ENRICHIE avec brand_id interne!
        brand_id: brandId, // NOW populated from auto-enrichment
        brand_name: brandName,
        hiboutik_brand_id: hiboutikBrandId,

        // Quantité et prix
        quantity: quantity,
        unit_price: unitPrice,
        unit_price_with_tax: unitPrice, // Hiboutik retourne TTC
        total_line: totalLine.toFixed(2),

        // Remise, TVA et prix d'achat (NOUVEAU - format embarqué)
        discount: discount > 0 ? discount.toFixed(2) : null,
        tax_rate: taxRate,
        supply_price: supplyPrice > 0 ? supplyPrice.toFixed(2) : null,

        // Déclinaison / Variant (format embarqué)
        variant_id: item.product_size || item.line_size_id || null,
        variant_name: item.size_name || item.line_size_name || null,
        size_id: item.product_size || item.line_size_id || null,
        size_name: item.size_name || item.line_size_name || null,

        // Numéro de série si présent
        serial_number: item.serial_number || null,

        // Client
        hiboutik_customer_id: customerId > 0 ? customerId : null,
        customer_name: customer?.name || null,

        // Métadonnées
        last_sync_at: new Date().toISOString(),
      });
    }

    if (productsEnriched > 0 || brandsEnriched > 0) {
      console.log(`[auto-enrich] ${productsEnriched} products, ${brandsEnriched} brands auto-inserted`);
    }

    // Upsert les sale_items
    // On utilise hiboutik_sale_id + hiboutik_line_item_id + api_source comme clé unique
    const { data: insertedItems, error: insertError } = await supabase
      .from("sale_items")
      .upsert(saleItemsToInsert, {
        onConflict: "hiboutik_sale_id,hiboutik_line_item_id,api_source",
        ignoreDuplicates: false,
      })
      .select("id");

    if (insertError) {
      console.error("Sale items upsert error:", insertError);
      throw insertError;
    }

    const itemsInserted = insertedItems?.length || saleItemsToInsert.length;
    console.log(`Successfully upserted ${itemsInserted} sale items`);

    // POST-TRAITEMENT: Enrichir la hiérarchie des catégories (parent/grandparent)
    let categoriesEnriched = 0;
    if (insertedItems && insertedItems.length > 0) {
      // Construire le map sale_item_id -> hiboutik_category_id
      const categoryIdMap = new Map<number, number>();
      insertedItems.forEach((item: { id: number }, index: number) => {
        const hiboutikCatId = lineItemCategoryIds[index];
        if (hiboutikCatId && hiboutikCatId > 0) {
          categoryIdMap.set(item.id, hiboutikCatId);
        }
      });

      // Appeler l'enrichissement des catégories
      const saleItemIds = insertedItems.map((item: { id: number }) => item.id);
      categoriesEnriched = await enrichCategoryHierarchy(
        supabase,
        saleItemIds,
        categoryIdMap,
        apiSource
      );
    }

    // v3.14: Mark payload as successfully processed
    await markPayloadProcessed(supabase, payload.sale_id, apiSource, Date.now() - startTime);

    // Log sync success
    await supabase.from("sync_logs").insert({
      sync_type: "webhook_sale_enriched",
      store_id: store?.id || null,
      status: "success",
      records_synced: itemsInserted,
      records_failed: 0,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      sync_metadata: {
        version: VERSION,
        hiboutik_sale_id: payload.sale_id,
        hiboutik_store_id: sale.store_id || payload.store_id,
        api_source: apiSource,
        line_items_count: lineItems.length,
        vendor_mapped: vendorHiboutikId !== vendorMappedId,
        categories_enriched: categoriesEnriched,
        products_auto_enriched: productsEnriched,
        brands_auto_enriched: brandsEnriched,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        version: VERSION,
        sale_id: payload.sale_id,
        items_inserted: itemsInserted,
        categories_enriched: categoriesEnriched,
        products_auto_enriched: productsEnriched,
        brands_auto_enriched: brandsEnriched,
        api_source: apiSource,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Webhook error:", error);

    // Log error
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      await supabase.from("sync_logs").insert({
        sync_type: "webhook_sale_enriched",
        status: "error",
        records_synced: 0,
        records_failed: 1,
        error_message: error.message,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
        sync_metadata: { version: VERSION },
      });

      // v3.14: Mark payload as error
      if (_saleId > 0) {
        await markPayloadError(supabase, _saleId, _apiSource, error, Date.now() - startTime);
      }
    } catch (logError) {
      console.error("Failed to log error:", logError);
    }

    return safeErrorResponse(error, `webhook-hiboutik-sale/${VERSION}`);
  }
});
