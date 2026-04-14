/**
 * Quantity Rules Module
 * Normalizes quantities for products sold in bulk (e.g., 1ml doses ÷40)
 *
 * Business Rules:
 * - Products ending with "- 1ml" in category "50 ML" are sold as 40 doses per bottle
 * - Quantity needs to be divided by 40 for accurate unit counts
 *
 * The rules are defined in the database table: product_quantity_rules
 */

export interface QuantityRule {
  product_pattern: string | null;
  category_pattern: string | null;
  parent_category_pattern: string | null;
  divisor: number;
  priority: number;
}

// In-memory cache for rules (loaded once per request lifecycle)
let rulesCache: QuantityRule[] | null = null;

/**
 * Load quantity rules from database (with caching)
 */
export async function loadQuantityRules(supabase: any): Promise<QuantityRule[]> {
  if (rulesCache) {
    return rulesCache;
  }

  const { data, error } = await supabase
    .from('product_quantity_rules')
    .select('product_pattern, category_pattern, parent_category_pattern, divisor, priority')
    .eq('is_active', true)
    .order('priority', { ascending: true });

  if (error) {
    console.error('[quantity-rules] Failed to load rules:', error);
    return [];
  }

  rulesCache = data || [];
  console.log(`[quantity-rules] Loaded ${rulesCache.length} active rules`);
  return rulesCache;
}

/**
 * Clear the rules cache (useful for testing or forced refresh)
 */
export function clearQuantityRulesCache(): void {
  rulesCache = null;
}

/**
 * Get the quantity divisor for a product based on matching rules
 *
 * @param productName - Product name to match
 * @param categoryName - Category name to match (optional)
 * @param parentCategoryName - Parent category name to match (optional)
 * @param rules - Pre-loaded rules (pass to avoid re-loading)
 * @returns The divisor to apply (1 = no change, 40 = divide by 40, etc.)
 */
export function getQuantityDivisor(
  productName: string,
  categoryName: string | null,
  parentCategoryName: string | null,
  rules: QuantityRule[]
): number {
  if (!rules || rules.length === 0) {
    return 1;
  }

  const productLower = (productName || '').toLowerCase();
  const categoryLower = (categoryName || '').toLowerCase();
  const parentCategoryLower = (parentCategoryName || '').toLowerCase();

  // Find first matching rule (rules are sorted by priority)
  for (const rule of rules) {
    let matches = true;

    // Check product pattern
    if (rule.product_pattern) {
      const pattern = rule.product_pattern.toLowerCase();
      // Convert SQL LIKE pattern to JS match
      // %pattern% becomes includes(), pattern% becomes startsWith()
      if (pattern.startsWith('%') && pattern.endsWith('%')) {
        const inner = pattern.slice(1, -1);
        matches = matches && productLower.includes(inner);
      } else if (pattern.endsWith('%')) {
        const inner = pattern.slice(0, -1);
        matches = matches && productLower.startsWith(inner);
      } else if (pattern.startsWith('%')) {
        const inner = pattern.slice(1);
        matches = matches && productLower.endsWith(inner);
      } else {
        matches = matches && productLower.includes(pattern);
      }
    }

    // Check category pattern
    if (rule.category_pattern && matches) {
      const pattern = rule.category_pattern.toLowerCase();
      if (pattern.startsWith('%') && pattern.endsWith('%')) {
        const inner = pattern.slice(1, -1);
        matches = matches && categoryLower.includes(inner);
      } else if (pattern.endsWith('%')) {
        const inner = pattern.slice(0, -1);
        matches = matches && categoryLower.startsWith(inner);
      } else if (pattern.startsWith('%')) {
        const inner = pattern.slice(1);
        matches = matches && categoryLower.endsWith(inner);
      } else {
        matches = matches && categoryLower.includes(pattern);
      }
    }

    // Check parent category pattern
    if (rule.parent_category_pattern && matches) {
      const pattern = rule.parent_category_pattern.toLowerCase();
      if (pattern.startsWith('%') && pattern.endsWith('%')) {
        const inner = pattern.slice(1, -1);
        matches = matches && parentCategoryLower.includes(inner);
      } else if (pattern.endsWith('%')) {
        const inner = pattern.slice(0, -1);
        matches = matches && parentCategoryLower.startsWith(inner);
      } else if (pattern.startsWith('%')) {
        const inner = pattern.slice(1);
        matches = matches && parentCategoryLower.endsWith(inner);
      } else {
        matches = matches && parentCategoryLower.includes(pattern);
      }
    }

    if (matches) {
      return rule.divisor;
    }
  }

  return 1; // No matching rule, return divisor of 1 (no change)
}

/**
 * Normalize a quantity based on product rules
 * Convenience function that combines rule lookup and division
 */
export function normalizeQuantity(
  rawQuantity: number,
  productName: string,
  categoryName: string | null,
  parentCategoryName: string | null,
  rules: QuantityRule[]
): number {
  const divisor = getQuantityDivisor(productName, categoryName, parentCategoryName, rules);
  return divisor > 1 ? Math.ceil(rawQuantity / divisor) : rawQuantity;
}

/**
 * Batch normalize quantities for multiple items
 * More efficient when processing many items
 */
export function normalizeItemQuantities<T extends {
  quantity?: number;
  product_name?: string;
  category_name?: string | null;
  parent_category_name?: string | null;
}>(items: T[], rules: QuantityRule[]): T[] {
  return items.map(item => ({
    ...item,
    quantity: normalizeQuantity(
      item.quantity || 0,
      item.product_name || '',
      item.category_name || null,
      item.parent_category_name || null,
      rules
    )
  }));
}
