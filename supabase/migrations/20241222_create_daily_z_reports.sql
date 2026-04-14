-- Migration: Create daily_z_reports table for Z reports
-- Date: 2024-12-22

CREATE TABLE IF NOT EXISTS public.daily_z_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identifiants
    store_id INTEGER NOT NULL REFERENCES public.stores(id),
    report_date DATE NOT NULL,
    hiboutik_report_id INTEGER,

    -- Totaux de caisse
    total_ttc DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_ht DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_tva DECIMAL(12,2) NOT NULL DEFAULT 0,

    -- Nombre de transactions
    sales_count INTEGER NOT NULL DEFAULT 0,
    items_sold INTEGER NOT NULL DEFAULT 0,
    average_basket DECIMAL(10,2) GENERATED ALWAYS AS (
        CASE WHEN sales_count > 0 THEN total_ttc / sales_count ELSE 0 END
    ) STORED,

    -- Ventilation par moyen de paiement
    cash_total DECIMAL(12,2) DEFAULT 0,
    card_total DECIMAL(12,2) DEFAULT 0,
    other_payment_total DECIMAL(12,2) DEFAULT 0,
    payment_details JSONB DEFAULT '{}',

    -- Écarts de caisse
    expected_cash DECIMAL(12,2),
    actual_cash DECIMAL(12,2),
    cash_difference DECIMAL(10,2) GENERATED ALWAYS AS (
        actual_cash - expected_cash
    ) STORED,

    -- Remises et annulations
    total_discounts DECIMAL(12,2) DEFAULT 0,
    refunds_count INTEGER DEFAULT 0,
    refunds_total DECIMAL(12,2) DEFAULT 0,

    -- Données brutes API
    raw_data JSONB,
    api_source VARCHAR(20) DEFAULT 'primary',

    -- Métadonnées
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Contrainte d'unicité
    CONSTRAINT daily_z_reports_store_date_api_unique
        UNIQUE (store_id, report_date, api_source)
);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_z_reports_store_date
    ON public.daily_z_reports(store_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_z_reports_date
    ON public.daily_z_reports(report_date DESC);

CREATE INDEX IF NOT EXISTS idx_z_reports_cash_difference
    ON public.daily_z_reports(cash_difference)
    WHERE cash_difference IS NOT NULL AND cash_difference != 0;

-- Trigger pour updated_at
CREATE OR REPLACE FUNCTION update_z_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_z_reports_updated_at ON public.daily_z_reports;
CREATE TRIGGER trigger_z_reports_updated_at
    BEFORE UPDATE ON public.daily_z_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_z_reports_updated_at();

-- RLS (Row Level Security)
ALTER TABLE public.daily_z_reports ENABLE ROW LEVEL SECURITY;

-- Politique pour lecture (authentifié)
CREATE POLICY "Allow authenticated read" ON public.daily_z_reports
    FOR SELECT TO authenticated
    USING (true);

-- Politique pour service role (full access)
CREATE POLICY "Allow service role full access" ON public.daily_z_reports
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.daily_z_reports IS 'Rapports Z quotidiens par magasin';
COMMENT ON COLUMN public.daily_z_reports.cash_difference IS 'Écart de caisse (positif = excédent, négatif = manquant)';
