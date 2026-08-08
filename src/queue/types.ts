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

export type ScanJobPayload = ScrapeJobPayload | ScanAllJobPayload | CompareJobPayload;

// ---- route-queue ----------------------------------------------------------

export interface RouteJobPayload {
  type: "route";
  shoppingListItemIds: string[];
  startLat: number;
  startLng: number;
}

// ---- social-monitor-queue -------------------------------------------------

export interface SocialMonitorJobPayload {
  type: "social-monitor";
  channels: string[]; // ex: ["whatsapp", "instagram"]
}

// Tipos discriminados para o worker discriminar com `switch (payload.type)`.
