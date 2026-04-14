import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendMessage } from "../_shared/telegram.ts";

/**
 * Data Quality Check - Alertes automatiques de qualité des données
 *
 * FONCTIONNALITÉS:
 * - Vérifie les produits sans marque/supply_price
 * - Détecte les ventes orphelines (produit/store supprimé)
 * - Vérifie le taux de remplissage des champs critiques
 * - Envoie alerte Telegram si seuils dépassés
 *
 * SCHEDULING:
 * - Via pg_cron quotidien à 7h Paris (après sync-master-data à 6h)
 *
 * PARAMS:
 * - dry_run: true pour simuler sans envoyer d'alerte
 * - verbose: true pour afficher tous les détails
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface QualityMetric {
  name: string;
  total: number;
  issues: number;
  threshold: number; // % issues above which to alert
  severity: "critical" | "warning" | "info";
  details?: string;
}

interface QualityReport {
  timestamp: string;
  metrics: QualityMetric[];
  overallScore: number; // 0-100
  alertsTriggered: boolean;
}

async function runQuery(supabase: any, sql: string): Promise<any[]> {
  // Use the db-query function or direct REST API
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`
    },
    body: JSON.stringify({ query_text: sql })
  });

  if (!response.ok) {
    // Fallback: try direct query via pg
    console.log(`[DATA-QUALITY] RPC failed, using fallback`);
    return [];
  }

  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dry_run") === "true";
    const verbose = url.searchParams.get("verbose") === "true";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`[DATA-QUALITY] Starting check (dry_run=${dryRun}, verbose=${verbose})`);

    const metrics: QualityMetric[] = [];

    // ============================================
    // CHECK 1: Produits sans hiboutik_brand_id
    // ============================================
    const { count: productsWithoutBrand } = await supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .or("hiboutik_brand_id.is.null,hiboutik_brand_id.eq.0");

    const { count: totalProducts } = await supabase
      .from("products")
      .select("*", { count: "exact", head: true });

    if (productsWithoutBrand !== null && totalProducts !== null) {
      metrics.push({
        name: "Produits sans marque",
        total: totalProducts,
        issues: productsWithoutBrand,
        threshold: 50,
        severity: "warning",
        details: `${productsWithoutBrand} produits n'ont pas de hiboutik_brand_id`
      });
    }

    // ============================================
    // CHECK 2: Produits sans supply_price
    // ============================================
    const { count: productsWithoutSupply } = await supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .or("product_supply_price.is.null,product_supply_price.eq.0");

    if (productsWithoutSupply !== null && totalProducts !== null) {
      metrics.push({
        name: "Produits sans prix d'achat",
        total: totalProducts,
        issues: productsWithoutSupply,
        threshold: 40,
        severity: "warning",
        details: `${productsWithoutSupply} produits sans prix d'achat`
      });
    }

    // ============================================
    // CHECK 3: Sale items sans store_id valide
    // ============================================
    const { count: salesWithoutStore } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true })
      .is("store_id", null);

    const { count: totalSales } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true });

    if (salesWithoutStore !== null && totalSales !== null) {
      metrics.push({
        name: "Ventes sans magasin",
        total: totalSales,
        issues: salesWithoutStore,
        threshold: 1,
        severity: "critical",
        details: `${salesWithoutStore} ventes n'ont pas de store_id`
      });
    }

    // ============================================
    // CHECK 4: Sale items sans hiboutik_product_id
    // ============================================
    const { count: salesWithoutProduct } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true })
      .is("hiboutik_product_id", null);

    if (salesWithoutProduct !== null && totalSales !== null) {
      metrics.push({
        name: "Ventes sans produit",
        total: totalSales,
        issues: salesWithoutProduct,
        threshold: 5,
        severity: "warning",
        details: `${salesWithoutProduct} ventes sans hiboutik_product_id`
      });
    }

    // ============================================
    // CHECK 5: Sale items sans brand (là où produit a une marque)
    // ============================================
    const { count: salesWithoutBrand } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true })
      .is("hiboutik_brand_id", null)
      .not("hiboutik_product_id", "is", null);

    if (salesWithoutBrand !== null && totalSales !== null) {
      metrics.push({
        name: "Ventes sans marque",
        total: totalSales,
        issues: salesWithoutBrand,
        threshold: 30,
        severity: "info",
        details: `${salesWithoutBrand} ventes sans hiboutik_brand_id`
      });
    }

    // ============================================
    // CHECK 6: Ventes aujourd'hui (fraîcheur)
    // ============================================
    const todayParis = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
    const { count: salesToday } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true })
      .gte("sold_at", `${todayParis}T00:00:00+01:00`);

    const now = new Date();
    const parisHour = parseInt(now.toLocaleString("en-US", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }));

    if (salesToday !== null && parisHour >= 11 && salesToday === 0) {
      metrics.push({
        name: "Ventes aujourd'hui",
        total: 1,
        issues: 1,
        threshold: 0,
        severity: "critical",
        details: "Aucune vente reçue aujourd'hui après 11h - vérifier webhooks!"
      });
    }

    // ============================================
    // CHECK 7: Vendeurs actifs
    // ============================================
    const { count: totalVendors } = await supabase
      .from("vendors")
      .select("*", { count: "exact", head: true });

    const { count: vendorsWithoutId } = await supabase
      .from("vendors")
      .select("*", { count: "exact", head: true })
      .is("hiboutik_user_id", null);

    if (vendorsWithoutId !== null && totalVendors !== null && totalVendors > 0) {
      metrics.push({
        name: "Vendeurs sans ID Hiboutik",
        total: totalVendors,
        issues: vendorsWithoutId,
        threshold: 10,
        severity: "warning",
        details: `${vendorsWithoutId} vendeurs sans mapping`
      });
    }

    // ============================================
    // CHECK 8: Magasins actifs
    // ============================================
    const { count: activeStores } = await supabase
      .from("stores")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true);

    if (activeStores !== null && activeStores < 6) {
      metrics.push({
        name: "Magasins actifs",
        total: 6,
        issues: 6 - activeStores,
        threshold: 0,
        severity: "warning",
        details: `Seulement ${activeStores}/6 magasins actifs`
      });
    }

    // ============================================
    // CHECK 9: Dernière sync (via products.synced_at)
    // ============================================
    const { data: lastSyncData } = await supabase
      .from("products")
      .select("synced_at")
      .not("synced_at", "is", null)
      .order("synced_at", { ascending: false })
      .limit(1)
      .single();

    if (lastSyncData?.synced_at) {
      const lastSyncDate = new Date(lastSyncData.synced_at);
      const hoursSinceSync = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);

      if (hoursSinceSync > 48) {
        metrics.push({
          name: "Dernière synchronisation",
          total: 48,
          issues: Math.round(hoursSinceSync),
          threshold: 0,
          severity: "critical",
          details: `Dernière sync: ${lastSyncDate.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (${Math.round(hoursSinceSync)}h)`
        });
      }
    }

    // ============================================
    // CHECK 10: Sale items sans tax_rate
    // ============================================
    const { count: salesWithoutTax } = await supabase
      .from("sale_items")
      .select("*", { count: "exact", head: true })
      .is("tax_rate", null);

    if (salesWithoutTax !== null && totalSales !== null) {
      metrics.push({
        name: "Ventes sans TVA",
        total: totalSales,
        issues: salesWithoutTax,
        threshold: 5,
        severity: "warning",
        details: `${salesWithoutTax} ventes sans tax_rate`
      });
    }

    // ============================================
    // Calculer le score global et alertes
    // ============================================
    let criticalCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    const alertMessages: string[] = [];

    for (const metric of metrics) {
      const percentage = metric.total > 0 ? (metric.issues / metric.total) * 100 : 0;

      if (percentage > metric.threshold || (metric.threshold === 0 && metric.issues > 0)) {
        if (metric.severity === "critical") {
          criticalCount++;
          alertMessages.push(`🔴 <b>${metric.name}</b>: ${metric.issues.toLocaleString("fr-FR")}/${metric.total.toLocaleString("fr-FR")} (${percentage.toFixed(1)}%)`);
        } else if (metric.severity === "warning") {
          warningCount++;
          alertMessages.push(`🟡 <b>${metric.name}</b>: ${metric.issues.toLocaleString("fr-FR")}/${metric.total.toLocaleString("fr-FR")} (${percentage.toFixed(1)}%)`);
        } else {
          infoCount++;
          if (verbose) {
            alertMessages.push(`🔵 ${metric.name}: ${metric.issues.toLocaleString("fr-FR")}/${metric.total.toLocaleString("fr-FR")}`);
          }
        }

        if (metric.details && verbose) {
          alertMessages.push(`   ↳ ${metric.details}`);
        }
      }
    }

    // Score: 100 - (critiques*20 + warnings*5)
    const overallScore = Math.max(0, 100 - (criticalCount * 20) - (warningCount * 5));
    const alertsTriggered = criticalCount > 0;

    const report: QualityReport = {
      timestamp: new Date().toISOString(),
      metrics,
      overallScore,
      alertsTriggered
    };

    console.log(`[DATA-QUALITY] Score: ${overallScore}/100, Critical: ${criticalCount}, Warnings: ${warningCount}, Info: ${infoCount}`);

    // ============================================
    // Envoyer alerte Telegram si nécessaire
    // ============================================
    const chatId = parseInt(Deno.env.get("TELEGRAM_CHAT_ID") || "0");

    if (alertsTriggered && !dryRun && chatId) {
      const scoreEmoji = overallScore >= 80 ? "🟢" : overallScore >= 60 ? "🟡" : "🔴";
      const message = `
⚠️ <b>ALERTE QUALITÉ DONNÉES</b>

${scoreEmoji} Score: <b>${overallScore}/100</b>
🔴 Critiques: ${criticalCount} | 🟡 Warnings: ${warningCount}

${alertMessages.join("\n")}

<i>${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</i>
      `.trim();

      const sent = await sendMessage(chatId, message);
      console.log(`[DATA-QUALITY] Telegram alert sent: ${sent}`);
    }

    // Rapport quotidien verbose (même si pas d'alerte)
    if (verbose && !dryRun && chatId && !alertsTriggered) {
      const message = `
✅ <b>RAPPORT QUALITÉ DONNÉES</b>

🟢 Score: <b>${overallScore}/100</b>
Aucun problème critique détecté.
📊 ${totalSales?.toLocaleString("fr-FR") || 0} ventes | ${totalProducts?.toLocaleString("fr-FR") || 0} produits

<i>${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</i>
      `.trim();

      await sendMessage(chatId, message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        verbose,
        report,
        alerts: alertMessages.length > 0 ? alertMessages : ["Aucune alerte"]
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("[DATA-QUALITY] Error:", error);

    // Envoyer alerte d'erreur
    const chatId = parseInt(Deno.env.get("TELEGRAM_CHAT_ID") || "0");
    if (chatId) {
      await sendMessage(chatId, `
🚨 <b>ERREUR DATA-QUALITY-CHECK</b>

${error.message}

<i>${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</i>
      `.trim());
    }

    const errorId = crypto.randomUUID().slice(0, 8);
    return new Response(
      JSON.stringify({ error: "Erreur interne du serveur", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
