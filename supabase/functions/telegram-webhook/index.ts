import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type TelegramUpdate,
  type TelegramMessage,
  sendMessage,
  answerCallbackQuery,
  formatEUR,
  formatDateFR,
  getTodayDate,
  STORE_NAMES,
  parseStore,
  parseDate,
} from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Bot Telegram RetailChain
 *
 * Commandes disponibles :
 * /start - Message de bienvenue
 * /ca - CA du jour (tous magasins)
 * /ca [date] - CA d'une date spécifique
 * /magasin [nom] - CA du jour pour un magasin
 * /magasin [nom] [date] - CA d'une date pour un magasin
 * /rapport - Rapport détaillé du jour
 * /rapport [date] - Rapport détaillé d'une date
 * /aide ou /help - Aide
 */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Vérification du secret token Telegram
    const telegramSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
    if (telegramSecret) {
      const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
      if (receivedSecret !== telegramSecret) {
        console.error("[telegram-webhook] Invalid or missing secret token");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const update: TelegramUpdate = await req.json();
    console.log("Telegram update received:", JSON.stringify(update));

    // Handle callback queries (inline buttons)
    if (update.callback_query) {
      await answerCallbackQuery(update.callback_query.id);
      const data = update.callback_query.data;
      const chatId = update.callback_query.message?.chat.id;

      if (chatId && data) {
        await handleCallbackQuery(chatId, data);
      }
      return new Response("ok", { headers: corsHeaders });
    }

    // Handle messages
    const message = update.message;
    if (!message?.text) {
      return new Response("ok", { headers: corsHeaders });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    // Parse command
    const commandMatch = text.match(/^\/(\w+)(@\w+)?(?:\s+(.*))?$/);
    if (commandMatch) {
      const [, command, , args] = commandMatch;
      await handleCommand(chatId, command.toLowerCase(), args || "");
    }

    return new Response("ok", { headers: corsHeaders });
  } catch (error: any) {
    console.error("Webhook error:", error);
    const errorId = crypto.randomUUID().slice(0, 8);
    return new Response(
      JSON.stringify({ error: "Erreur interne du serveur", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * Handle bot commands
 */
async function handleCommand(chatId: number, command: string, args: string): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  switch (command) {
    case "start":
      await sendWelcomeMessage(chatId);
      break;

    case "ca":
      await handleCACommand(chatId, args, supabase);
      break;

    case "magasin":
    case "mag":
    case "store":
      await handleMagasinCommand(chatId, args, supabase);
      break;

    case "rapport":
    case "report":
      await handleRapportCommand(chatId, args, supabase);
      break;

    case "aide":
    case "help":
      await sendHelpMessage(chatId);
      break;

    case "stats":
      await handleStatsCommand(chatId, args, supabase);
      break;

    default:
      await sendMessage(
        chatId,
        `Commande inconnue: /${command}\n\nTapez /aide pour voir les commandes disponibles.`
      );
  }
}

/**
 * Handle callback queries from inline buttons
 */
async function handleCallbackQuery(chatId: number, data: string): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const [action, ...params] = data.split(":");

  switch (action) {
    case "ca":
      await handleCACommand(chatId, params.join(":"), supabase);
      break;
    case "magasin":
      await handleMagasinCommand(chatId, params.join(" "), supabase);
      break;
    case "rapport":
      await handleRapportCommand(chatId, params.join(":"), supabase);
      break;
  }
}

/**
 * Welcome message
 */
async function sendWelcomeMessage(chatId: number): Promise<void> {
  const message = `
<b>Bienvenue sur le Bot RetailChain</b>

Je vous permets de consulter les données de vente en temps réel.

<b>Commandes disponibles :</b>
/ca - CA du jour (tous magasins)
/ca [date] - CA d'une date spécifique
/magasin [nom] - CA d'un magasin
/rapport - Rapport détaillé
/stats - Statistiques globales
/aide - Aide complète

<i>Exemple : /ca 20/12 ou /magasin store-a</i>
  `.trim();

  await sendMessage(chatId, message);
}

/**
 * Help message
 */
async function sendHelpMessage(chatId: number): Promise<void> {
  const message = `
<b>Aide - Bot RetailChain</b>

<b>Consulter le CA :</b>
/ca - CA du jour (tous magasins)
/ca hier - CA d'hier
/ca 20/12 - CA du 20 décembre
/ca 2025-12-20 - CA du 20/12/2025

<b>CA par magasin :</b>
/magasin store-a - CA Store-A aujourd'hui
/magasin store-b hier - CA Store-B hier
/mag sa 20/12 - CA Store-A le 20/12

<b>Noms de magasins acceptés :</b>
• Store-A (sa)
• Store-B (sb)
• Store-C (sc)
• Store-D (sd)
• Store-E (se)
• Store-F (sf)

<b>Rapports détaillés :</b>
/rapport - Rapport du jour
/rapport hier - Rapport d'hier
/rapport 20/12 - Rapport du 20/12

<b>Statistiques :</b>
/stats - Stats du mois en cours
/stats semaine - Stats de la semaine
  `.trim();

  await sendMessage(chatId, message);
}

/**
 * Handle /ca command
 */
async function handleCACommand(
  chatId: number,
  args: string,
  supabase: any
): Promise<void> {
  const date = args ? parseDate(args) : getTodayDate();

  if (!date) {
    await sendMessage(
      chatId,
      `Date non reconnue: "${args}"\n\nFormats acceptés : 20/12, 20/12/2025, 2025-12-20, hier, aujourd'hui`
    );
    return;
  }

  // Fetch Z reports for all stores
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

  if (error) {
    console.error("Error fetching Z reports:", error);
    await sendMessage(chatId, "Erreur lors de la récupération des données.");
    return;
  }

  if (!reports || reports.length === 0) {
    await sendMessage(
      chatId,
      `Aucun rapport Z pour le <b>${formatDateFR(date)}</b>\n\n<i>Les rapports Z sont générés à la clôture de caisse.</i>`
    );
    return;
  }

  // Calculate totals
  let totalTTC = 0;
  let totalHT = 0;
  let totalSales = 0;
  let totalCash = 0;
  let totalCard = 0;

  let storeLines = "";
  for (const report of reports) {
    const storeName = report.stores?.name || STORE_NAMES[report.store_id] || `Magasin ${report.store_id}`;
    totalTTC += report.total_ttc || 0;
    totalHT += report.total_ht || 0;
    totalSales += report.sales_count || 0;
    totalCash += report.cash_total || 0;
    totalCard += report.card_total || 0;

    storeLines += `\n<b>${storeName}</b>: ${formatEUR(report.total_ttc || 0)} (${report.sales_count || 0} ventes)`;
  }

  const message = `
<b>CA du ${formatDateFR(date)}</b>

<b>TOTAL: ${formatEUR(totalTTC)}</b>
${reports.length} magasins · ${totalSales} ventes
${storeLines}

<b>Répartition paiements :</b>
CB: ${formatEUR(totalCard)}
Espèces: ${formatEUR(totalCash)}
  `.trim();

  await sendMessage(chatId, message);
}

/**
 * Handle /magasin command
 */
async function handleMagasinCommand(
  chatId: number,
  args: string,
  supabase: any
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    // Show store selection
    const keyboard = {
      inline_keyboard: [
        [
          { text: "Store-A", callback_data: "magasin:1" },
          { text: "Store-B", callback_data: "magasin:2" },
        ],
        [
          { text: "Store-C", callback_data: "magasin:3" },
          { text: "Store-D", callback_data: "magasin:39" },
        ],
        [
          { text: "Store-E", callback_data: "magasin:5" },
          { text: "Store-F", callback_data: "magasin:6" },
        ],
      ],
    };

    await sendMessage(
      chatId,
      "Choisissez un magasin :",
      { replyMarkup: keyboard }
    );
    return;
  }

  // Parse store and optional date
  let storeId: number | null = null;
  let date = getTodayDate();

  // Try first part as store
  storeId = parseStore(parts[0]);

  if (!storeId) {
    await sendMessage(
      chatId,
      `Magasin non reconnu: "${parts[0]}"\n\nMagasins disponibles : store-a, store-b, store-c, store-d, store-e, store-f`
    );
    return;
  }

  // Try second part as date
  if (parts.length > 1) {
    const parsedDate = parseDate(parts[1]);
    if (parsedDate) {
      date = parsedDate;
    }
  }

  // Fetch Z report for this store
  const { data: report, error } = await supabase
    .from("daily_z_reports")
    .select(`
      *,
      stores(name)
    `)
    .eq("store_id", storeId)
    .eq("report_date", date)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching Z report:", error);
    await sendMessage(chatId, "Erreur lors de la récupération des données.");
    return;
  }

  const storeName = STORE_NAMES[storeId] || `Magasin ${storeId}`;

  if (!report) {
    // Try to get sales data instead
    const { data: sales } = await supabase
      .from("sales")
      .select("total_amount_with_tax")
      .eq("store_id", storeId)
      .gte("sale_date", `${date}T00:00:00`)
      .lt("sale_date", `${date}T23:59:59.999`);

    if (sales && sales.length > 0) {
      const total = sales.reduce((sum: number, s: any) => sum + parseFloat(s.total_amount_with_tax || 0), 0);
      await sendMessage(
        chatId,
        `<b>${storeName} - ${formatDateFR(date)}</b>\n\n` +
        `CA (ventes sync): ${formatEUR(total)}\n` +
        `Nombre de ventes: ${sales.length}\n\n` +
        `<i>Pas de rapport Z (caisse non clôturée)</i>`
      );
    } else {
      await sendMessage(
        chatId,
        `Aucune donnée pour <b>${storeName}</b> le ${formatDateFR(date)}\n\n` +
        `<i>Le magasin était peut-être fermé.</i>`
      );
    }
    return;
  }

  // Build detailed message
  const message = `
<b>${storeName} - ${formatDateFR(date)}</b>

<b>CA TTC: ${formatEUR(report.total_ttc || 0)}</b>
CA HT: ${formatEUR(report.total_ht || 0)}
Nombre de ventes: ${report.sales_count || 0}

<b>Paiements :</b>
CB: ${formatEUR(report.card_total || 0)}
Espèces: ${formatEUR(report.cash_total || 0)}
${report.check_total ? `Chèques: ${formatEUR(report.check_total)}` : ""}
${report.credit_total ? `Avoirs: ${formatEUR(report.credit_total)}` : ""}

<b>TVA :</b>
${formatTaxDetails(report.tax_details || report.raw_data?.taxes)}
  `.trim();

  await sendMessage(chatId, message);
}

/**
 * Handle /rapport command
 */
async function handleRapportCommand(
  chatId: number,
  args: string,
  supabase: any
): Promise<void> {
  const date = args ? parseDate(args) : getTodayDate();

  if (!date) {
    await sendMessage(
      chatId,
      `Date non reconnue: "${args}"\n\nFormats acceptés : 20/12, 2025-12-20, hier`
    );
    return;
  }

  // Fetch all Z reports for the date
  const { data: reports, error } = await supabase
    .from("daily_z_reports")
    .select(`
      *,
      stores(name)
    `)
    .eq("report_date", date)
    .order("store_id");

  if (error) {
    console.error("Error fetching Z reports:", error);
    await sendMessage(chatId, "Erreur lors de la récupération des données.");
    return;
  }

  if (!reports || reports.length === 0) {
    await sendMessage(
      chatId,
      `Aucun rapport Z pour le <b>${formatDateFR(date)}</b>`
    );
    return;
  }

  // Build detailed report
  let message = `<b>RAPPORT DU ${formatDateFR(date).toUpperCase()}</b>\n\n`;

  let grandTotalTTC = 0;
  let grandTotalHT = 0;
  let grandTotalSales = 0;
  let grandCash = 0;
  let grandCard = 0;

  for (const report of reports) {
    const storeName = report.stores?.name || STORE_NAMES[report.store_id];
    grandTotalTTC += report.total_ttc || 0;
    grandTotalHT += report.total_ht || 0;
    grandTotalSales += report.sales_count || 0;
    grandCash += report.cash_total || 0;
    grandCard += report.card_total || 0;

    message += `<b>${storeName}</b>\n`;
    message += `TTC: ${formatEUR(report.total_ttc || 0)} | HT: ${formatEUR(report.total_ht || 0)}\n`;
    message += `${report.sales_count || 0} ventes | CB: ${formatEUR(report.card_total || 0)} | ESP: ${formatEUR(report.cash_total || 0)}\n\n`;
  }

  message += `<b>═══ TOTAUX ═══</b>\n`;
  message += `<b>CA TTC: ${formatEUR(grandTotalTTC)}</b>\n`;
  message += `CA HT: ${formatEUR(grandTotalHT)}\n`;
  message += `Ventes: ${grandTotalSales}\n`;
  message += `CB: ${formatEUR(grandCard)} | ESP: ${formatEUR(grandCash)}`;

  await sendMessage(chatId, message);
}

/**
 * Handle /stats command
 */
async function handleStatsCommand(
  chatId: number,
  args: string,
  supabase: any
): Promise<void> {
  const today = new Date();
  let startDate: string;
  let endDate = getTodayDate();
  let periodLabel: string;

  const period = args.toLowerCase().trim();

  if (period === "semaine" || period === "week") {
    // Start of current week (Monday)
    const dayOfWeek = today.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - diff);
    startDate = monday.toISOString().split("T")[0];
    periodLabel = "cette semaine";
  } else if (period === "mois" || period === "month" || period === "") {
    // Start of current month
    startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    periodLabel = "ce mois";
  } else {
    await sendMessage(
      chatId,
      `Période non reconnue: "${args}"\n\nUtilisez : /stats, /stats semaine, /stats mois`
    );
    return;
  }

  // Fetch Z reports for the period
  const { data: reports, error } = await supabase
    .from("daily_z_reports")
    .select("store_id, total_ttc, sales_count, report_date")
    .gte("report_date", startDate)
    .lte("report_date", endDate);

  if (error) {
    console.error("Error fetching stats:", error);
    await sendMessage(chatId, "Erreur lors de la récupération des statistiques.");
    return;
  }

  if (!reports || reports.length === 0) {
    await sendMessage(chatId, `Aucune donnée pour ${periodLabel}.`);
    return;
  }

  // Aggregate by store
  const storeStats: Record<number, { total: number; sales: number; days: number }> = {};
  const dailyTotals: Record<string, number> = {};

  for (const report of reports) {
    if (!storeStats[report.store_id]) {
      storeStats[report.store_id] = { total: 0, sales: 0, days: 0 };
    }
    storeStats[report.store_id].total += report.total_ttc || 0;
    storeStats[report.store_id].sales += report.sales_count || 0;
    storeStats[report.store_id].days += 1;

    dailyTotals[report.report_date] = (dailyTotals[report.report_date] || 0) + (report.total_ttc || 0);
  }

  const totalDays = Object.keys(dailyTotals).length;
  const grandTotal = Object.values(dailyTotals).reduce((a, b) => a + b, 0);
  const avgDaily = grandTotal / totalDays;

  let message = `<b>STATISTIQUES - ${periodLabel.toUpperCase()}</b>\n`;
  message += `Du ${startDate} au ${endDate}\n\n`;
  message += `<b>TOTAL: ${formatEUR(grandTotal)}</b>\n`;
  message += `${totalDays} jours | Moyenne: ${formatEUR(avgDaily)}/jour\n\n`;

  message += `<b>Par magasin :</b>\n`;
  for (const [storeId, stats] of Object.entries(storeStats).sort((a, b) => b[1].total - a[1].total)) {
    const storeName = STORE_NAMES[parseInt(storeId)];
    message += `${storeName}: ${formatEUR(stats.total)} (${stats.sales} ventes)\n`;
  }

  await sendMessage(chatId, message);
}

/**
 * Format tax details for display
 */
function formatTaxDetails(taxes: any[] | undefined): string {
  if (!taxes || taxes.length === 0) return "Aucun détail TVA";

  return taxes
    .filter((t: any) => t.amount && parseFloat(t.amount) > 0)
    .map((t: any) => `TVA ${t.rate || t.tax_rate}%: ${formatEUR(parseFloat(t.amount || t.tax_amount || 0))}`)
    .join("\n") || "Aucun détail TVA";
}
