import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * sync-supply-prices
 *
 * Synchronizes cost prices (supply_price) from Hiboutik to Supabase.
 * Fetches products by ID from Hiboutik since the API doesn't support pagination.
 *
 * Query params:
 * - api: 'main' | 'secondary' | 'both' (default: main)
 * - batch_size: products per batch (default: 50)
 * - limit: max products to process (default: 500)
 * - only_missing: true to process only products without supply_price (default: true)
 * - dry_run: true to simulate without updating (default: false)
 */

type ApiSource = "main" | "secondary";

interface ApiConfig {
  url: string;
  user: string;
  key: string;
  source: ApiSource;
}

interface ProductUpdate {
  hiboutik_product_id: number;
  product_supply_price: number;
  updated: boolean;
  error?: string;
}

function getApiConfig(source: ApiSource): ApiConfig | null {
  if (source === "secondary") {
    const url = Deno.env.get("HIBOUTIK_SECONDARY_API_URL");
    const user = Deno.env.get("HIBOUTIK_SECONDARY_API_USER");
    const key = Deno.env.get("HIBOUTIK_SECONDARY_API_KEY");
    if (!url || !user || !key) return null;
    return { url, user, key, source };
  } else {
    const url = Deno.env.get("HIBOUTIK_PRIMARY_API_URL");
    const user = Deno.env.get("HIBOUTIK_PRIMARY_API_USER");
    const key = Deno.env.get("HIBOUTIK_PRIMARY_API_KEY");
    if (!url || !user || !key) return null;
    return { url, user, key, source };
  }
}

async function fetchProductFromHiboutik(
  config: ApiConfig,
  productId: number
): Promise<{ supply_price: number | null; error?: string }> {
  const authHeader = btoa(`${config.user}:${config.key}`);

  try {
    const response = await fetch(
      `${config.url}/products/${productId}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Basic ${authHeader}`,
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { supply_price: null, error: "not_found" };
      }
      return { supply_price: null, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // API returns array or single object
    const product = Array.isArray(data) ? data[0] : data;

    if (!product) {
      return { supply_price: null, error: "empty_response" };
    }

    const supplyPrice = parseFloat(product.product_supply_price || "0");
    return { supply_price: supplyPrice };
  } catch (error: any) {
    return { supply_price: null, error: error.message };
  }
}

async function syncSupplyPrices(
  supabase: any,
  config: ApiConfig,
  options: {
    batchSize: number;
    limit: number;
    onlyMissing: boolean;
    dryRun: boolean;
  }
): Promise<{
  success: boolean;
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
  details: ProductUpdate[];
}> {
  const { batchSize, limit, onlyMissing, dryRun } = options;

  // Récupérer les produits à mettre à jour
  let query = supabase
    .from("products")
    .select("id, hiboutik_product_id, product_name, product_supply_price")
    .eq("api_source", config.source)
    .eq("is_active", true)
    .order("hiboutik_product_id", { ascending: false })
    .limit(limit);

  if (onlyMissing) {
    query = query.or("product_supply_price.is.null,product_supply_price.eq.0");
  }

  const { data: products, error: fetchError } = await query;

  if (fetchError) {
    throw new Error(`Failed to fetch products: ${fetchError.message}`);
  }

  console.log(`[${config.source}] Found ${products?.length || 0} products to process`);

  const results: ProductUpdate[] = [];
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Process by batch
  for (let i = 0; i < (products?.length || 0); i += batchSize) {
    const batch = products!.slice(i, i + batchSize);
    console.log(`[${config.source}] Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} products)`);

    // Process each product in the batch in parallel
    const batchPromises = batch.map(async (product: any) => {
      const hiboutikId = product.hiboutik_product_id;
      const result = await fetchProductFromHiboutik(config, hiboutikId);

      if (result.error) {
        errors++;
        return {
          hiboutik_product_id: hiboutikId,
          product_supply_price: 0,
          updated: false,
          error: result.error,
        };
      }

      if (result.supply_price === null || result.supply_price === 0) {
        skipped++;
        return {
          hiboutik_product_id: hiboutikId,
          product_supply_price: 0,
          updated: false,
          error: "no_supply_price",
        };
      }

      // Update Supabase if not a dry run
      if (!dryRun) {
        const { error: updateError } = await supabase
          .from("products")
          .update({
            product_supply_price: result.supply_price,
            updated_at: new Date().toISOString()
          })
          .eq("id", product.id);

        if (updateError) {
          errors++;
          return {
            hiboutik_product_id: hiboutikId,
            product_supply_price: result.supply_price,
            updated: false,
            error: updateError.message,
          };
        }
      }

      updated++;
      return {
        hiboutik_product_id: hiboutikId,
        product_supply_price: result.supply_price,
        updated: true,
      };
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Small delay between batches to avoid overloading API
    if (i + batchSize < (products?.length || 0)) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return {
    success: errors === 0,
    processed: products?.length || 0,
    updated,
    skipped,
    errors,
    details: results.slice(0, 100), // Limiter les détails retournés
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse query parameters
    const url = new URL(req.url);
    const apiParam = url.searchParams.get("api") || "main";
    const batchSize = parseInt(url.searchParams.get("batch_size") || "50");
    const limit = parseInt(url.searchParams.get("limit") || "500");
    const onlyMissing = url.searchParams.get("only_missing") !== "false";
    const dryRun = url.searchParams.get("dry_run") === "true";

    const apisToSync: ApiSource[] = apiParam === "both"
      ? ["main", "secondary"]
      : [apiParam === "secondary" ? "secondary" : "main"];

    console.log(`Starting sync: apis=${apiParam}, batch_size=${batchSize}, limit=${limit}, only_missing=${onlyMissing}, dry_run=${dryRun}`);

    const results: Record<string, any> = {};

    for (const apiSource of apisToSync) {
      const config = getApiConfig(apiSource);

      if (!config) {
        results[apiSource] = { success: false, error: `Missing credentials for ${apiSource} API` };
        console.error(`Missing credentials for ${apiSource} API`);
        continue;
      }

      try {
        const syncResult = await syncSupplyPrices(supabase, config, {
          batchSize,
          limit,
          onlyMissing,
          dryRun,
        });
        results[apiSource] = syncResult;
      } catch (error: any) {
        results[apiSource] = { success: false, error: error.message };
      }
    }

    const totalUpdated = Object.values(results).reduce(
      (sum: number, r: any) => sum + (r.updated || 0),
      0
    );
    const allSuccess = Object.values(results).every((r: any) => r.success !== false);

    // Log result
    await supabase.from("sync_logs").insert({
      sync_type: "sync_supply_prices",
      status: allSuccess ? "success" : "partial",
      records_synced: totalUpdated,
      duration_seconds: Math.round((Date.now() - startTime) / 1000),
      sync_metadata: {
        apis: apisToSync,
        batch_size: batchSize,
        limit,
        only_missing: onlyMissing,
        dry_run: dryRun,
        results
      },
    });

    return new Response(
      JSON.stringify({
        success: allSuccess,
        message: dryRun
          ? `Dry run completed. Would have updated ${totalUpdated} products.`
          : `Sync completed. Updated ${totalUpdated} products.`,
        duration_ms: Date.now() - startTime,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Supply price sync error:", error);

    const errorId = crypto.randomUUID().slice(0, 8);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur interne du serveur",
        error_id: errorId,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
