import type {
  Product,
  ProductList,
  Profile,
  Establishment,
  ShoppingListItem,
  PriceObservation,
  Promotion,
  RoutePlan,
  RouteStop,
  PromotionSite,
} from "../types";

export interface ProfileRow {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  discord_webhook: string | null;
  telegram_token: string | null;
  telegram_chat_id: string | null;
  gmail_user: string | null;
  gmail_pass: string | null;
  gemini_api_key: string | null;
  lm_studio_url: string | null;
  nvidia_api_key: string | null;
  serper_api_key: string | null;
  tavily_api_key: string | null;
  use_advanced_scraping: number;
  refresh_interval: string | null;
  created_at: string;
}

export interface ProductListRow {
  id: string;
  name: string;
  description: string | null;
  profile_id: string;
  budget: number | null;
  created_at: string;
}

export interface ProductRow {
  id: string;
  url: string;
  name: string | null;
  current_price: number | null;
  previous_price: number | null;
  currency: string;
  available: number;
  image_url: string | null;
  last_updated: string | null;
  list_id: string | null;
  profile_id: string;
  target_price: number | null;
  last_scrape_method: string | null;
  comparison_results: string | null;
  created_at: string;
}

export interface PriceHistoryRow {
  id: number;
  product_id: string;
  price: number;
  date: string;
}

export function profileRowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar ?? undefined,
    email: row.email ?? undefined,
    discordWebhook: row.discord_webhook ?? undefined,
    telegramToken: row.telegram_token ?? undefined,
    telegramChatId: row.telegram_chat_id ?? undefined,
    gmailUser: row.gmail_user ?? undefined,
    gmailPass: row.gmail_pass ?? undefined,
    geminiApiKey: row.gemini_api_key ?? undefined,
    lmStudioUrl: row.lm_studio_url ?? undefined,
    nvidiaApiKey: row.nvidia_api_key ?? undefined,
    serperApiKey: row.serper_api_key ?? undefined,
    tavilyApiKey: row.tavily_api_key ?? undefined,
    useAdvancedScraping: !!row.use_advanced_scraping,
    refreshInterval: row.refresh_interval ?? undefined,
  };
}

export function productListRowToProductList(row: ProductListRow): ProductList {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    profileId: row.profile_id,
    budget: row.budget ?? undefined,
    createdAt: row.created_at,
  };
}

export function productRowToProduct(
  row: ProductRow,
  priceHistory: PriceHistoryRow[] = []
): Product {
  return {
    id: row.id,
    url: row.url,
    name: row.name ?? "",
    currentPrice: row.current_price ?? 0,
    previousPrice: row.previous_price ?? 0,
    currency: row.currency,
    available: !!row.available,
    imageUrl: row.image_url ?? undefined,
    lastUpdated: row.last_updated ?? "",
    priceHistory: priceHistory.map((h) => ({ date: h.date, price: h.price })),
    listId: row.list_id ?? "",
    profileId: row.profile_id,
    targetPrice: row.target_price ?? undefined,
    lastScrapeMethod: row.last_scrape_method ?? undefined,
    comparisonResults: row.comparison_results
      ? JSON.parse(row.comparison_results)
      : undefined,
  };
}

// ---- MÓDULO LOCAL / GEOLOCALIZADO (FASE 5) --------------------------------

export interface EstablishmentRow {
  id: string;
  name: string;
  chain: string | null;
  category: string | null;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  osm_id: number | null;
  price_url: string | null;
  source: string | null;
  whatsapp_number: string | null;
  instagram_handle: string | null;
  created_at: string;
}

export interface ShoppingListItemRow {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  category: string | null;
  checked: number;
  target_price: number | null;
  product_id: string | null;
  created_at: string;
}

export interface PriceObservationRow {
  id: number;
  shopping_list_item_id: string | null;
  product_id: string | null;
  establishment_id: string;
  price: number;
  currency: string;
  observed_at: string;
  source: string | null;
  notes: string | null;
  valid_until: string | null;
}

export interface PromotionRow {
  id: string;
  establishment_id: string;
  product_name: string;
  regular_price: number | null;
  promo_price: number;
  currency: string;
  start_date: string | null;
  end_date: string | null;
  source: string | null;
  source_url: string | null;
  raw_text: string | null;
  detected_at: string;
  is_active: number;
  product_id: string | null;
  discount_pct: number | null;
  is_flash: number;
  expires_at: string | null;
}

export interface RouteRow {
  id: string;
  name: string | null;
  start_lat: number;
  start_lng: number;
  total_distance_km: number | null;
  total_estimated_cost: number | null;
  route_data: string | null;
  created_at: string;
  vehicle_type: string | null;
  total_time_min: number | null;
  suggested_departure_at: string | null;
  travel_cost: number | null;
  fuel_consumption_km_l: number | null;
  fuel_price_per_l: number | null;
}

export interface RouteStopRow {
  id: number;
  route_id: string;
  establishment_id: string;
  stop_order: number;
  estimated_cost: number | null;
  items: string | null;
  arrival_time_estimate: string | null;
  quiet_score: number | null;
}

export function establishmentRowToEstablishment(row: EstablishmentRow): Establishment {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain ?? undefined,
    category: row.category ?? undefined,
    lat: row.lat,
    lng: row.lng,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    postalCode: row.postal_code ?? undefined,
    osmId: row.osm_id ?? undefined,
    priceUrl: row.price_url ?? undefined,
    source: (row.source as Establishment["source"] | null) ?? undefined,
    whatsappNumber: row.whatsapp_number ?? undefined,
    instagramHandle: row.instagram_handle ?? undefined,
  };
}

export function shoppingListItemRowToShoppingListItem(row: ShoppingListItemRow): ShoppingListItem {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit ?? undefined,
    category: row.category ?? undefined,
    checked: !!row.checked,
    targetPrice: row.target_price ?? undefined,
    productId: row.product_id ?? undefined,
  };
}

export function priceObservationRowToPriceObservation(row: PriceObservationRow): PriceObservation {
  return {
    id: row.id,
    shoppingListItemId: row.shopping_list_item_id ?? undefined,
    productId: row.product_id ?? undefined,
    establishmentId: row.establishment_id,
    price: row.price,
    currency: row.currency,
    observedAt: row.observed_at,
    source: (row.source as PriceObservation["source"] | null) ?? undefined,
    notes: row.notes ?? undefined,
    validUntil: row.valid_until ?? undefined,
  };
}

export function promotionRowToPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    productName: row.product_name,
    regularPrice: row.regular_price ?? undefined,
    promoPrice: row.promo_price,
    currency: row.currency,
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    source: row.source ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    rawText: row.raw_text ?? undefined,
    detectedAt: row.detected_at,
    isActive: !!row.is_active,
    productId: row.product_id ?? undefined,
    discountPct: row.discount_pct ?? undefined,
    isFlash: !!row.is_flash,
  };
}

export function routeRowToRoutePlan(row: RouteRow, stops: RouteStopRow[] = []): RoutePlan {
  return {
    id: row.id,
    name: row.name ?? undefined,
    startLat: row.start_lat,
    startLng: row.start_lng,
    totalDistanceKm: row.total_distance_km ?? undefined,
    totalEstimatedCost: row.total_estimated_cost ?? undefined,
    createdAt: row.created_at,
    vehicleType: (row.vehicle_type as RoutePlan["vehicleType"] | null) ?? undefined,
    totalTimeMin: row.total_time_min ?? undefined,
    suggestedDepartureAt: row.suggested_departure_at ?? undefined,
    travelCost: row.travel_cost ?? undefined,
    fuelConsumptionKmPerL: row.fuel_consumption_km_l ?? undefined,
    fuelPricePerL: row.fuel_price_per_l ?? undefined,
    stops: stops
      .sort((a, b) => a.stop_order - b.stop_order)
      .map(
        (s): RouteStop => ({
          establishmentId: s.establishment_id,
          stopOrder: s.stop_order,
          estimatedCost: s.estimated_cost ?? undefined,
          items: s.items
            ? (() => {
                try {
                  return JSON.parse(s.items);
                } catch {
                  return undefined;
                }
              })()
            : undefined,
          arrivalTimeEstimate: s.arrival_time_estimate ?? undefined,
          quietScore: s.quiet_score ?? undefined,
        })
      ),
  };
}

export interface PromotionSiteRow {
  id: string;
  name: string;
  url: string;
  category: string | null;
  enabled: number;
  last_checked_at: string | null;
  created_at: string;
}

export function promotionSiteRowToPromotionSite(row: PromotionSiteRow): PromotionSite {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    category: row.category ?? undefined,
    enabled: !!row.enabled,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
  };
}
