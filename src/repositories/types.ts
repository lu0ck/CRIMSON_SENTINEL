import type { Product, ProductList, Profile } from "../types";

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
