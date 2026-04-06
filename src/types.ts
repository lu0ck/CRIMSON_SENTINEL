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
