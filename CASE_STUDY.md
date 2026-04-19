# Case Study — E-commerce Analytics Platform

> Portfolio write-up of a production system serving a 6-store retail
> chain since October 2025. Store names, metrics, and client identity
> are redacted; every architectural decision and trade-off below
> reflects the real build.

## The context

A 6-store retail chain was running on **two separate POS accounts**
(one vendor, two billing contracts) for historical reasons. This
meant two API endpoints, two sets of vendor IDs for the same
employees, and no consolidated view of revenue. Their internal
reporting was a manual Excel consolidation once a month.

The ask: real-time unified analytics across all 6 stores, with
anomaly alerting, and a path to eventually migrate the two accounts
onto one — without breaking the running stores during the transition.

## What shipped

- **14 Supabase Edge Functions** covering analytics, real-time
  webhook ingestion, reconciliation, data quality checks, master-data
  sync, and Telegram alerts.
- **22 analytics actions** routed through a single
  `unified-analytics` function (revenue, top products, customer
  cohorts, store comparisons, vendor ranking, period KPIs).
- **Dual-API POS integration** with a canonical vendor mapping table
  to deduplicate the same person across the two accounts.
- **Real-time sale webhook** that enriches each transaction (product
  hierarchy, category resolution, brand hydration) before it lands in
  `sale_items`.
- **Self-healing data pipeline**: daily reconciliation of local DB vs
  POS Z-reports, orphan detection, auto-fix for category / brand /
  vendor drifts, reference-snapshot checksums.
- **Telegram bot** for operational alerts (data anomalies, quality
  score drops, reconciliation failures).

**Scale in production** (as of April 2026): 62k+ `sale_items`,
12k+ products, 4.8k+ customers, 541 daily Z-reports, 214+ raw
webhook payloads, data quality score stable at **100/100**.

## Architecture decisions I'd make again

### 1. Supabase Edge Functions over a hosted backend

Deno-based edge functions, no container to provision, auto-scaled by
Supabase. The 14 functions share a `_shared/` module with the dual
HTTP client, rate limiter, pagination helper, category resolver, and
input validator. Cold-start cost was never an issue for webhook
latency.

### 2. pg_cron as the only scheduler

10 scheduled jobs live inside Postgres (daily sync, quality check,
reconciliation, auto-fix, snapshotting, rate-limit cleanup). No
external Airflow / Temporal / n8n cron. One schema, one backup,
one source of truth for "what runs when".

### 3. fetchAllRows() with stable ordering

Supabase caps responses at 1000 rows. The generic pagination helper
enforces `.order('id')` — not because it's nice to have, but because
an unstable ordering **duplicated rows across pages**, which silently
inflated vendor totals in production for 3 days before I caught it
by hand-checking a store's daily revenue. That bug is the reason
every bulk read in the codebase goes through one helper.

### 4. Raw webhook payload backup

Every sale webhook writes its raw JSON to `webhook_raw_payloads`
**before** enrichment. If enrichment fails or a category lookup
crashes, the sale is not lost — I replay from the raw table. This
has saved three partial outages already.

### 5. Security as phases, not a chapter

Security shipped in 4 explicit phases (rate limiting → RLS → input
validation + audit log → integrity checks). Each phase had its own
migration. Forcing myself to ship them as phases meant none of them
got deferred into "we'll do it later".

## What I'd do differently

- **Deno testing from day 1.** The first 6 months had zero tests on
  the Edge Functions. I added Deno test harness retroactively for
  the critical paths (webhook-sale, reconciliation); should have
  started there.
- **Schema versioning for webhook payloads.** When the POS vendor
  added a new field, the webhook enricher crashed silently on
  undefined access. A Zod schema at the edge would have caught it.
- **Move reconciliation out of pg_cron.** It's the heaviest job
  (~90s on bad days) and has started to overlap with the next cron.
  A queue worker would be more honest.

## Stack

Supabase (Postgres + Edge Functions + Vault + pg_cron) · Deno 2 /
TypeScript · Hiboutik POS API (dual-account) · Telegram Bot API ·
n8n (bot orchestration).
