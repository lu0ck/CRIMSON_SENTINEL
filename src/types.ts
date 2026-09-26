export interface Product {
  id: string;
  url: string;
  name: string;
  currentPrice: number;
  previousPrice: number;
  currency: string;
  available: boolean;
  imageUrl?: string;
  lastUpdated: string;
  priceHistory: { date: string; price: number }[];
  listId: string;
  profileId: string;
  targetPrice?: number;
  lastScrapeMethod?: string;
  comparisonResults?: { site: string; price: number; url: string }[];
  boughtAt?: string;
  boughtPrice?: number;
  /** #45 — posição manual na lista da aba LIST ("ordem de compra") */
  sortOrder?: number;
}

export interface ProductList {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  profileId: string;
  budget?: number;
}

export interface Profile {
  id: string;
  name: string;
  avatar?: string;
  email?: string;
  discordWebhook?: string;
  telegramToken?: string;
  telegramChatId?: string;
  gmailUser?: string;
  gmailPass?: string;
  // #54 — DeepSeek é o PRINCIPAL provedor de interpretação (texto e imagem)
  deepseekApiKey?: string;
  geminiApiKey?: string;
  lmStudioUrl?: string;
  nvidiaApiKey?: string;
  serperApiKey?: string;
  tavilyApiKey?: string;
  useAdvancedScraping?: boolean;
  refreshInterval?: string;
}

export interface AppData {
  profiles: Profile[];
  lists: ProductList[];
  products: Product[];
}

// ---- MÓDULO LOCAL / GEOLOCALIZADO (FASE 5) --------------------------------

export interface Establishment {
  id: string;
  name: string;
  chain?: string;
  category?: string;
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  osmId?: number;
  priceUrl?: string;
  source?: "manual" | "discovered";
  whatsappNumber?: string;
  instagramHandle?: string;
}

export interface ShoppingList {
  id: string;
  name: string;
  createdAt?: string;
}

export interface ShoppingListItem {
  id: string;
  name: string;
  quantity?: number;
  unit?: import("./lib/units").ItemUnit;
  category?: string;
  checked?: boolean;
  targetPrice?: number;
  productId?: string;
  listId?: string;
  /** #40 — prioridade na lista: alta | media | baixa (null = sem) */
  priority?: "alta" | "media" | "baixa" | null;
}

export interface PriceObservation {
  id?: number;
  shoppingListItemId?: string;
  productId?: string;
  establishmentId: string;
  price: number;
  currency?: string;
  observedAt: string;
  source?:
    | "site"
    | "whatsapp"
    | "instagram"
    | "telegram"
    | "scraping"
    | "manual"
    | "flyer"
    | "social";
  notes?: string;
  validUntil?: string;
}

export interface Promotion {
  id: string;
  establishmentId: string;
  productName: string;
  regularPrice?: number;
  promoPrice: number;
  currency?: string;
  startDate?: string;
  endDate?: string;
  expiresAt?: string;
  source?: string;
  sourceUrl?: string;
  rawText?: string;
  detectedAt: string;
  isActive?: boolean;
  productId?: string;
  discountPct?: number;
  isFlash?: boolean;
}

export interface RouteStop {
  establishmentId: string;
  stopOrder: number;
  estimatedCost?: number;
  items?: string[];
  arrivalTimeEstimate?: string;
  quietScore?: number;
}

export interface RoutePlan {
  id: string;
  name?: string;
  startLat: number;
  startLng: number;
  totalDistanceKm?: number;
  totalEstimatedCost?: number;
  createdAt: string;
  stops: RouteStop[];
  vehicleType?: "car" | "motorcycle" | "public" | "bike" | "foot";
  totalTimeMin?: number;
  suggestedDepartureAt?: string;
  travelCost?: number;
  fuelConsumptionKmPerL?: number;
  fuelPricePerL?: number;
}
