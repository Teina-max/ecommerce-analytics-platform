import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendMessage,
  formatEUR,
  formatDateFR,
  getTodayDate,
  STORE_NAMES,
} from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Telegram Notification Service
 *
 * Envoie des notifications proactives aux utilisateurs/groupes configurés
 *
 * Types de notifications :
 * - daily_report : Rapport journalier (à 20h)
 * - weekly_report : Rapport hebdomadaire (dimanche soir)
 * - alert : Alerte personnalisée
 * - new_sale : Notification de nouvelle vente (optionnel)
 */

interface NotificationRequest {
  type: "daily_report" | "weekly_report" | "alert" | "new_sale" | "test";
  date?: string;
  message?: string;
  store_id?: number;
  sale_data?: any;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get configured chat IDs for notifications
    const chatIds = getChatIds();

    if (chatIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No chat IDs configured for notifications" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: NotificationRequest = await req.json();
    const { type, date, message, store_id, sale_data } = body;

    let notificationMessage = "";

    switch (type) {
      case "daily_report":
        notificationMessage = await buildDailyReport(supabase, date || getTodayDate());
        break;

      case "weekly_report":
        notificationMessage = await buildWeeklyReport(supabase);
        break;

      case "alert":
        if (!message) {
          return new Response(
            JSON.stringify({ error: "Message required for alert type" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        notificationMessage = `⚠️ <b>ALERTE</b>\n\n${message}`;
        break;

      case "new_sale":
        if (!sale_data) {
          return new Response(
            JSON.stringify({ error: "sale_data required for new_sale type" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        notificationMessage = buildNewSaleNotification(sale_data);
        break;

      case "test":
        notificationMessage = `✅ <b>Test de notification</b>\n\nLe bot RetailChain fonctionne correctement.\n\n<i>${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</i>`;
        break;

      default:
        return new Response(
          JSON.stringify({ error: `Unknown notification type: ${type}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Send to all configured chats
    const results = await Promise.all(
      chatIds.map(async (chatId) => {
        const success = await sendMessage(chatId, notificationMessage);
        return { chatId, success };
      })
    );

    const successCount = results.filter((r) => r.success).length;

    return new Response(
      JSON.stringify({
        success: true,
        type,
        sent: successCount,
        total: chatIds.length,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Notification error:", error);
    const errorId = crypto.randomUUID().slice(0, 8);
    return new Response(
      JSON.stringify({ error: "Erreur interne du serveur", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * Get configured chat IDs from environment
 * Format: comma-separated list of chat IDs
 */
function getChatIds(): number[] {
  const chatIdsEnv = Deno.env.get("TELEGRAM_NOTIFY_CHAT_IDS") || "";
  return chatIdsEnv
    .split(",")
    .map((id) => parseInt(id.trim()))
    .filter((id) => !isNaN(id));
}

/**
 * Build daily report message
 */
async function buildDailyReport(supabase: any, date: string): Promise<string> {
  const { data: reports, error } = await supabase
    .from("daily_z_reports")
    .select(`
      store_id,
      total_ttc,
      total_ht,
      sales_count,
      cash_total,
      card_total,
      stores(name)
    `)
    .eq("report_date", date)
    .order("store_id");

  if (error || !reports || reports.length === 0) {
    return `📊 <b>Rapport du ${formatDateFR(date)}</b>\n\nAucun rapport Z disponible.`;
  }

  let totalTTC = 0;
  let totalSales = 0;
  let storeLines = "";

  for (const report of reports) {
    const storeName = report.stores?.name || STORE_NAMES[report.store_id];
    totalTTC += report.total_ttc || 0;
    totalSales += report.sales_count || 0;

    const emoji = report.total_ttc > 1000 ? "🟢" : report.total_ttc > 500 ? "🟡" : "🔴";
    storeLines += `\n${emoji} <b>${storeName}</b>: ${formatEUR(report.total_ttc || 0)} (${report.sales_count || 0})`;
  }

  // Compare with previous day
  const prevDate = new Date(date);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = prevDate.toISOString().split("T")[0];

  const { data: prevReports } = await supabase
    .from("daily_z_reports")
    .select("total_ttc")
    .eq("report_date", prevDateStr);

  const prevTotal = prevReports?.reduce((sum: number, r: any) => sum + (r.total_ttc || 0), 0) || 0;
  const evolution = prevTotal > 0 ? ((totalTTC - prevTotal) / prevTotal) * 100 : 0;
  const evolutionEmoji = evolution >= 0 ? "📈" : "📉";
  const evolutionText = prevTotal > 0 ? `\n${evolutionEmoji} vs J-1: ${evolution >= 0 ? "+" : ""}${evolution.toFixed(1)}%` : "";

  return `
📊 <b>RAPPORT DU ${formatDateFR(date).toUpperCase()}</b>

<b>💰 TOTAL: ${formatEUR(totalTTC)}</b>
🛒 ${totalSales} ventes | 🏪 ${reports.length} magasins${evolutionText}
${storeLines}
  `.trim();
}

/**
 * Build weekly report message
 */
async function buildWeeklyReport(supabase: any): Promise<string> {
  const today = new Date();
  const endDate = today.toISOString().split("T")[0];

  // Start of week (Monday)
  const dayOfWeek = today.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - diff);
  const startDate = monday.toISOString().split("T")[0];

  const { data: reports, error } = await supabase
    .from("daily_z_reports")
    .select("store_id, total_ttc, sales_count, report_date")
    .gte("report_date", startDate)
    .lte("report_date", endDate);

  if (error || !reports || reports.length === 0) {
    return `📊 <b>Rapport Hebdomadaire</b>\n\nAucune donnée disponible.`;
  }

  // Aggregate
  const storeStats: Record<number, { total: number; sales: number }> = {};
  const dailyTotals: Record<string, number> = {};

  for (const report of reports) {
    if (!storeStats[report.store_id]) {
      storeStats[report.store_id] = { total: 0, sales: 0 };
    }
    storeStats[report.store_id].total += report.total_ttc || 0;
    storeStats[report.store_id].sales += report.sales_count || 0;
    dailyTotals[report.report_date] = (dailyTotals[report.report_date] || 0) + (report.total_ttc || 0);
  }

  const grandTotal = Object.values(dailyTotals).reduce((a, b) => a + b, 0);
  const totalDays = Object.keys(dailyTotals).length;
  const avgDaily = grandTotal / totalDays;

  // Best day
  const bestDay = Object.entries(dailyTotals).sort((a, b) => b[1] - a[1])[0];

  let storeLines = "";
  const sortedStores = Object.entries(storeStats).sort((a, b) => b[1].total - a[1].total);
  for (const [storeId, stats] of sortedStores) {
    const storeName = STORE_NAMES[parseInt(storeId)];
    storeLines += `\n${storeName}: ${formatEUR(stats.total)}`;
  }

  return `
📊 <b>RAPPORT HEBDOMADAIRE</b>
Du ${startDate} au ${endDate}

<b>💰 TOTAL: ${formatEUR(grandTotal)}</b>
📅 ${totalDays} jours | Moyenne: ${formatEUR(avgDaily)}/jour
🏆 Meilleur jour: ${formatDateFR(bestDay[0])} (${formatEUR(bestDay[1])})

<b>Par magasin :</b>${storeLines}
  `.trim();
}

/**
 * Build new sale notification
 */
function buildNewSaleNotification(saleData: any): string {
  const storeName = saleData.store_name || STORE_NAMES[saleData.store_id] || "Inconnu";
  const amount = formatEUR(parseFloat(saleData.total_amount_with_tax || saleData.total || 0));
  const payment = saleData.payment_method || saleData.payment || "N/A";

  return `
🛒 <b>Nouvelle vente</b>

🏪 ${storeName}
💰 ${amount}
💳 ${payment}
⏰ ${new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" })}
  `.trim();
}
