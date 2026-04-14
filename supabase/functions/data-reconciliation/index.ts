import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "1.4-tag-orphans";
const WEBHOOK_URL_BASE = Deno.env.get("SUPABASE_URL") + "/functions/v1/webhook-hiboutik-sale";

// ============================================================================
// INLINE SHARED UTILITIES (to avoid module resolution issues in MCP deployment)
// ============================================================================

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

function errorResponse(message: string, status = 400, details?: any): Response {
  return new Response(
    JSON.stringify({ error: message, details }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Date utilities
function getTodayDate(): string {
  const now = new Date();
  const parisTime = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return parisTime;
}

// Pagination utility
async function fetchAllRows<T = any>(
  query: any,
  pageSize = 1000,
  maxRows = 50000
): Promise<T[]> {
  let allData: T[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore && allData.length < maxRows) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (data && data.length > 0) {
      allData = allData.concat(data);
      from += pageSize;
      hasMore = data.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return allData;
}

// Telegram utility
async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN not configured");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: parseMode,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Telegram API error:", error);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
    return false;
  }
}

// Hiboutik client factory
type ApiSource = "main" | "secondary";

// Store mappings: hiboutik_store_id -> supabase_store_id
const MAIN_API_STORES: { hiboutik: number; supabase: number }[] = [
  { hiboutik: 1, supabase: 1 },   // Store-A
  { hiboutik: 2, supabase: 2 },   // Store-B
  { hiboutik: 3, supabase: 3 },   // Store-C
  { hiboutik: 5, supabase: 39 },  // Store-D
];

const SECONDARY_API_STORES: { hiboutik: number; supabase: number }[] = [
  { hiboutik: 1, supabase: 5 },   // Store-E
  { hiboutik: 2, supabase: 6 },   // Store-F
];

function createHiboutikClient(source: ApiSource) {
  const isMain = source === "main";
  const apiUrl = Deno.env.get(isMain ? "HIBOUTIK_PRIMARY_API_URL" : "HIBOUTIK_SECONDARY_API_URL");
  const apiUser = Deno.env.get(isMain ? "HIBOUTIK_PRIMARY_API_USER" : "HIBOUTIK_SECONDARY_API_USER");
  const apiKey = Deno.env.get(isMain ? "HIBOUTIK_PRIMARY_API_KEY" : "HIBOUTIK_SECONDARY_API_KEY");

  if (!apiUrl || !apiUser || !apiKey) {
    throw new Error(`Missing ${source} Hiboutik API credentials`);
  }

  const authHeader = btoa(`${apiUser}:${apiKey}`);
  const stores = isMain ? MAIN_API_STORES : SECONDARY_API_STORES;

  return {
    source,
    apiUrl,
    authHeader,
    stores,
    /**
     * Fetch all sale IDs for a given date using Z reports payment_types endpoint.
     * This endpoint returns all payments with their unique_sale_id.
     */
    async fetchSaleIdsByDate(date: string): Promise<number[]> {
      const [year, month, day] = date.split("-").map(Number);
      const allSaleIds: Set<number> = new Set();

      for (const store of stores) {
        const url = `${apiUrl}/z/payment_types/${store.hiboutik}/${year}/${month}/${day}`;
        console.log(`[${source}] Fetching ${url}`);

        try {
          const response = await fetch(url, {
            headers: {
              "Authorization": `Basic ${authHeader}`,
              "Content-Type": "application/json",
            },
          });

          if (response.ok) {
            const data = await response.json();
            // Extract sale_id directly from payment_types array
            // Each payment object has a sale_id field (e.g., sale_id: 38219)
            if (Array.isArray(data)) {
              for (const pt of data) {
                if (Array.isArray(pt.payments)) {
                  for (const payment of pt.payments) {
                    // Use sale_id directly (not unique_sale_id which is a formatted string)
                    if (payment.sale_id) {
                      allSaleIds.add(Number(payment.sale_id));
                    }
                  }
                }
              }
            }
            console.log(`[${source}] Store ${store.hiboutik}: found ${allSaleIds.size} unique sales so far`);
          } else {
            console.warn(`[${source}] Store ${store.hiboutik}: API returned ${response.status}`);
          }
        } catch (error) {
          console.error(`[${source}] Store ${store.hiboutik}: Error fetching Z reports:`, error);
        }

        await delay(100);
      }

      return Array.from(allSaleIds);
    }
  };
}

// ============================================================================
// TYPES
// ============================================================================

interface ReconciliationParams {
  date: string;
  days: number;
  api: "main" | "secondary" | "both";
  autoFix: boolean;
  fixDuplicates: boolean;
  fixOrphans: boolean;
  tagOrphans: boolean;  // NEW: Tag orphans with is_orphan=true instead of deleting
  dryRun: boolean;
  maxDeletions: number;
  minAgeHours: number;
}

interface ApiResult {
  supabase_count: number;
  hiboutik_count: number;
  missing: number[];
  duplicates: number[];
  orphans: number[];
  imported: number;
  deleted: number;
  backed_up: number;
  tagged: number;  // NEW: Count of orphans tagged with is_orphan=true
  errors: { sale_id: number; error: string }[];
}

interface ReconciliationResult {
  success: boolean;
  version: string;
  params: ReconciliationParams;
  summary: {
    date_range: string;
    api: string;
    dry_run: boolean;
    total_issues: number;
    missing: number;
    duplicates: number;
    orphans: number;
    imported: number;
    deleted: number;
    backed_up: number;
    tagged: number;  // NEW: Count of orphans tagged
  };
  details: {
    main?: ApiResult;
    secondary?: ApiResult;
  };
  duration_seconds: number;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Data Reconciliation Edge Function
 *
 * Compares Supabase sale_items with Hiboutik API and auto-fixes discrepancies:
 * - Missing sales: Import via webhook
 * - Duplicates: Delete with backup (keep oldest)
 * - Orphans: Delete with backup (conservative mode)
 *
 * Usage:
 *   GET /data-reconciliation?date=2025-01-15&days=1&api=both&dry_run=true
 *   GET /data-reconciliation?date=2025-01-15&days=7&auto_fix=true&fix_duplicates=true
 */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const url = new URL(req.url);
    const params: ReconciliationParams = {
      date: url.searchParams.get("date") || getTodayDate(),
      days: Math.min(parseInt(url.searchParams.get("days") || "1"), 31),
      api: (url.searchParams.get("api") || "both") as "main" | "secondary" | "both",
      autoFix: url.searchParams.get("auto_fix") === "true",
      fixDuplicates: url.searchParams.get("fix_duplicates") === "true",
      fixOrphans: url.searchParams.get("fix_orphans") === "true",
      tagOrphans: url.searchParams.get("tag_orphans") !== "false",  // NEW: Default TRUE - always tag orphans
      dryRun: url.searchParams.get("dry_run") === "true",
      maxDeletions: Math.min(parseInt(url.searchParams.get("max_deletions") || "50"), 100),
      minAgeHours: parseInt(url.searchParams.get("min_age_hours") || "24"),
    };

    console.log(`[${VERSION}] Starting reconciliation:`, params);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Calculate date range (date param is START, calculate END by adding days)
    const startDate = params.date;
    const endDate = calculateEndDate(params.date, params.days);
    const dateRange = `${startDate} → ${endDate}`;

    console.log(`[${VERSION}] Date range: ${dateRange}`);

    const results: { main?: ApiResult; secondary?: ApiResult } = {};

    // Process Main API
    if (params.api === "main" || params.api === "both") {
      console.log(`[${VERSION}] Processing MAIN API...`);
      results.main = await reconcileApi(
        supabase,
        createHiboutikClient("main"),
        "main",
        startDate,
        endDate,
        params
      );
    }

    // Process Secondary API
    if (params.api === "secondary" || params.api === "both") {
      console.log(`[${VERSION}] Processing SECONDARY API...`);
      results.secondary = await reconcileApi(
        supabase,
        createHiboutikClient("secondary"),
        "secondary",
        startDate,
        endDate,
        params
      );
    }

    // Calculate totals
    const totalMissing = (results.main?.missing.length || 0) + (results.secondary?.missing.length || 0);
    const totalDuplicates = (results.main?.duplicates.length || 0) + (results.secondary?.duplicates.length || 0);
    const totalOrphans = (results.main?.orphans.length || 0) + (results.secondary?.orphans.length || 0);
    const totalImported = (results.main?.imported || 0) + (results.secondary?.imported || 0);
    const totalDeleted = (results.main?.deleted || 0) + (results.secondary?.deleted || 0);
    const totalBackedUp = (results.main?.backed_up || 0) + (results.secondary?.backed_up || 0);
    const totalTagged = (results.main?.tagged || 0) + (results.secondary?.tagged || 0);
    const totalIssues = totalMissing + totalDuplicates + totalOrphans;

    const duration = Math.round((Date.now() - startTime) / 1000);

    const result: ReconciliationResult = {
      success: true,
      version: VERSION,
      params,
      summary: {
        date_range: dateRange,
        api: params.api,
        dry_run: params.dryRun,
        total_issues: totalIssues,
        missing: totalMissing,
        duplicates: totalDuplicates,
        orphans: totalOrphans,
        imported: totalImported,
        deleted: totalDeleted,
        backed_up: totalBackedUp,
        tagged: totalTagged,
      },
      details: results,
      duration_seconds: duration,
    };

    // Log to sync_logs
    await supabase.from("sync_logs").insert({
      sync_type: "reconciliation_run",
      status: "success",
      sync_metadata: {
        version: VERSION,
        params,
        summary: result.summary,
        timestamp: new Date().toISOString(),
      },
    });

    // Send Telegram alert if issues found
    if (totalIssues > 0) {
      await sendTelegramAlert(result);
    }

    return jsonResponse(result);

  } catch (error: any) {
    console.error(`[${VERSION}] Error:`, error);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      await supabase.from("sync_logs").insert({
        sync_type: "reconciliation_run",
        status: "error",
        sync_metadata: {
          version: VERSION,
          error: error.message,
          timestamp: new Date().toISOString(),
        },
      });
    }

    return new Response(
      JSON.stringify({ error: "Erreur interne du serveur", error_id: crypto.randomUUID().slice(0, 8) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// ============================================================================
// CORE RECONCILIATION LOGIC
// ============================================================================

async function reconcileApi(
  supabase: any,
  hiboutikClient: any,
  apiSource: ApiSource,
  startDate: string,
  endDate: string,
  params: ReconciliationParams
): Promise<ApiResult> {
  const result: ApiResult = {
    supabase_count: 0,
    hiboutik_count: 0,
    missing: [],
    duplicates: [],
    orphans: [],
    imported: 0,
    deleted: 0,
    backed_up: 0,
    tagged: 0,
    errors: [],
  };

  // 1. Get all sales from Supabase for date range
  // Use < endDatePlusOne instead of <= endDate to include all sales from the end date
  const endDatePlusOne = addOneDay(endDate);
  console.log(`[${apiSource}] Fetching Supabase sales (${startDate} to < ${endDatePlusOne})...`);
  const supabaseSales = await fetchAllRows(
    supabase
      .from("sale_items")
      .select("id, hiboutik_sale_id, hiboutik_line_item_id, sale_date, created_at")
      .gte("sale_date", startDate)
      .lt("sale_date", endDatePlusOne)
      .eq("api_source", apiSource)
      .order("id"),
    1000
  );

  // Get unique sale IDs (sale_items can have multiple lines per sale)
  const supabaseSaleIds = new Map<number, { ids: number[]; sale_date: string; created_at: string }>();
  for (const row of supabaseSales) {
    if (!supabaseSaleIds.has(row.hiboutik_sale_id)) {
      supabaseSaleIds.set(row.hiboutik_sale_id, {
        ids: [row.id],
        sale_date: row.sale_date,
        created_at: row.created_at,
      });
    } else {
      supabaseSaleIds.get(row.hiboutik_sale_id)!.ids.push(row.id);
    }
  }

  result.supabase_count = supabaseSaleIds.size;
  console.log(`[${apiSource}] Supabase: ${result.supabase_count} unique sales (${supabaseSales.length} line items)`);

  // 2. Get all sale IDs from Hiboutik for date range (via Z reports endpoint)
  console.log(`[${apiSource}] Fetching Hiboutik sale IDs from Z reports...`);
  const hiboutikSaleIdsList = await fetchHiboutikSaleIdsByDateRange(hiboutikClient, startDate, endDate);
  const hiboutikSaleIds = new Set(hiboutikSaleIdsList);
  result.hiboutik_count = hiboutikSaleIds.size;
  console.log(`[${apiSource}] Hiboutik: ${result.hiboutik_count} unique sales`);

  // 3. Find missing sales (in Hiboutik but not in Supabase)
  result.missing = [...hiboutikSaleIds].filter(id => !supabaseSaleIds.has(id));
  console.log(`[${apiSource}] Missing: ${result.missing.length} sales`);

  // 4. Find duplicates (same hiboutik_sale_id + hiboutik_line_item_id multiple times)
  const lineItemCounts = new Map<string, number[]>();
  for (const item of supabaseSales) {
    const key = `${item.hiboutik_sale_id}-${item.hiboutik_line_item_id}`;
    if (!lineItemCounts.has(key)) {
      lineItemCounts.set(key, [item.id]);
    } else {
      lineItemCounts.get(key)!.push(item.id);
    }
  }

  const duplicateLineItemIds: number[] = [];
  for (const [key, ids] of lineItemCounts) {
    if (ids.length > 1) {
      // Keep the first (oldest), mark rest for deletion
      duplicateLineItemIds.push(...ids.slice(1));
      const saleId = parseInt(key.split("-")[0]);
      if (!result.duplicates.includes(saleId)) {
        result.duplicates.push(saleId);
      }
    }
  }
  console.log(`[${apiSource}] Duplicates: ${result.duplicates.length} sales (${duplicateLineItemIds.length} duplicate rows)`);

  // 5. Find orphans (in Supabase but not in Hiboutik)
  result.orphans = [...supabaseSaleIds.keys()].filter(id => !hiboutikSaleIds.has(id));
  console.log(`[${apiSource}] Orphans: ${result.orphans.length} sales`);

  // 5b. NEW: Tag orphans with is_orphan=true
  if (params.tagOrphans && result.orphans.length > 0 && !params.dryRun) {
    console.log(`[${apiSource}] Tagging ${result.orphans.length} orphan sales...`);

    // Get all row IDs for orphan sales
    const orphanRowIds: number[] = [];
    for (const saleId of result.orphans) {
      const saleInfo = supabaseSaleIds.get(saleId);
      if (saleInfo) {
        orphanRowIds.push(...saleInfo.ids);
      }
    }

    if (orphanRowIds.length > 0) {
      const { count, error } = await supabase
        .from("sale_items")
        .update({ is_orphan: true })
        .in("id", orphanRowIds)
        .eq("is_orphan", false);  // Only update if not already tagged

      if (error) {
        console.error(`[${apiSource}] Error tagging orphans:`, error);
      } else {
        result.tagged = count || 0;
        console.log(`[${apiSource}] Tagged ${result.tagged} orphan rows`);
      }
    }
  } else if (params.tagOrphans && result.orphans.length > 0 && params.dryRun) {
    // In dry run, count how many would be tagged
    let orphanRowCount = 0;
    for (const saleId of result.orphans) {
      const saleInfo = supabaseSaleIds.get(saleId);
      if (saleInfo) {
        orphanRowCount += saleInfo.ids.length;
      }
    }
    result.tagged = orphanRowCount;
  }

  // 6. Auto-fix: Import missing sales
  if (params.autoFix && result.missing.length > 0 && !params.dryRun) {
    console.log(`[${apiSource}] Importing ${result.missing.length} missing sales...`);
    for (const saleId of result.missing) {
      const importResult = await importSaleViaWebhook(saleId, apiSource);
      if (importResult.success) {
        result.imported++;
        console.log(`[${apiSource}] Imported sale ${saleId}`);
      } else {
        result.errors.push({ sale_id: saleId, error: importResult.error || "Unknown error" });
        console.log(`[${apiSource}] Failed to import sale ${saleId}: ${importResult.error}`);
      }
      await delay(100);
    }
  }

  // 7. Auto-fix: Delete duplicates
  if (params.fixDuplicates && duplicateLineItemIds.length > 0) {
    console.log(`[${apiSource}] Deleting ${duplicateLineItemIds.length} duplicate rows...`);
    const toDelete = duplicateLineItemIds.slice(0, params.maxDeletions);

    if (!params.dryRun && toDelete.length > 0) {
      // Backup before delete
      const { data: backup } = await supabase
        .from("sale_items")
        .select("*")
        .in("id", toDelete);

      if (backup && backup.length > 0) {
        await supabase.from("sync_logs").insert({
          sync_type: "reconciliation_backup",
          status: "success",
          sync_metadata: {
            operation: "delete_duplicates",
            api_source: apiSource,
            deleted_rows: backup,
            count: backup.length,
            timestamp: new Date().toISOString(),
          },
        });
        result.backed_up += backup.length;

        const { count } = await supabase
          .from("sale_items")
          .delete({ count: "exact" })
          .in("id", toDelete);

        result.deleted += count || 0;
        console.log(`[${apiSource}] Deleted ${count} duplicate rows`);
      }
    } else if (params.dryRun) {
      result.deleted = toDelete.length;
    }
  }

  // 8. Auto-fix: Delete orphans (conservative mode)
  if (params.fixOrphans && result.orphans.length > 0) {
    console.log(`[${apiSource}] Checking orphans for deletion (min age: ${params.minAgeHours}h)...`);

    const minAge = new Date(Date.now() - params.minAgeHours * 60 * 60 * 1000);
    const orphansToDelete: number[] = [];

    for (const saleId of result.orphans) {
      const saleInfo = supabaseSaleIds.get(saleId);
      if (saleInfo && new Date(saleInfo.created_at) < minAge) {
        orphansToDelete.push(...saleInfo.ids);
      }
    }

    const toDelete = orphansToDelete.slice(0, params.maxDeletions - result.deleted);

    if (!params.dryRun && toDelete.length > 0) {
      const { data: backup } = await supabase
        .from("sale_items")
        .select("*")
        .in("id", toDelete);

      if (backup && backup.length > 0) {
        await supabase.from("sync_logs").insert({
          sync_type: "reconciliation_backup",
          status: "success",
          sync_metadata: {
            operation: "delete_orphans",
            api_source: apiSource,
            deleted_rows: backup,
            count: backup.length,
            timestamp: new Date().toISOString(),
          },
        });
        result.backed_up += backup.length;

        const { count } = await supabase
          .from("sale_items")
          .delete({ count: "exact" })
          .in("id", toDelete);

        result.deleted += count || 0;
        console.log(`[${apiSource}] Deleted ${count} orphan rows`);
      }
    } else if (params.dryRun) {
      result.deleted += toDelete.length;
    }
  }

  return result;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchHiboutikSaleIdsByDateRange(
  client: any,
  startDate: string,
  endDate: string
): Promise<number[]> {
  const allSaleIds: Set<number> = new Set();
  const dates = getDateRange(startDate, endDate);

  console.log(`[${client.source}] Fetching sales for ${dates.length} days: ${startDate} to ${endDate}`);

  for (const date of dates) {
    try {
      const saleIds = await client.fetchSaleIdsByDate(date);
      for (const id of saleIds) {
        allSaleIds.add(id);
      }
      console.log(`[${client.source}] Date ${date}: ${saleIds.length} sales (total: ${allSaleIds.size})`);
    } catch (error) {
      console.error(`[${client.source}] Error fetching sales for ${date}:`, error);
    }
    // Small pause between dates to avoid rate limiting
    await delay(50);
  }

  return Array.from(allSaleIds);
}

async function importSaleViaWebhook(
  saleId: number,
  apiSource: ApiSource
): Promise<{ success: boolean; error?: string; items?: number }> {
  const url = `${WEBHOOK_URL_BASE}?api=${apiSource}`;
  const body = `sale_id=${saleId}&store_id=0&vendor_id=0`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

async function sendTelegramAlert(result: ReconciliationResult): Promise<void> {
  const { summary } = result;
  const chatId = parseInt(Deno.env.get("TELEGRAM_CHAT_ID") || "0");

  if (!chatId) {
    console.log("TELEGRAM_CHAT_ID not configured, skipping alert");
    return;
  }

  const statusIcon = result.success ? (summary.total_issues === 0 ? "✅" : "⚠️") : "❌";
  const mode = summary.dry_run ? "🔍 DRY RUN" : "🔧 AUTO-FIX";

  let msg = `${statusIcon} <b>RÉCONCILIATION DONNÉES</b> ${mode}\n\n`;
  msg += `📅 Période: ${summary.date_range}\n`;
  msg += `🔍 Source: ${summary.api}\n\n`;

  if (summary.missing > 0) {
    msg += `🔴 Ventes manquantes: <b>${summary.missing}</b>`;
    if (summary.imported > 0) msg += ` → ${summary.imported} importées`;
    msg += `\n`;
  } else {
    msg += `✅ Aucune vente manquante\n`;
  }

  if (summary.duplicates > 0) {
    msg += `🟡 Doublons: <b>${summary.duplicates}</b>`;
    if (summary.deleted > 0) msg += ` → ${summary.deleted} supprimés`;
    msg += `\n`;
  } else {
    msg += `✅ Aucun doublon\n`;
  }

  if (summary.orphans > 0) {
    msg += `🟠 Orphelins: <b>${summary.orphans}</b>`;
    if (summary.tagged > 0) msg += ` → ${summary.tagged} taggés`;
    msg += `\n`;
  } else {
    msg += `✅ Aucun orphelin\n`;
  }

  if (summary.backed_up > 0) {
    msg += `\n💾 Sauvegardés: ${summary.backed_up} lignes`;
  }

  if (summary.tagged > 0 && summary.orphans === 0) {
    msg += `\n🏷️ Orphelins taggés: ${summary.tagged}`;
  }

  msg += `\n\n⏱️ Durée: ${result.duration_seconds}s`;

  await sendTelegramMessage(chatId, msg, "HTML");
}

function calculateEndDate(startDate: string, days: number): string {
  const start = new Date(startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + days - 1);
  return end.toISOString().split("T")[0];
}

function addOneDay(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  while (start <= end) {
    dates.push(start.toISOString().split("T")[0]);
    start.setDate(start.getDate() + 1);
  }

  return dates;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
