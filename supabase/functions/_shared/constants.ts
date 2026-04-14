/**
 * Constantes partagées pour toutes les Edge Functions
 * Version: 1.0
 */

/**
 * IDs des catégories virtuelles à exclure par défaut
 * (codes promo, gravure, coffrets cadeaux, divers)
 */
export const VIRTUAL_CATEGORY_IDS = [8, 9, 10, 11]

/**
 * IDs des vendeurs techniques à exclure (comptes admin)
 * Admin-User: main=1, secondary=1068
 */
export const EXCLUDED_VENDOR_IDS = [1, 1068]

/**
 * Noms des magasins par ID
 */
export const STORE_NAMES: Record<number, string> = {
  1: 'Store-A',
  2: 'Store-B',
  3: 'Store-C',
  5: 'Store-E',
  6: 'Store-F',
  39: 'Store-D'
}

/**
 * Alias des magasins pour la recherche
 */
export const STORE_ALIASES: Record<string, number> = {
  // Store-A
  'store-a': 1,
  'sa': 1,
  // Store-B
  'store-b': 2,
  'sb': 2,
  // Store-C
  'store-c': 3,
  'sc': 3,
  // Store-D
  'store-d': 39,
  'sd': 39,
  // Store-E
  'store-e': 5,
  'se': 5,
  // Store-F
  'store-f': 6,
  'sf': 6
}

/**
 * Mapping des vendor_id entre les deux APIs Hiboutik
 * Primary (main) ID -> Secondary ID
 */
export const VENDOR_CROSS_API_MAPPING: Record<number, number> = {
  14: 2,   // Vendor-1
  7: 9,    // Vendor-2
  33: 19,  // Vendor-3
  35: 22,  // Vendor-4
  1: 1,    // Admin-User
  11: 6,   // Vendor-5
  23: 13,  // Vendor-6
  12: 14,  // Vendor-7
  27: 15,  // Vendor-8
  28: 16,  // Vendor-9
  24: 18,  // Vendor-10
  36: 20,  // Vendor-11
  29: 21,  // Vendor-12
}

/**
 * Mapping inverse: Secondary ID -> Primary (main) ID
 */
export const VENDOR_SECONDARY_TO_PRIMARY: Record<number, number> = Object.fromEntries(
  Object.entries(VENDOR_CROSS_API_MAPPING).map(([k, v]) => [v, parseInt(k)])
)

/**
 * Règle hardcodée pour normalisation 1ML/40
 * Si produit contient "1ml" ET parent_category contient "50 ml" => diviser par 40
 */
export const NORMALIZATION_RULE_1ML = {
  productPattern: '1ml',
  parentCategoryPattern: '50 ml',
  divisor: 40,
  description: '1ml compte comme 1/40 de 50ml (CEIL arrondi supérieur)'
}

/**
 * Taux de TVA standard
 */
export const TVA_RATE = 0.2  // 20%

/**
 * Configuration par défaut pour les requêtes
 */
export const DEFAULT_CONFIG = {
  limit: 20,
  pageSize: 1000,
  maxRows: 50000
}
