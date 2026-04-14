import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Import des rapports Z depuis Hiboutik
 *
 * Endpoints Hiboutik Z :
 * - GET /z/payment_types/{store_id}/{year}/{month}/{day}
 * - GET /z/taxes/{store_id}/{year}/{month}/{day}
 * - GET /z/categories/{store_id}/{year}/{month}/{day}
 * - GET /z/discounts/{store_id}/{year}/{month}/{day}
 *
 * Body params (JSON):
 * {
 *   "store_id": 1,           // Supabase store_id
 *   "hiboutik_store_id": 1,  // Hiboutik store_id
 *   "api": "main",           // "main" ou "secondary"
 *   "year": 2025,
 *   "month": 12,
 *   "day": 22
 * }
 *
 * Mapping des magasins:
 * - API Primary (your-store.hiboutik.com):
 *   - hiboutik 1 = STORE-A (supabase 1)
 *   - hiboutik 2 = STORE-B (supabase 2)
 *   - hiboutik 3 = STORE-C (supabase 3)
 *   - hiboutik 5 = STORE-D (supabase 39)
 *
 * - API Secondary (your-store-2.hiboutik.com):
 *   - hiboutik 1 = STORE-E (supabase 5)
 *   - hiboutik 2 = STORE-F (supabase 6)
 */

type ApiSource = "main" | "secondary";

interface ApiConfig {
  url: string;
  user: string;
  key: string;
  source: ApiSource;
}

interface ImportParams {
  store_id: number;           // Supabase store ID
  hiboutik_store_id: number;  // Hiboutik store ID
  api: ApiSource;
  year: number;
  month: number;
  day: number;
}

interface ZReportData {
  payment_types: any;
  taxes: any;
  categories: any;
  discounts: any;
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

async function fetchZEndpoint(
  config: ApiConfig,
  endpoint: string,
  hiboutikStoreId: number,
  year: number,
  month: number,
  day: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  const authHeader = btoa(`${config.user}:${config.key}`);
  const url = `${config.url}/z/${endpoint}/${hiboutikStoreId}/${year}/${month}/${day}`;

  console.log(`[${config.source}] Fetching ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Basic ${authHeader}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function fetchAllZReports(
  config: ApiConfig,
  hiboutikStoreId: number,
  year: number,
  month: number,
  day: number
): Promise<{ success: boolean; data?: ZReportData; errors: string[] }> {
  const endpoints = ["payment_types", "taxes", "categories", "discounts"];
  const results: Record<string, any> = {};
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    const result = await fetchZEndpoint(config, endpoint, hiboutikStoreId, year, month, day);
    if (result.success) {
      results[endpoint] = result.data;
    } else {
      errors.push(`${endpoint}: ${result.error}`);
      results[endpoint] = null;
    }
  }

  return {
    success: errors.length === 0,
    data: results as ZReportData,
    errors,
  };
}

function parseZReportData(data: ZReportData): {
  total_ttc: number;
  total_ht: number;
  total_tva: number;
  sales_count: number;
  cash_total: number;
  card_total: number;
  other_payment_total: number;
  payment_details: any;
  total_discounts: number;
} {
  // Parse payment_types - l'API retourne un tableau de paiements par type
  let cash_total = 0;
  let card_total = 0;
  let other_payment_total = 0;
  let total_ttc = 0;
  const uniqueSaleIds = new Set<string>();
  const payment_details: Record<string, { total: number; count: number }> = {};

  if (Array.isArray(data.payment_types)) {
    for (const pt of data.payment_types) {
      const method = (pt.payment_type || "").toUpperCase();
      let methodTotal = 0;
      let methodCount = 0;

      // Sommer les montants du tableau payments
      if (Array.isArray(pt.payments)) {
        for (const payment of pt.payments) {
          const amount = parseFloat(payment.amount || 0);
          methodTotal += amount;
          methodCount++;
          // Compter les ventes uniques
          if (payment.unique_sale_id) {
            uniqueSaleIds.add(payment.unique_sale_id);
          }
        }
      }

      if (methodTotal > 0) {
        payment_details[method] = { total: methodTotal, count: methodCount };
        total_ttc += methodTotal;

        // Classifier par type de paiement
        if (method === "ESP" || method.includes("ESPECE") || method.includes("CASH")) {
          cash_total += methodTotal;
        } else if (method === "CB" || method.includes("CARTE") || method.includes("CARD")) {
          card_total += methodTotal;
        } else if (method !== "CRED") { // Ignorer les crédits (avoirs)
          other_payment_total += methodTotal;
        }
      }
    }
  }

  // Nombre de ventes = nombre de sale_id uniques
  const sales_count = uniqueSaleIds.size;

  // Parse taxes pour le total HT et TVA
  let total_tva = 0;
  let total_ht = 0;

  if (Array.isArray(data.taxes)) {
    for (const tax of data.taxes) {
      // Sommer depuis le tableau details si présent
      if (Array.isArray(tax.details)) {
        for (const detail of tax.details) {
          total_tva += parseFloat(detail.tax_collected || 0);
          total_ht += parseFloat(detail.amount_ht || 0);
        }
      } else {
        total_tva += parseFloat(tax.tax_collected || 0);
        total_ht += parseFloat(tax.amount_ht || 0);
      }
    }
  }

  // Si total_ht n'est pas disponible, calculer depuis TTC - TVA
  if (total_ht === 0 && total_ttc > 0) {
    total_ht = total_ttc - total_tva;
  }

  // Parse discounts
  let total_discounts = 0;

  if (Array.isArray(data.discounts)) {
    for (const disc of data.discounts) {
      // Sommer depuis le tableau details si présent
      if (Array.isArray(disc.details)) {
        for (const detail of disc.details) {
          total_discounts += Math.abs(parseFloat(detail.amount || 0));
        }
      } else {
        total_discounts += Math.abs(parseFloat(disc.total || disc.amount || 0));
      }
    }
  }

  return {
    total_ttc: Math.round(total_ttc * 100) / 100,
    total_ht: Math.round(total_ht * 100) / 100,
    total_tva: Math.round(total_tva * 100) / 100,
    sales_count,
    cash_total: Math.round(cash_total * 100) / 100,
    card_total: Math.round(card_total * 100) / 100,
    other_payment_total: Math.round(other_payment_total * 100) / 100,
    payment_details,
    total_discounts: Math.round(total_discounts * 100) / 100,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    // Parse params with better error handling
    let params: ImportParams;

    try {
      const bodyText = await req.text();
      console.log("Received body:", bodyText);

      if (!bodyText || bodyText.trim() === "") {
        throw new Error("Request body is empty");
      }

      params = JSON.parse(bodyText);
    } catch (parseError: any) {
      console.error("JSON parse error:", parseError.message);
      return new Response(
        JSON.stringify({
          success: false,
          error: `Invalid JSON body: ${parseError.message}`,
          hint: "Expected: { store_id, hiboutik_store_id, api, year, month, day }",
          duration_ms: Date.now() - startTime,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate required params
    if (!params.store_id || !params.hiboutik_store_id || !params.api || !params.year || !params.month || !params.day) {
      throw new Error("Missing required params: store_id, hiboutik_store_id, api, year, month, day");
    }

    // Normalize api source
    const apiSource: ApiSource = params.api === "secondary" ? "secondary" : "main";

    console.log(`Importing Z report for store ${params.store_id} (hiboutik: ${params.hiboutik_store_id}) from ${apiSource} API`);
    console.log(`Date: ${params.year}-${params.month}-${params.day}`);

    // Get API config
    const config = getApiConfig(apiSource);
    if (!config) {
      throw new Error(`Missing credentials for ${apiSource} API`);
    }

    // Initialize Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch all Z report data
    const zResult = await fetchAllZReports(
      config,
      params.hiboutik_store_id,
      params.year,
      params.month,
      params.day
    );

    if (!zResult.data) {
      throw new Error(`Failed to fetch Z reports: ${zResult.errors.join(", ")}`);
    }

    // Parse the data
    const parsed = parseZReportData(zResult.data);

    // Format date
    const reportDate = `${params.year}-${String(params.month).padStart(2, "0")}-${String(params.day).padStart(2, "0")}`;

    // Build Z report record
    const zReport = {
      store_id: params.store_id,
      report_date: reportDate,
      hiboutik_report_id: null,
      total_ttc: parsed.total_ttc,
      total_ht: parsed.total_ht,
      total_tva: parsed.total_tva,
      sales_count: parsed.sales_count,
      items_sold: 0, // Not available from these endpoints
      cash_total: parsed.cash_total,
      card_total: parsed.card_total,
      other_payment_total: parsed.other_payment_total,
      payment_details: parsed.payment_details,
      expected_cash: null,
      actual_cash: null,
      total_discounts: parsed.total_discounts,
      refunds_count: 0,
      refunds_total: 0,
      raw_data: zResult.data,
      api_source: apiSource,
      synced_at: new Date().toISOString(),
    };

    console.log("Z Report data:", JSON.stringify(zReport, null, 2));

    // Upsert the Z report
    const { error: upsertError } = await supabase
      .from("daily_z_reports")
      .upsert(zReport, {
        onConflict: "store_id,report_date,api_source",
      });

    if (upsertError) {
      throw new Error(`Upsert error: ${upsertError.message}`);
    }

    // Log sync
    await supabase.from("sync_logs").insert({
      sync_type: "z_reports_import",
      status: zResult.success ? "success" : "partial",
      records_processed: 1,
      duration_ms: Date.now() - startTime,
      details: {
        store_id: params.store_id,
        hiboutik_store_id: params.hiboutik_store_id,
        api_source: apiSource,
        report_date: reportDate,
        errors: zResult.errors,
        totals: {
          total_ttc: parsed.total_ttc,
          sales_count: parsed.sales_count,
        },
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        store_id: params.store_id,
        report_date: reportDate,
        api_source: apiSource,
        duration_ms: Date.now() - startTime,
        data: {
          total_ttc: parsed.total_ttc,
          total_ht: parsed.total_ht,
          total_tva: parsed.total_tva,
          sales_count: parsed.sales_count,
          cash_total: parsed.cash_total,
          card_total: parsed.card_total,
          total_discounts: parsed.total_discounts,
        },
        warnings: zResult.errors.length > 0 ? zResult.errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Import Z reports error:", error);

    // Try to log error
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      await supabase.from("sync_logs").insert({
        sync_type: "z_reports_import",
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
