import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limiter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Rate limiting strict (5 req/min)
  const rateLimit = await checkRateLimit('db-query', getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit.retryAfterSeconds || 60);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const query = url.searchParams.get("q") || "sales_info";

    let result: any = {};

    switch (query) {
      case "sales_info":
        // Get sales date range and status distribution
        const { data: salesStats } = await supabase
          .from("sales")
          .select("sale_date, sale_status")
          .order("sale_date", { ascending: false })
          .limit(1);

        const { data: oldestSale } = await supabase
          .from("sales")
          .select("sale_date")
          .order("sale_date", { ascending: true })
          .limit(1);

        // Get sample of recent sales
        const { data: recentSales } = await supabase
          .from("sales")
          .select("id, store_id, sale_date, sale_status, total_amount_with_tax")
          .order("sale_date", { ascending: false })
          .limit(10);

        // Get recent sync logs (all, no filter)
        const { data: recentLogs, error: logsError } = await supabase
          .from("sync_logs")
          .select("*")
          .order("id", { ascending: false })
          .limit(10);

        if (logsError) console.error("Logs error:", logsError);

        // Get sync log types (all time)
        const { data: logTypes } = await supabase
          .from("sync_logs")
          .select("sync_type");

        const logTypeCount: Record<string, number> = {};
        for (const l of logTypes || []) {
          logTypeCount[l.sync_type] = (logTypeCount[l.sync_type] || 0) + 1;
        }

        // Check specifically for webhook_sale
        const { data: webhookLogs, count: webhookCount } = await supabase
          .from("sync_logs")
          .select("*", { count: "exact" })
          .eq("sync_type", "webhook_sale")
          .order("id", { ascending: false })
          .limit(5);

        result = {
          newest_sale: salesStats?.[0]?.sale_date,
          oldest_sale: oldestSale?.[0]?.sale_date,
          recent_sales: recentSales,
          sync_logs: {
            recent: recentLogs?.slice(0, 5),
            types_all: logTypeCount,
            webhook_sale: {
              count: webhookCount,
              recent: webhookLogs,
            },
          },
        };
        break;

      case "sales_by_date":
        const date = url.searchParams.get("date") || "2025-12-20";
        const { data: salesByDate } = await supabase
          .from("sales")
          .select("*")
          .gte("sale_date", `${date}T00:00:00`)
          .lt("sale_date", `${date}T23:59:59`);

        result = {
          date,
          count: salesByDate?.length || 0,
          sales: salesByDate,
        };
        break;

      case "webhook_check":
        const wcDate = url.searchParams.get("date") || "2025-12-22";
        const wcStoreId = parseInt(url.searchParams.get("store_id") || "1");

        // 1. Sales for this store today
        const { data: wcSales } = await supabase
          .from("sales")
          .select("id, hiboutik_sale_id, sale_date, total_amount_with_tax, created_at")
          .eq("store_id", wcStoreId)
          .gte("sale_date", `${wcDate}T00:00:00`)
          .order("sale_date", { ascending: true });

        // 2. Webhook logs today
        const { data: wcLogs } = await supabase
          .from("sync_logs")
          .select("*")
          .eq("sync_type", "webhook_sale")
          .gte("created_at", `${wcDate}T00:00:00`)
          .order("created_at", { ascending: false })
          .limit(20);

        // 3. Store info
        const { data: wcStore } = await supabase
          .from("stores")
          .select("name")
          .eq("id", wcStoreId)
          .single();

        const wcTotal = wcSales?.reduce((sum, s) => sum + parseFloat(s.total_amount_with_tax || 0), 0) || 0;

        result = {
          date: wcDate,
          store_id: wcStoreId,
          store_name: wcStore?.name,
          sales: {
            count: wcSales?.length || 0,
            total: Math.round(wcTotal * 100) / 100,
            list: wcSales,
          },
          webhook_logs: {
            count: wcLogs?.length || 0,
            logs: wcLogs?.map(l => ({
              id: l.id,
              status: l.status,
              created_at: l.created_at,
              details: l.sync_metadata || l.details,
            })),
          },
        };
        break;

      case "investigate":
        const invDate = url.searchParams.get("date") || "2025-12-20";
        const storeId = parseInt(url.searchParams.get("store_id") || "1");

        // 1. Sales count and sum for this store/date
        const { data: salesData } = await supabase
          .from("sales")
          .select("id, sale_date, total_amount_with_tax, sale_status, hiboutik_sale_id")
          .eq("store_id", storeId)
          .gte("sale_date", `${invDate}T00:00:00`)
          .lt("sale_date", `${invDate}T23:59:59.999`);

        const salesCount = salesData?.length || 0;
        const salesSum = salesData?.reduce((sum, s) => sum + parseFloat(s.total_amount_with_tax || 0), 0) || 0;

        // 2. Z Report for this store/date
        const { data: zReport } = await supabase
          .from("daily_z_reports")
          .select("*")
          .eq("store_id", storeId)
          .eq("report_date", invDate)
          .single();

        // 3. Get store info
        const { data: storeInfo } = await supabase
          .from("stores")
          .select("name, hiboutik_store_id, api_source")
          .eq("id", storeId)
          .single();

        result = {
          investigation: {
            date: invDate,
            store_id: storeId,
            store_name: storeInfo?.name,
            hiboutik_store_id: storeInfo?.hiboutik_store_id,
            api_source: storeInfo?.api_source,
          },
          sales_table: {
            count: salesCount,
            total: Math.round(salesSum * 100) / 100,
            sample: salesData?.slice(0, 5),
          },
          z_report: zReport ? {
            sales_count: zReport.sales_count,
            total_ttc: zReport.total_ttc,
            total_ht: zReport.total_ht,
            cash_total: zReport.cash_total,
            card_total: zReport.card_total,
            payment_details: zReport.payment_details,
            raw_data_summary: {
              payment_types_count: zReport.raw_data?.payment_types?.length || 0,
              taxes_count: zReport.raw_data?.taxes?.length || 0,
            },
          } : null,
          diagnosis: {
            z_report_exists: !!zReport,
            sales_match_z: zReport ? (salesCount === zReport.sales_count) : false,
            issue: !zReport
              ? "Z Report manquant"
              : (zReport.sales_count === salesCount
                  ? "Données cohérentes (problème dans l'import Z)"
                  : "Écart entre Z report et ventes sync"),
          },
        };
        break;

      case "cleanup_test_sales":
        const testSaleIds = [555555, 666666, 777777, 888888, 999999];

        // Get test sales IDs first
        const { data: testSales } = await supabase
          .from("sales")
          .select("id, hiboutik_sale_id")
          .in("hiboutik_sale_id", testSaleIds);

        const saleDbIds = testSales?.map(s => s.id) || [];

        // Delete sale_items first (foreign key)
        let itemsDeleted = 0;
        if (saleDbIds.length > 0) {
          const { count: itemCount } = await supabase
            .from("sale_items")
            .delete({ count: "exact" })
            .in("sale_id", saleDbIds);
          itemsDeleted = itemCount || 0;
        }

        // Delete test sales
        const { count: deletedSalesCount } = await supabase
          .from("sales")
          .delete({ count: "exact" })
          .in("hiboutik_sale_id", testSaleIds);

        // Delete test sync logs
        const { count: deletedLogsCount } = await supabase
          .from("sync_logs")
          .delete({ count: "exact" })
          .eq("sync_type", "test_webhook");

        result = {
          success: true,
          deleted: {
            sale_items: itemsDeleted,
            sales: deletedSalesCount || 0,
            test_logs: deletedLogsCount || 0,
          },
          test_sale_ids: testSaleIds,
        };
        break;

      default:
        result = { error: "Unknown query" };
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("db-query error:", error);
    const errorId = crypto.randomUUID().slice(0, 8);
    return new Response(
      JSON.stringify({ error: "Erreur interne du serveur", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
