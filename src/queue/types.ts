// Payloads de jobs para cada fila BullMQ.
// Mantidos num único arquivo para evitar drift entre API (enfileiramento) e workers (consumo).

// ---- scan-queue -----------------------------------------------------------

export interface ScrapeJobPayload {
  type: "scrape";
  url: string;
  productId?: string; // se fornecido, salva o preço no produto após scrape
  profileId?: string;
}

export interface ScanAllJobPayload {
  type: "scan-all";
  triggeredBy: "cron-daily" | "cron-interval" | "manual";
}

export interface CompareJobPayload {
  type: "compare";
  productName: string;
  profileId?: string;
  // para resposta imediata no client: o worker salva em user_settings ou job return
  jobKey: string; // chave única para associar jobId↔requisição no frontend
}

export interface LocalInsightJobPayload {
  type: "local-insight";
  profileId?: string; // chave Gemini para a análise
}

export interface LocalPriceScanJobPayload {
  type: "local-price-scan";
  profileId?: string; // chaves de scraping (Gemini/NVIDIA/LM Studio)
  establishmentId?: string; // se ausente, varre todos com price_url
}

// B1 — descoberta geográfica de estabelecimentos via Overpass API
export interface DiscoverEstablishmentsJobPayload {
  type: "discover-establishments";
  radiusMeters?: number; // se ausente, lê de user_settings.geolocation_search_radius_m
}

// A2 — Análise (LM Studio → NVIDIA → Gemini) movida do handler Express para o worker
export interface AnalyzeJobPayload {
  type: "analyze";
  productName: string;
  currentPrice: number;
  currency: string;
  profileId?: string;
  lowestPrice?: number;
  lowestPriceDate?: string;
}

export type ScanJobPayload =
  | ScrapeJobPayload
  | ScanAllJobPayload
  | CompareJobPayload
  | LocalInsightJobPayload
  | LocalPriceScanJobPayload
  | DiscoverEstablishmentsJobPayload
  | AnalyzeJobPayload;

// ---- route-queue ----------------------------------------------------------

// B4 — roteirização completa: veículo + horário. Permite calcular custo de
// combustível (carro/moto) ou tarifa pública (público) e sugerir horário de
// menor movimento (Popular Times + heurística simples).
export interface RouteVehicle {
  type: "car" | "motorcycle" | "public" | "bike" | "foot";
  // Para car/motorcycle: consumo médio (km/L) e preço do combustível (R$/L)
  fuelConsumptionKmPerL?: number;
  fuelPricePerL?: number;
  // Para public: tarifa fixa por trecho (R$). Aplicada uma vez por viagem.
  publicFare?: number;
}

export interface RouteJobPayload {
  type: "route";
  shoppingListItemIds: string[];
  startLat: number;
  startLng: number;
  // Opcional: estabelecimentos explícitos. Se ausente, o worker deriva os
  // estabelecimentos dos itens via price_observations.
  establishmentIds?: string[];
  name?: string;
  // B4: veículo e horário opcionais (default: car sem custo de combustível)
  vehicle?: RouteVehicle;
  // B4: horário de saída. ISOString para sair exatamente nesse horário;
  // "suggest" para o worker escolher janela de menor movimento entre 7h-20h.
  startTime?: string | "suggest";
}

// ---- social-monitor-queue -------------------------------------------------

export interface SocialCaptureJobPayload {
  type: "social-capture";
  channel: "whatsapp" | "instagram";
  text?: string; // texto colado (WhatsApp) — se vazio, tenta url
  url?: string; // perfil/post do Instagram
  sourceId?: string; // se veio de uma fonte cadastrada
  profileId?: string; // chave Gemini para enriquecimento
}

export interface SocialScanAllJobPayload {
  type: "social-scan-all";
  triggeredBy: "manual" | "cron";
}

// C2 — scan do Status dos contatos salvos (establishments.whatsapp_number).
// O worker usa whatsapp-web.js (lendo QR via GET /api/social/whatsapp/qr)
// e respeita throttle por contato definido em user_settings.
export interface WhatsappStatusScanJobPayload {
  type: "whatsapp-status-scan";
  triggeredBy: "manual" | "cron";
}

// C3 — scan de Stories do Instagram via microserviço Python (instagrapi).
// Consulta handles cadastrados em establishments.instagram_handle, baixa
// mídias, passa ao Gemini vision para extrair preços, grava promoções.
export interface InstagramStoriesScanJobPayload {
  type: "instagram-stories-scan";
  triggeredBy: "manual" | "cron";
}

export type SocialMonitorJobPayload =
  | SocialCaptureJobPayload
  | SocialScanAllJobPayload
  | WhatsappStatusScanJobPayload
  | InstagramStoriesScanJobPayload;

// Tipos discriminados para o worker discriminar com `switch (payload.type)`.
