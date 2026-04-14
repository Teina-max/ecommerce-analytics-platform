import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * sync-master-data v1.3
 *
 * Synchronizes reference data from 2 Hiboutik APIs to Supabase.
 *
 * ENTITÉS SUPPORTÉES:
 * - stores: Magasins
 * - vendors: Vendeurs/Utilisateurs
 * - brands: Marques
 * - categories: Catégories (avec hiérarchie parent)
 * - products: Produits (avec pagination, enrichissement catégories)
 *
 * USAGE:
 * GET /sync-master-data?entities=stores,vendors,brands,categories,products&api=both
 * GET /sync-master-data?entities=products&api=main&dry_run=true
 *
 * PARAMÈTRES:
 * - entities: Liste d'entités à synchroniser (défaut: stores,vendors,brands,categories)
 * - api: main, secondary, ou both (défaut: both)
 * - dry_run: true pour simuler sans modifier (défaut: false)
 * - enrich_sales: true pour enrichir sale_items après sync (défaut: false)
 *
 * SCHEDULING: Quotidien à 6h Paris via pg_cron
 *
 * FIXES v1.3:
 * - category_order -> category_position (correct column name)
 * - Removed is_active, text_color, description (not in schema)
 */

type ApiSource = "main" | "secondary";

interface SyncResult {
  entity: string;
  api: ApiSource;
  fetched: number;
  inserted: number;
  updated: number;
  errors: string[];
}

interface HiboutikConfig {
  apiUrl: string;
  apiUser: string;
  apiKey: string;
  source: ApiSource;
}

class HiboutikClient {
  private config: HiboutikConfig;
  private authHeader: string;

  constructor(config: HiboutikConfig) {
    this.config = config;
    this.authHeader = btoa(`${config.apiUser}:${config.apiKey}`);
  }

  get source(): ApiSource {
    return this.config.source;
  }

  async fetchAll<T>(endpoint: string): Promise<T[]> {
    const url = `${this.config.apiUrl}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Basic ${this.authHeader}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Hiboutik API error: ${response.status}`);
    }
    return response.json();
  }

  async fetchAllPaginated<T>(endpoint: string, maxPages = 100): Promise<T[]> {
    const allData: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= maxPages) {
      const url = `${this.config.apiUrl}${endpoint}?p=${page}`;
      const response = await fetch(url, {
        headers: {
          "Authorization": `Basic ${this.authHeader}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Hiboutik API error: ${response.status}`);
      }
      const pageData: T[] = await response.json();
      if (!pageData || pageData.length === 0) {
        hasMore = false;
      } else {
        allData.push(...pageData);
        if (pageData.length < 250) {
          hasMore = false;
        } else {
          page++;
        }
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return allData;
  }
}

function getClient(source: ApiSource): HiboutikClient {
  const prefix = source === "main" ? "PRIMARY" : "SECONDARY";
  const apiUrl = Deno.env.get(`HIBOUTIK_${prefix}_API_URL`);
  const apiUser = Deno.env.get(`HIBOUTIK_${prefix}_API_USER`);
  const apiKey = Deno.env.get(`HIBOUTIK_${prefix}_API_KEY`);

  if (!apiUrl || !apiUser || !apiKey) {
    throw new Error(`Missing Hiboutik ${source} API credentials`);
  }

  return new HiboutikClient({ apiUrl, apiUser, apiKey, source });
}

async function syncStores(supabase: any, hibClient: HiboutikClient, dryRun: boolean): Promise<SyncResult> {
  const result: SyncResult = { entity: "stores", api: hibClient.source, fetched: 0, inserted: 0, updated: 0, errors: [] };

  try {
    const stores = await hibClient.fetchAll<any>("/stores/");
    result.fetched = stores.length;

    if (dryRun) return result;

    for (const store of stores) {
      const { error } = await supabase
        .from("stores")
        .upsert({
          hiboutik_store_id: store.store_id,
          api_source: hibClient.source,
          name: store.store_name,
          address: store.store_address || null,
          city: store.store_city || null,
          postal_code: store.store_zip || null,
          phone: store.store_phone || null,
          email: store.store_email || null,
          is_active: true,
          last_sync_at: new Date().toISOString(),
        }, { onConflict: "hiboutik_store_id,api_source" });

      if (error) {
        result.errors.push(`Store ${store.store_id}: ${error.message}`);
      } else {
        result.inserted++;
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  return result;
}

async function syncVendors(supabase: any, hibClient: HiboutikClient, dryRun: boolean): Promise<SyncResult> {
  const result: SyncResult = { entity: "vendors", api: hibClient.source, fetched: 0, inserted: 0, updated: 0, errors: [] };

  try {
    const vendors = await hibClient.fetchAll<any>("/users/");
    result.fetched = vendors.length;

    if (dryRun) return result;

    for (const vendor of vendors) {
      const { error } = await supabase
        .from("vendors")
        .upsert({
          hiboutik_user_id: vendor.user_id,
          api_source: hibClient.source,
          user_name: vendor.user_login || `user_${vendor.user_id}`,
          first_name: vendor.user_first_name || null,
          last_name: vendor.user_last_name || null,
          email: vendor.user_email || null,
          phone: vendor.user_phone || null,
          role: vendor.user_role || null,
          is_active: vendor.user_active === 1 || vendor.user_active === "1",
          last_sync_at: new Date().toISOString(),
        }, { onConflict: "hiboutik_user_id,api_source" });

      if (error) {
        result.errors.push(`Vendor ${vendor.user_id}: ${error.message}`);
      } else {
        result.inserted++;
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  return result;
}

async function syncBrands(supabase: any, hibClient: HiboutikClient, dryRun: boolean): Promise<SyncResult> {
  const result: SyncResult = { entity: "brands", api: hibClient.source, fetched: 0, inserted: 0, updated: 0, errors: [] };

  try {
    const brands = await hibClient.fetchAll<any>("/brands/");
    result.fetched = brands.length;

    if (dryRun) return result;

    for (const brand of brands) {
      const { error } = await supabase
        .from("brands")
        .upsert({
          hiboutik_brand_id: brand.brand_id,
          api_source: hibClient.source,
          brand_name: brand.brand_name,
          brand_slug: brand.brand_slug || null,
          is_enabled: brand.brand_enabled === 1 || brand.brand_enabled === "1",
          is_enabled_www: brand.brand_enabled_www === 1 || brand.brand_enabled_www === "1",
          brand_position: brand.brand_position || null,
          last_sync_at: new Date().toISOString(),
        }, { onConflict: "hiboutik_brand_id,api_source" });

      if (error) {
        result.errors.push(`Brand ${brand.brand_id}: ${error.message}`);
      } else {
        result.inserted++;
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  return result;
}

async function syncCategories(supabase: any, hibClient: HiboutikClient, dryRun: boolean): Promise<SyncResult> {
  const result: SyncResult = { entity: "categories", api: hibClient.source, fetched: 0, inserted: 0, updated: 0, errors: [] };

  try {
    const categories = await hibClient.fetchAll<any>("/categories/");
    result.fetched = categories.length;
    console.log(`[${hibClient.source}] Fetched ${categories.length} categories`);

    if (dryRun) return result;

    for (const cat of categories) {
      // FIX v1.2: Utiliser category_id_parent (pas category_parent)
      const parentId = cat.category_id_parent && cat.category_id_parent !== 0 ? cat.category_id_parent : null;

      // FIX v1.3: Utiliser les bons noms de colonnes
      const { error } = await supabase
        .from("categories")
        .upsert({
          hiboutik_category_id: cat.category_id,
          api_source: hibClient.source,
          category_name: cat.category_name,
          hiboutik_category_id_parent: parentId,
          category_position: cat.category_position || null,
          is_enabled: cat.category_enabled === 1 || cat.category_enabled === "1",
          background_color: cat.category_bck_color || null,
          last_sync_at: new Date().toISOString(),
        }, { onConflict: "hiboutik_category_id,api_source" });

      if (error) {
        result.errors.push(`Category ${cat.category_id}: ${error.message}`);
      } else {
        result.inserted++;
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  return result;
}

async function syncProducts(supabase: any, hibClient: HiboutikClient, dryRun: boolean): Promise<SyncResult> {
  const result: SyncResult = { entity: "products", api: hibClient.source, fetched: 0, inserted: 0, updated: 0, errors: [] };

  try {
    console.log(`[${hibClient.source}] Fetching products with pagination...`);
    const products = await hibClient.fetchAllPaginated<any>("/products/");
    result.fetched = products.length;
    console.log(`[${hibClient.source}] Fetched ${products.length} products`);

    if (dryRun) return result;

    // Charger les categories pour enrichir les products
    const { data: categories } = await supabase
      .from("categories")
      .select("hiboutik_category_id, category_name, hiboutik_category_id_parent, api_source");

    const categoryMap = new Map();
    if (categories) {
      for (const cat of categories) {
        const key = `${cat.hiboutik_category_id}_${cat.api_source}`;
        categoryMap.set(key, cat);
      }
    }
    console.log(`[${hibClient.source}] Loaded ${categoryMap.size} categories for enrichment`);

    const batchSize = 100;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const records = batch.map(p => {
        const catId = p.product_category;
        const catKey = `${catId}_${hibClient.source}`;
        const category = categoryMap.get(catKey);

        let categoryName = null;
        let parentCategoryId = null;
        let parentCategoryName = null;

        if (category) {
          categoryName = category.category_name;
          parentCategoryId = category.hiboutik_category_id_parent;

          // Resoudre le nom du parent
          if (parentCategoryId) {
            const parentKey = `${parentCategoryId}_${hibClient.source}`;
            const parentCat = categoryMap.get(parentKey);
            if (parentCat) {
              parentCategoryName = parentCat.category_name;
            }
          }
        }

        return {
          hiboutik_product_id: p.product_id,
          api_source: hibClient.source,
          product_name: p.product_model || `Product ${p.product_id}`,
          product_model: p.product_model || null,
          product_barcode: p.product_barcode || null,
          product_brand: p.product_brand_text || null,
          hiboutik_brand_id: p.product_brand && p.product_brand !== 0 ? p.product_brand : null,
          hiboutik_category_id: catId || null,
          category_id: catId || null,
          category_name: categoryName,
          parent_category_id: parentCategoryId,
          parent_category_name: parentCategoryName,
          product_price: p.product_price ? parseFloat(p.product_price) : null,
          product_price_with_tax: p.product_price_with_tax ? parseFloat(p.product_price_with_tax) : null,
          product_supply_price: p.product_supply_price ? parseFloat(p.product_supply_price) : null,
          total_stock: p.product_stock || 0,
          is_active: p.product_active === 1 || p.product_active === "1",
          is_virtual: p.product_is_virtual === 1 || p.product_is_virtual === "1",
          last_sync_at: new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from("products")
        .upsert(records, { onConflict: "hiboutik_product_id,api_source" });

      if (error) {
        result.errors.push(`Batch ${i}: ${error.message}`);
      } else {
        result.inserted += batch.length;
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  return result;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const entitiesParam = url.searchParams.get("entities") || "stores,vendors,brands,categories";
    const apiParam = url.searchParams.get("api") || "both";
    const dryRun = url.searchParams.get("dry_run") === "true";
    const enrichSales = url.searchParams.get("enrich_sales") === "true";

    const entities = entitiesParam.split(",").map(e => e.trim());
    const validEntities = ["stores", "vendors", "brands", "categories", "products"];
    const filteredEntities = entities.filter(e => validEntities.includes(e));

    if (filteredEntities.length === 0) {
      return new Response(
        JSON.stringify({ error: `Invalid entities. Valid: ${validEntities.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const apis: ApiSource[] = apiParam === "both" ? ["main", "secondary"] : [apiParam as ApiSource];

    const allResults: SyncResult[] = [];

    for (const api of apis) {
      const hibClient = getClient(api);

      for (const entity of filteredEntities) {
        console.log(`Syncing ${entity} from ${api}...`);
        let syncResult: SyncResult;

        switch (entity) {
          case "stores":
            syncResult = await syncStores(supabase, hibClient, dryRun);
            break;
          case "vendors":
            syncResult = await syncVendors(supabase, hibClient, dryRun);
            break;
          case "brands":
            syncResult = await syncBrands(supabase, hibClient, dryRun);
            break;
          case "categories":
            syncResult = await syncCategories(supabase, hibClient, dryRun);
            break;
          case "products":
            syncResult = await syncProducts(supabase, hibClient, dryRun);
            break;
          default:
            continue;
        }

        allResults.push(syncResult);
        console.log(`Done: ${entity} from ${api} - ${syncResult.fetched} fetched, ${syncResult.inserted} upserted`);
      }
    }

    // Enrichir sale_items si demande
    let enrichResult = null;
    if (enrichSales && !dryRun) {
      console.log("Enriching sale_items with category data...");
      const { data, error } = await supabase.rpc('enrich_sale_items_categories');
      enrichResult = { updated: data || 0, errors: error ? [error.message] : [] };
      console.log(`Enriched ${enrichResult.updated} sale_items`);
    }

    const summary = {
      version: "1.3",
      dry_run: dryRun,
      apis: apis,
      entities: filteredEntities,
      results: allResults,
      enrich_sales: enrichResult,
      totals: {
        fetched: allResults.reduce((sum, r) => sum + r.fetched, 0),
        upserted: allResults.reduce((sum, r) => sum + r.inserted, 0),
        errors: allResults.reduce((sum, r) => sum + r.errors.length, 0),
      },
      synced_at: new Date().toISOString(),
    };

    return new Response(
      JSON.stringify(summary, null, 2),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
