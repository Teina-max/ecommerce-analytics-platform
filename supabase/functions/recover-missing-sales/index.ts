import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type ApiSource } from "../_shared/hiboutik-client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { validateSaleIdRange, validateApiSource, ValidationError } from "../_shared/validation.ts";
import { safeErrorResponse } from "../_shared/errors.ts";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limiter.ts";

const VERSION = "1.2-secured";
const WEBHOOK_URL_BASE = Deno.env.get("SUPABASE_URL") + "/functions/v1/webhook-hiboutik-sale";

/**
 * Recovers missing sales from Hiboutik and imports them
 *
 * Usage by sale_id range (recommended):
 *   GET /recover-missing-sales?start_id=133000&end_id=134100&api=both
 *
 * The API iterates through each sale_id and imports those that exist
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  // Rate limiting
  const rateLimit = await checkRateLimit('recover-missing-sales', getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds || 60);
  }

  try {
    const url = new URL(req.url);
    const startIdRaw = url.searchParams.get("start_id");
    const endIdRaw = url.searchParams.get("end_id");
    const apiParamRaw = url.searchParams.get("api") || "both";
    const dryRun = url.searchParams.get("dry_run") === "true";

    // Strict parameter validation
    if (!startIdRaw || !endIdRaw) {
      throw new ValidationError("Parameters start_id and end_id required (ex: ?start_id=133000&end_id=134000)");
    }
    const startId = Number(startIdRaw);
    const endId = Number(endIdRaw);
    if (!Number.isInteger(startId) || !Number.isInteger(endId)) {
      throw new ValidationError("start_id et end_id doivent être des entiers");
    }
    validateSaleIdRange(startId, endId);
    const apiParam = validateApiSource(apiParamRaw);

    const totalIds = endId - startId + 1;
    console.log(`[${VERSION}] Recovering sales from ID ${startId} to ${endId} (${totalIds} IDs, api: ${apiParam}, dry_run: ${dryRun})`);

    // Note: Replace start_id/end_id with your actual sale ID range from your POS system

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const results: any = {
      main: { checked: 0, imported: 0, skipped: 0, not_found: 0, items: 0, errors: [] },
      secondary: { checked: 0, imported: 0, skipped: 0, not_found: 0, items: 0, errors: [] },
    };

    // Récupérer les ventes déjà importées pour éviter les doublons
    const { data: existingSales } = await supabase
      .from("sale_items")
      .select("hiboutik_sale_id, api_source")
      .gte("hiboutik_sale_id", startId)
      .lte("hiboutik_sale_id", endId);

    const existingMainSales = new Set(
      existingSales?.filter(s => s.api_source === "main").map(s => s.hiboutik_sale_id) || []
    );
    const existingSecondarySales = new Set(
      existingSales?.filter(s => s.api_source === "secondary").map(s => s.hiboutik_sale_id) || []
    );

    console.log(`Existing sales in DB: main=${existingMainSales.size}, secondary=${existingSecondarySales.size}`);

    // Iterate through each sale_id
    for (let saleId = startId; saleId <= endId; saleId++) {
      // API Main
      if (apiParam === "main" || apiParam === "both") {
        results.main.checked++;

        if (existingMainSales.has(saleId)) {
          results.main.skipped++;
          continue;
        }

        if (dryRun) {
          // En dry run, on ne vérifie pas si la vente existe
          continue;
        }

        const result = await importSaleViaWebhook(saleId, 0, 0, "main");
        if (result.success) {
          console.log(`  ✅ [MAIN] Sale ${saleId} imported (${result.items} line items)`);
          results.main.imported++;
          results.main.items += result.items || 0;
        } else if (result.error?.includes("not found") || result.error?.includes("404")) {
          results.main.not_found++;
        } else {
          console.log(`  ❌ [MAIN] Sale ${saleId}: ${result.error}`);
          results.main.errors.push({ sale_id: saleId, error: result.error });
        }
      }

      // API Secondary
      if (apiParam === "secondary" || apiParam === "both") {
        results.secondary.checked++;

        if (existingSecondarySales.has(saleId)) {
          results.secondary.skipped++;
          continue;
        }

        if (dryRun) {
          continue;
        }

        const result = await importSaleViaWebhook(saleId, 0, 0, "secondary");
        if (result.success) {
          console.log(`  ✅ [SECONDARY] Sale ${saleId} imported (${result.items} line items)`);
          results.secondary.imported++;
          results.secondary.items += result.items || 0;
        } else if (result.error?.includes("not found") || result.error?.includes("404")) {
          results.secondary.not_found++;
        } else {
          console.log(`  ❌ [SECONDARY] Sale ${saleId}: ${result.error}`);
          results.secondary.errors.push({ sale_id: saleId, error: result.error });
        }
      }

      // Small pause to avoid overloading
      if (saleId % 10 === 0) {
        await delay(100);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    return new Response(
      JSON.stringify({
        success: true,
        version: VERSION,
        range: { start_id: startId, end_id: endId, total_ids: totalIds },
        dry_run: dryRun,
        duration_seconds: duration,
        results,
        summary: {
          total_imported: results.main.imported + results.secondary.imported,
          total_items: results.main.items + results.secondary.items,
          total_skipped: results.main.skipped + results.secondary.skipped,
          total_not_found: results.main.not_found + results.secondary.not_found,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    return safeErrorResponse(error, `recover-missing-sales/${VERSION}`);
  }
});

async function importSaleViaWebhook(
  saleId: number,
  storeId: number,
  vendorId: number,
  apiSource: ApiSource
): Promise<{ success: boolean; error?: string; items?: number }> {
  const url = `${WEBHOOK_URL_BASE}?api=${apiSource}`;
  const body = `sale_id=${saleId}&store_id=${storeId}&vendor_id=${vendorId}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const result = await response.json();

    if (result.success) {
      return { success: true, items: result.items_inserted };
    } else {
      return { success: false, error: result.error || "Unknown error" };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
