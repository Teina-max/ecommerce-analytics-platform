/**
 * Utilitaires de calcul de prix HT/TTC
 * Version: 1.0
 */

import { TVA_RATE } from './constants.ts'

export type DisplayMode = 'ttc' | 'ht' | 'both'

/**
 * Calcule le montant HT a partir du TTC
 * @param ttc Montant TTC
 * @param taxRate Taux de TVA (0.2 = 20%). Si non fourni, utilise TVA_RATE par defaut
 */
export function calculateHT(ttc: number, taxRate: number = TVA_RATE): number {
  return ttc / (1 + taxRate)
}

/**
 * Calcule le montant TTC a partir du HT
 * @param ht Montant HT
 * @param taxRate Taux de TVA (0.2 = 20%). Si non fourni, utilise TVA_RATE par defaut
 */
export function calculateTTC(ht: number, taxRate: number = TVA_RATE): number {
  return ht * (1 + taxRate)
}

/**
 * Formate un montant selon le mode d'affichage
 * @param ttc Montant TTC
 * @param display Mode d'affichage: 'ttc', 'ht', ou 'both'
 * @param taxRate Taux de TVA (optionnel)
 * @param prefix Prefixe pour les cles (ex: 'total_revenue' -> 'total_revenue_ttc', 'total_revenue_ht')
 */
export function formatAmount(
  ttc: number,
  display: DisplayMode = 'ttc',
  taxRate: number = TVA_RATE,
  prefix?: string
): Record<string, number> {
  const ht = calculateHT(ttc, taxRate)
  const ttcRounded = parseFloat(ttc.toFixed(2))
  const htRounded = parseFloat(ht.toFixed(2))

  if (prefix) {
    switch (display) {
      case 'ht':
        return { [`${prefix}_ht`]: htRounded }
      case 'both':
        return { [`${prefix}_ttc`]: ttcRounded, [`${prefix}_ht`]: htRounded }
      case 'ttc':
      default:
        return { [`${prefix}_ttc`]: ttcRounded }
    }
  }

  switch (display) {
    case 'ht':
      return { amount_ht: htRounded }
    case 'both':
      return { amount_ttc: ttcRounded, amount_ht: htRounded }
    case 'ttc':
    default:
      return { amount_ttc: ttcRounded }
  }
}

/**
 * Cree un objet avec les montants TTC et/ou HT selon le mode
 * Utile pour les summaries et totaux
 */
export function createAmountFields(
  ttc: number,
  display: DisplayMode = 'ttc',
  taxRate: number = TVA_RATE
): { ttc?: number; ht?: number; total?: number } {
  const htValue = parseFloat(calculateHT(ttc, taxRate).toFixed(2))
  const ttcValue = parseFloat(ttc.toFixed(2))

  switch (display) {
    case 'ht':
      return { ht: htValue, total: htValue }
    case 'both':
      return { ttc: ttcValue, ht: htValue }
    case 'ttc':
    default:
      return { ttc: ttcValue, total: ttcValue }
  }
}

/**
 * Retourne le label pour les montants selon le mode
 */
export function getAmountLabel(display: DisplayMode = 'ttc'): string {
  switch (display) {
    case 'ht':
      return 'HT'
    case 'both':
      return 'TTC + HT'
    case 'ttc':
    default:
      return 'TTC'
  }
}
