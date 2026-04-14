/**
 * Client Hiboutik API avec gestion de la pagination et support multi-API
 *
 * DUAL API CONFIGURATION :
 * - Primary API : your-store.hiboutik.com (Store-A, Store-B, Store-C, Store-D)
 * - Secondary API : your-store-2.hiboutik.com (Store-E, Store-F)
 *
 * PAGINATION HIBOUTIK :
 * - Paramètre `p` : numéro de page (commence à 1, pas 0!)
 * - L'API retourne TOUJOURS 250 éléments par page (fixe, le paramètre `pagination` est ignoré)
 * - Header `X-Total-Count` : non disponible
 * - La réponse est un array vide [] quand il n'y a plus de données
 *
 * ENDPOINTS VÉRIFIÉS :
 * - GET /products/?p=1 : fonctionne (250 items/page)
 * - GET /sales/{sale_id} : fonctionne
 * - GET /stores/ : fonctionne
 * - GET /users/ : fonctionne (vendors)
 * - GET /categories/ : fonctionne
 * - GET /brands/ : fonctionne
 * - GET /webhooks/ : fonctionne
 */

// Note: la base de données utilise 'main' et 'secondary' (pas 'primary')
export type ApiSource = "main" | "secondary";

export interface HiboutikConfig {
  apiUrl: string;
  apiUser: string;
  apiKey: string;
  source: ApiSource;
}

export interface DualApiConfig {
  primary: HiboutikConfig;
  secondary: HiboutikConfig;
}

export interface PaginationOptions {
  maxPages?: number;      // Limite de pages à récupérer (défaut: illimité)
  startPage?: number;     // Page de départ (défaut: 1 - Hiboutik commence à 1!)
}

// Page size is FIXED by Hiboutik API at 250 items
const HIBOUTIK_PAGE_SIZE = 250;

export interface PaginatedResult<T> {
  data: T[];
  totalCount: number;
  pagesRetrieved: number;
  hasMore: boolean;
  apiSource: ApiSource;
}

/** Timeout pour les requêtes Hiboutik (30 secondes) */
const HIBOUTIK_FETCH_TIMEOUT_MS = 30_000;

export class HiboutikClient {
  private config: HiboutikConfig;

  constructor(config: HiboutikConfig) {
    if (!config.apiUrl || !config.apiUser || !config.apiKey) {
      throw new Error(`Missing Hiboutik API credentials for ${config.source}`);
    }
    this.config = config;
  }

  /** Génère le header Basic Auth à chaque appel (pas de stockage en mémoire) */
  private getAuthHeader(): string {
    return btoa(`${this.config.apiUser}:${this.config.apiKey}`);
  }

  get source(): ApiSource {
    return this.config.source;
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  /**
   * Récupère une ressource par ID
   */
  async fetchById<T>(endpoint: string, id: number | string): Promise<T | null> {
    const url = `${this.config.apiUrl}${endpoint}/${id}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HIBOUTIK_FETCH_TIMEOUT_MS);

    try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Basic ${this.getAuthHeader()}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Hiboutik API error: ${response.status}`);
    }

    const data = await response.json();
    // L'API renvoie souvent un array avec un seul élément
    return Array.isArray(data) ? data[0] : data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Récupère une vente par ID avec ses détails
   */
  async fetchSale(saleId: number): Promise<any | null> {
    return this.fetchById("/sales", saleId);
  }

  /**
   * Récupère les lignes de détail d'une vente (line items)
   * NOTE: L'endpoint /sales/{id}/line_items N'EXISTE PAS dans l'API Hiboutik!
   * Les line_items sont embarqués directement dans la réponse de GET /sales/{id}
   * Cette méthode est conservée pour rétrocompatibilité mais retourne toujours []
   * @deprecated Utiliser fetchSale() et accéder à sale.line_items directement
   */
  async fetchSaleLineItems(saleId: number): Promise<any[]> {
    console.warn(`[DEPRECATED] fetchSaleLineItems called for sale ${saleId}. Use sale.line_items from fetchSale() instead.`);
    // L'endpoint /line_items n'existe pas, retourner [] pour éviter l'erreur
    return [];
  }

  /**
   * Récupère un produit par ID avec toutes ses infos
   */
  async fetchProduct(productId: number): Promise<any | null> {
    return this.fetchById("/products", productId);
  }

  /**
   * Récupère une catégorie par ID
   */
  async fetchCategory(categoryId: number): Promise<any | null> {
    return this.fetchById("/categories", categoryId);
  }

  /**
   * Récupère une marque par ID
   */
  async fetchBrand(brandId: number): Promise<any | null> {
    return this.fetchById("/brands", brandId);
  }

  /**
   * Récupère un client par ID avec ses adresses (contient la date de création)
   * L'API retourne addresses[].creation_date qui est la vraie date de création du client
   */
  async fetchCustomer(customerId: number): Promise<any | null> {
    return this.fetchById("/customer", customerId);
  }

  /**
   * Récupère les détails complets d'une vente avec lignes enrichies
   * Retourne la vente + line items avec product/category/brand info
   *
   * IMPORTANT: Les line_items sont EMBARQUÉS dans la réponse de GET /sales/{id}
   * L'endpoint /sales/{id}/line_items N'EXISTE PAS!
   */
  async fetchSaleWithDetails(saleId: number): Promise<{
    sale: any;
    lineItems: any[];
  } | null> {
    // Récupérer la vente - les line_items sont EMBARQUÉS dans la réponse!
    const sale = await this.fetchSale(saleId);

    if (!sale) return null;

    // Les line_items sont directement dans sale.line_items (pas besoin d'appel séparé)
    const rawLineItems = sale.line_items || [];
    console.log(`[fetchSaleWithDetails] Sale ${saleId} has ${rawLineItems.length} embedded line_items`);

    if (rawLineItems.length === 0) {
      console.warn(`[fetchSaleWithDetails] No line_items found in sale ${saleId}`);
      return { sale, lineItems: [] };
    }

    // Les line_items Hiboutik contiennent DÉJÀ toutes les infos produit/catégorie/marque!
    // Pas besoin de faire des appels API supplémentaires
    const enrichedLineItems = rawLineItems.map((item: any) => {
      // Les données sont déjà présentes dans le line_item
      return {
        ...item,
        // Mapper les champs Hiboutik vers notre format _product/_category/_brand
        _product: {
          product_id: item.product_id,
          product_model: item.product_model,
          product_barcode: item.product_barcode,
          product_brand: item.product_brand,
          product_category: item.product_category,
          product_supplier: item.product_supplier,
          product_supply_price: item.product_supply_price,
        },
        _category: item.category_name ? {
          category_id: item.product_category,
          category_name: item.category_name,
        } : null,
        _parentCategory: null, // On utilisera les champs dénormalisés si besoin
        _grandparentCategory: null,
        _brand: item.brand_name ? {
          brand_id: item.product_brand,
          brand_name: item.brand_name,
        } : null,
        // Champs additionnels déjà présents dans line_item
        line_product_id: item.product_id,
        line_product_name: item.product_model,
        line_quantity: item.quantity,
        line_price: item.item_unit_gross, // Prix TTC unitaire
        line_total: item.item_total_gross, // Total TTC ligne
        line_id: item.line_item_id || item.detail_commande_id,
        line_size_id: item.product_size,
        line_size_name: item.size_name,
      };
    });

    return { sale, lineItems: enrichedLineItems };
  }

  /**
   * Récupère toutes les données d'un endpoint avec pagination automatique
   * Note: Hiboutik utilise une pagination fixe de 250 items/page, commençant à page 1
   */
  async fetchAllPaginated<T>(
    endpoint: string,
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<T>> {
    const maxPages = options.maxPages || Infinity;
    const startPage = options.startPage || 1; // Hiboutik starts at page 1!

    const allData: T[] = [];
    let currentPage = startPage;
    let hasMore = true;

    console.log(`[${this.config.source}] Fetching ${endpoint} (fixed pageSize: ${HIBOUTIK_PAGE_SIZE})`);

    while (hasMore && currentPage - startPage < maxPages) {
      const url = this.buildPaginatedUrl(endpoint, currentPage);
      console.log(`[${this.config.source}] Page ${currentPage}: ${url}`);

      const response = await fetch(url, {
        headers: {
          "Authorization": `Basic ${this.getAuthHeader()}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Hiboutik API error: ${response.status} ${response.statusText}`);
      }

      const pageData: T[] = await response.json();

      if (!pageData || pageData.length === 0) {
        hasMore = false;
      } else {
        allData.push(...pageData);
        console.log(`[${this.config.source}] Page ${currentPage}: ${pageData.length} items (total: ${allData.length})`);

        // Hiboutik returns exactly 250 items per page, less means last page
        if (pageData.length < HIBOUTIK_PAGE_SIZE) {
          hasMore = false;
        } else {
          currentPage++;
        }
      }

      await this.delay(100);
    }

    return {
      data: allData,
      totalCount: allData.length,
      pagesRetrieved: currentPage - startPage + 1,
      hasMore,
      apiSource: this.config.source,
    };
  }

  /**
   * Récupère une liste sans pagination
   */
  async fetchAll<T>(endpoint: string): Promise<T[]> {
    const url = `${this.config.apiUrl}${endpoint}`;

    const response = await fetch(url, {
      headers: {
        "Authorization": `Basic ${this.getAuthHeader()}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Hiboutik API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Récupère tous les produits avec pagination
   */
  async fetchProducts(options?: PaginationOptions): Promise<PaginatedResult<any>> {
    return this.fetchAllPaginated("/products/", options);
  }

  /**
   * Récupère tous les magasins
   */
  async fetchStores(): Promise<any[]> {
    return this.fetchAll("/stores/");
  }

  /**
   * Récupère tous les vendeurs (users)
   */
  async fetchVendors(): Promise<any[]> {
    return this.fetchAll("/users/");
  }

  /**
   * Récupère toutes les catégories
   */
  async fetchCategories(): Promise<any[]> {
    return this.fetchAll("/categories/");
  }

  /**
   * Récupère toutes les marques
   */
  async fetchBrands(): Promise<any[]> {
    return this.fetchAll("/brands/");
  }

  /**
   * Récupère tous les webhooks configurés
   */
  async fetchWebhooks(): Promise<any[]> {
    return this.fetchAll("/webhooks/");
  }

  /**
   * Crée un nouveau webhook
   */
  async createWebhook(config: {
    label: string;
    url: string;
    action: "sale" | "product" | "stock_order" | "stock_transfer" | "customer";
    storeId?: number;
    async?: boolean;
  }): Promise<any> {
    const response = await fetch(`${this.config.apiUrl}/webhooks`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${this.getAuthHeader()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook_label: config.label,
        webhook_url: config.url,
        webhook_action: config.action,
        webhook_store_id: config.storeId || 0,
        webhook_async: config.async !== false ? 1 : 0,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create webhook: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * Appelle l'endpoint de refresh des prix d'achat
   */
  async refreshSupplyPrices(): Promise<any> {
    const response = await fetch(
      `${this.config.apiUrl}/reports/refresh/supply_prices`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${this.getAuthHeader()}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh supply prices: ${response.status} - ${error}`);
    }

    return response.json();
  }

  private buildPaginatedUrl(endpoint: string, page: number): string {
    const baseUrl = `${this.config.apiUrl}${endpoint}`;
    const separator = endpoint.includes("?") ? "&" : "?";
    // Note: pagination parameter is ignored by Hiboutik API (fixed at 250)
    return `${baseUrl}${separator}p=${page}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Client multi-API pour gérer les deux comptes Hiboutik
 */
export class HiboutikDualClient {
  public primary: HiboutikClient;
  public secondary: HiboutikClient;

  constructor(config: DualApiConfig) {
    this.primary = new HiboutikClient(config.primary);
    this.secondary = new HiboutikClient(config.secondary);
  }

  /**
   * Récupère les données des deux APIs
   */
  async fetchFromBoth<T>(
    fetchFn: (client: HiboutikClient) => Promise<T>
  ): Promise<{ primary: T; secondary: T }> {
    const [primary, secondary] = await Promise.all([
      fetchFn(this.primary),
      fetchFn(this.secondary),
    ]);

    return { primary, secondary };
  }

  /**
   * Récupère tous les produits des deux APIs
   */
  async fetchAllProducts(options?: PaginationOptions) {
    return this.fetchFromBoth(client => client.fetchProducts(options));
  }

  /**
   * Récupère tous les magasins des deux APIs
   */
  async fetchAllStores() {
    return this.fetchFromBoth(client => client.fetchStores());
  }

  /**
   * Récupère tous les vendeurs des deux APIs
   */
  async fetchAllVendors() {
    return this.fetchFromBoth(client => client.fetchVendors());
  }

  /**
   * Refresh les prix d'achat sur les deux APIs
   */
  async refreshSupplyPricesBoth() {
    return this.fetchFromBoth(client => client.refreshSupplyPrices());
  }
}

/**
 * Factory pour créer un client Primary uniquement
 */
export function createMainClient(): HiboutikClient {
  const apiUrl = Deno.env.get("HIBOUTIK_PRIMARY_API_URL");
  const apiUser = Deno.env.get("HIBOUTIK_PRIMARY_API_USER");
  const apiKey = Deno.env.get("HIBOUTIK_PRIMARY_API_KEY");

  if (!apiUrl || !apiUser || !apiKey) {
    throw new Error("Missing Primary/Main Hiboutik API credentials");
  }

  return new HiboutikClient({ apiUrl, apiUser, apiKey, source: "main" });
}

/**
 * Factory pour créer un client Secondary uniquement
 */
export function createSecondaryClient(): HiboutikClient {
  const apiUrl = Deno.env.get("HIBOUTIK_SECONDARY_API_URL");
  const apiUser = Deno.env.get("HIBOUTIK_SECONDARY_API_USER");
  const apiKey = Deno.env.get("HIBOUTIK_SECONDARY_API_KEY");

  if (!apiUrl || !apiUser || !apiKey) {
    throw new Error("Missing Secondary Hiboutik API credentials");
  }

  return new HiboutikClient({ apiUrl, apiUser, apiKey, source: "secondary" });
}

/**
 * Factory pour créer un client dual (les deux APIs)
 */
export function createDualClient(): HiboutikDualClient {
  return new HiboutikDualClient({
    primary: {
      apiUrl: Deno.env.get("HIBOUTIK_PRIMARY_API_URL")!,
      apiUser: Deno.env.get("HIBOUTIK_PRIMARY_API_USER")!,
      apiKey: Deno.env.get("HIBOUTIK_PRIMARY_API_KEY")!,
      source: "main",
    },
    secondary: {
      apiUrl: Deno.env.get("HIBOUTIK_SECONDARY_API_URL")!,
      apiUser: Deno.env.get("HIBOUTIK_SECONDARY_API_USER")!,
      apiKey: Deno.env.get("HIBOUTIK_SECONDARY_API_KEY")!,
      source: "secondary",
    },
  });
}

// Alias for backward compatibility
export const createPrimaryClient = createMainClient;

/**
 * Mapping des vendor_id entre les deux APIs (basé sur nom/prénom)
 * Primary ID -> Secondary ID
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
};

/**
 * Inverse mapping: Secondary ID -> Primary ID
 */
export const VENDOR_SECONDARY_TO_PRIMARY: Record<number, number> = Object.fromEntries(
  Object.entries(VENDOR_CROSS_API_MAPPING).map(([k, v]) => [v, parseInt(k)])
);
