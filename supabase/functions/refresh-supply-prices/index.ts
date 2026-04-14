import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * This Edge Function calls the Hiboutik /reports/refresh/supply_prices endpoint
 * to force recalculation of cost prices before synchronization.
 *
 * Should be called BEFORE syncing sales/products to have up-to-date data.
 *
 * Query params:
 * - api=main (default) : refresh primary API
 * - api=secondary : refresh secondary API
 * - api=both : refresh both APIs
 */

type ApiSource = "main" | "secondary";

interface ApiConfig {
  url: string;
  user: string;
  key: string;
  source: ApiSource;
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

async function refreshSupplyPrices(config: ApiConfig): Promise<{ success: boolean; data?: any; error?: string }> {
  const authHeader = btoa(`${config.user}:${config.key}`);

  console.log(`[${config.source}] Calling ${config.url}/reports/refresh/supply_prices...`);

  try {
    const response = await fetch(
      `${config.url}/reports/refresh/supply_prices`,
      {
        method: "GET",
        headers: {
          "Authorization": `Basic ${authHeader}`,
        },
      }
    );

    const responseText = await response.text();
    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    console.log(`[${config.source}] Response: ${response.status}`, responseData);

    if (!response.ok) {
      return { success: false, error: `API error ${response.status}: ${responseText}` };
    }

    return { success: true, data: responseData };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // Initialize Supabase for logging
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Déterminer quelle(s) API(s) rafraîchir
    const url = new URL(req.url);
    const apiParam = url.searchParams.get("api") || "main";

    const apisToRefresh: ApiSource[] = apiParam === "both"
      ? ["main", "secondary"]
      : [apiParam === "secondary" ? "secondary" : "main"];

    const results: Record<string, any> = {};

    for (const apiSource of apisToRefresh) {
      const config = getApiConfig(apiSource);

      if (!config) {
        results[apiSource] = { success: false, error: `Missing credentials for ${apiSource} API` };
        console.error(`Missing credentials for ${apiSource} API`);
        continue;
      }

      const result = await refreshSupplyPrices(config);
      results[apiSource] = result;
    }

    const allSuccess = Object.values(results).every((r: any) => r.success);

    // Log result
    await supabase.from("sync_logs").insert({
      sync_type: "refresh_supply_prices",
      status: allSuccess ? "success" : "partial",
      duration_ms: Date.now() - startTime,
      details: { apis: apisToRefresh, results },
    });

    return new Response(
      JSON.stringify({
        success: allSuccess,
        message: allSuccess ? "Supply prices refreshed successfully" : "Some APIs failed",
        duration_ms: Date.now() - startTime,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Refresh supply prices error:", error);

    // Log error
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      await supabase.from("sync_logs").insert({
        sync_type: "refresh_supply_prices",
        status: "error",
        error_message: error.message,
        duration_ms: Date.now() - startTime,
      });
    } catch (logError) {
      console.error("Failed to log error:", logError);
    }

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
