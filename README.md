# Multi-Store E-commerce Analytics Platform

> Real-time sales analytics, inventory alerts, and data reconciliation for a 6-store retail chain. Built with Supabase Edge Functions, PostgreSQL, and Telegram bot integration. **In production since October 2025.**

## Architecture

```
POS System (2 APIs)          Supabase Edge Functions          PostgreSQL
├─ Primary API (4 stores)    ├─ unified-analytics/            ├─ sale_items (62K+ rows)
│  Store-A, Store-B,         │  22 analytics actions          ├─ daily_z_reports
│  Store-C, Store-D          ├─ webhook-sale/                 ├─ products (12K+)
└─ Secondary API (2 stores)  │  Real-time enrichment          ├─ customers (4.8K+)
   Store-E, Store-F          ├─ data-reconciliation/          ├─ categories, brands
                             │  Auto-fix pipeline             ├─ vendors, stores
                             ├─ data-quality-check/           ├─ webhook_raw_payloads
                             │  Monitoring + alerts           ├─ data_anomalies
                             ├─ sync-master-data/             └─ security_audit_log
                             │  Daily catalog sync
                             ├─ telegram-notify/              pg_cron (10 scheduled jobs)
                             │  Alert notifications           ├─ Daily sync at 6h
                             └─ 8 more functions              ├─ Quality checks at 7h
                                                              ├─ Reconciliation at 8h
Security Layer                                                ├─ Auto-fix at 8h30
├─ Rate Limiting (per-function/IP)                            └─ Hourly cleanup
├─ RLS (strict row-level policies)
├─ Input Validation (all endpoints)
└─ Security Audit Log
```

## Key Technical Challenges

### 1. Dual-API Reconciliation

Two separate POS API accounts serve different stores with **different vendor IDs** for the same employees. The system maintains a cross-API vendor mapping to produce unified analytics across all 6 stores.

### 2. Real-time Webhook Enrichment Pipeline

Each incoming sale webhook triggers a multi-step enrichment:
- Full ID lookups (product, brand, category hierarchy)
- Category hierarchy resolution (parent → grandparent)
- Canonical vendor mapping (cross-API deduplication)
- Auto-insertion of unknown products/brands/customers
- Raw payload backup before processing

### 3. Pagination-Safe Bulk Queries

Supabase limits responses to 1,000 rows. The `fetchAllRows()` helper handles pagination with a critical requirement: **stable ordering via `.order('id')`** to prevent row duplication across pages. This bug was discovered in production when vendor totals were inflated due to unstable pagination.

### 4. Self-Healing Data Pipeline

The system is designed to be anti-fragile:
- **Daily reconciliation** compares local data against the POS API and auto-imports missing sales
- **Orphan detection** tags sales present locally but absent from POS Z-reports
- **Data integrity checks** run daily with automatic fix pipeline
- **Reference snapshots** with checksums detect drift in master data
- **Quality scoring** (0-100) with Telegram alerts for critical issues

### 5. Rate Limiting & Security Hardening

4-phase security implementation:
- Per-function, per-IP rate limiting via PostgreSQL function
- Row Level Security with strict separation (sensitive vs. catalog tables)
- Input validation on all Edge Function parameters
- Security audit log for auth failures and rate limit hits

## Edge Functions (14 Deployed)

| Function | Purpose |
|----------|---------|
| `unified-analytics` | Main analytics API — **22 actions** (dashboard, rankings, challenges, trends, anomalies) |
| `webhook-hiboutik-sale` | Real-time sale ingestion with full enrichment pipeline + raw payload backup |
| `data-reconciliation` | Compares local DB vs POS API — auto-imports missing sales, tags orphans |
| `data-quality-check` | Data quality monitoring (score 0-100) + Telegram alerts |
| `sync-master-data` | Daily sync of stores, vendors, brands, categories, products from both APIs |
| `sync-customers` | Customer sync with `first_purchase_date` calculated from sales history |
| `recover-missing-sales` | Manual recovery of sales by ID range |
| `import-z-reports` | Daily Z-report import (cash register reconciliation) |
| `get-stock-alerts` | Stock alerts by store with severity levels |
| `db-query` | Direct SQL execution (JWT protected, rate limited to 5/min) |
| `telegram-webhook` | Telegram bot command handler |
| `telegram-notify` | Notification service for alerts |
| `sync-supply-prices` | Product supply price synchronization |
| `refresh-supply-prices` | Triggers POS supply price recalculation |

## Analytics Engine — 22 Actions

```
BASE                          CHALLENGES                    REAL-TIME
─────────────────────────     ─────────────────────────     ─────────────────────────
dashboard                     product_challenge             realtime_sales
vendor_details                team_challenge                velocity_products
vendor_ranking                combo_challenge
category_sales
product_performance           ANOMALIES                     ADVANCED PRODUCTS
cross_analysis                ─────────────────────────     ─────────────────────────
customer_acquisition          anomaly_detection             products_margin
                              vendors_underperforming       products_declining
ADVANCED ANALYSIS                                           product_rotation
─────────────────────────     BENCHMARK                     vendors_high_margin
discount_analysis             ─────────────────────────
trend_analysis                vendor_benchmark
brand_share
```

## Database Schema

### Core Tables (18 tables, all with RLS)

| Table | Rows | Purpose |
|-------|------|---------|
| `sale_items` | 62,734+ | **Main denormalized fact table** — all sales with product/vendor/store data captured at sale time |
| `customers` | 4,879 | Customer profiles with loyalty data and `first_purchase_date` |
| `products` | 12,589 | Product catalog with pricing |
| `product_variants` | 2,389 | Product variants (sizes, colors, nicotine levels) |
| `stock` | 18,886 | Stock levels per product per store |
| `categories` | 167 | Category hierarchy via `parent_id` |
| `brands` | 599 | Product brands |
| `vendors` | 60 | Sales staff (25 active, mapped across both APIs) |
| `vendor_mapping` | 37 | Cross-API vendor ID mapping |
| `stores` | 7 | Store locations |
| `daily_z_reports` | 541 | Daily cash reconciliation records |
| `sync_logs` | ~7,400 | Sync history (auto-purged) |
| `webhook_raw_payloads` | 214+ | Raw webhook payload backup with processing status |
| `data_anomalies` | 7 | Detected anomalies with severity and auto-fix status |
| `reference_snapshots` | 10 | Daily reference table snapshots with checksums |
| `product_quantity_rules` | 4 | Quantity normalization rules |
| `rate_limits` | 0 | Per-function rate limiting (auto-purged hourly) |
| `security_audit_log` | 0 | Security event logging |

### RLS Policies

- **Sensitive tables** (sale_items, customers, sync_logs, webhook_raw_payloads): `service_role` only
- **Catalog tables** (products, brands, categories, stores): public SELECT + service_role full access

## Scheduled Jobs (pg_cron)

| Schedule (Paris) | Job | Purpose |
|------------------|-----|---------|
| 2h | cleanup-old-data | Purge old backups and snapshots |
| 3h Sunday | weekly-extended-fix | Fix category mismatches (90 days) |
| 6h | sync-master-data | Sync all master data from POS |
| 7h | backup-snapshots | Snapshot reference tables |
| 7h | data-quality-check | Quality monitoring + Telegram alerts |
| 8h | data-reconciliation | Reconcile local DB vs POS + auto-fix |
| 8h | category-consistency | Verify category coherence |
| 8h | integrity-check | Data integrity checks + log anomalies |
| 8h30 | auto-fix | Auto-correct detected inconsistencies |
| Hourly | cleanup-rate-limits | Purge expired rate limit entries |

## Tech Stack

- **Database**: PostgreSQL (Supabase) with pg_cron, RLS, Vault
- **Edge Functions**: Deno 2 / TypeScript (Supabase Edge Functions)
- **POS Integration**: Hiboutik API (dual-account architecture)
- **Notifications**: Telegram Bot API
- **Automation**: n8n workflows for bot orchestration
- **Monitoring**: Custom data quality scoring + anomaly detection

## Project Structure

```
ecommerce-analytics-platform/
├── .env.example                        # Environment variable template
├── .gitignore
├── README.md
├── supabase/
│   ├── config.toml                     # Supabase local config
│   ├── migrations/                     # 7 SQL migrations (schema + security)
│   │   ├── 20241222_create_daily_z_reports.sql
│   │   ├── 20260130_security_phase2_rate_limits.sql
│   │   ├── 20260130_security_phase2_rls_policies.sql
│   │   ├── 20260130_security_phase3_audit_log.sql
│   │   └── 20260130_security_phase4_integrity_checks.sql
│   └── functions/
│       ├── _shared/                    # 13 shared modules
│       │   ├── hiboutik-client.ts      # Dual-API POS client with pagination
│       │   ├── rate-limiter.ts         # Per-function/IP rate limiting
│       │   ├── pagination.ts           # fetchAllRows() for >1000 rows
│       │   ├── categories.ts           # Category hierarchy resolution
│       │   ├── validation.ts           # Input validation + bounds checking
│       │   ├── cors.ts                 # Dynamic CORS with origin whitelist
│       │   └── ...                     # telegram, dates, pricing, errors
│       ├── unified-analytics/          # Analytics engine (22 actions)
│       │   ├── index.ts                # Router (~12KB)
│       │   ├── types.ts               # TypeScript interfaces
│       │   └── actions/                # Modular action handlers
│       ├── webhook-hiboutik-sale/      # Real-time sale webhook
│       ├── data-reconciliation/        # Auto-reconciliation engine
│       └── ...                         # 10 more functions
```

## Getting Started

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) >= 1.150.0
- A Supabase project
- POS system API credentials (Hiboutik or compatible)
- Telegram bot token (for notifications)

### Setup

```bash
# Clone
git clone https://github.com/your-username/ecommerce-analytics-platform.git
cd ecommerce-analytics-platform

# Link to your Supabase project
npx supabase link --project-ref your-project-ref

# Configure secrets
cp .env.example .env
# Edit .env with your credentials, then:
npx supabase secrets set --env-file .env

# Apply migrations
npx supabase db push

# Deploy Edge Functions
npx supabase functions deploy unified-analytics
npx supabase functions deploy webhook-hiboutik-sale --no-verify-jwt  # POS webhooks don't send auth headers
# ... deploy remaining functions
```

## Data Quality

The system maintains a **100/100 data quality score** through:
- Daily automated integrity checks (9 check types)
- Smart auto-fix pipeline for category/brand/vendor inconsistencies
- Reference table snapshots with checksum-based drift detection
- Telegram alerts for critical anomalies
- Orphan sale detection and tagging

## License

This project is shared as a portfolio piece. The code demonstrates a real production system architecture.

---

*Built and maintained as a production system serving 6 retail stores since October 2025.*
