// Scraping de preços locais (FASE 11)
// Varre a URL de busca de preço de um estabelecimento, substituindo {term}
// pelo nome do item, e grava price_observations com source "scraping".
// Dedup por (item, estabelecimento, preço): não re-registra preço idêntico.

import type { ShoppingListItem, Establishment, PriceObservation } from "../types";
import { advancedScrape, isValidPrice, sanitizePrice } from "./scraper";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { safeLog } from "./safeLog";

export interface LocalScrapeResult {
  itemId: string;
  itemName: string;
  establishmentId: string;
  status: "recorded" | "duplicate" | "no-price" | "error";
  price?: number;
  method?: string;
  error?: string;
  url: string;
}

export interface LocalPriceScanOutcome {
  establishmentId: string;
  establishmentName: string;
  results: LocalScrapeResult[];
  recorded: number;
  duplicates: number;
  errors: number;
}

export function buildSearchUrl(priceUrl: string, term: string): string {
  const encoded = encodeURIComponent(term);
  if (priceUrl.includes("{term}")) {
    return priceUrl.replace("{term}", encoded);
  }
  const joiner = priceUrl.includes("?") ? "&" : "?";
  return `${priceUrl}${joiner}q=${encoded}`;
}

function isDuplicateObservation(
  previous: PriceObservation | undefined,
  price: number,
  tolerance = 0.01
): boolean {
  if (!previous) return false;
  return Math.abs(previous.price - price) < tolerance;
}

export async function scrapeItemPrice(
  establishment: Establishment,
  item: ShoppingListItem,
  apiKeys: { lmStudioUrl?: string; nvidiaApiKey?: string; geminiApiKey?: string },
  opts?: { maxPriceTolerance?: number }
): Promise<LocalScrapeResult> {
  if (!establishment.priceUrl) {
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: "error",
      error: "estabelecimento sem price_url",
      url: "",
    };
  }

  const url = buildSearchUrl(establishment.priceUrl, item.name);
  const recent = PriceObservationRepository.getAll({
    shoppingListItemId: item.id,
    establishmentId: establishment.id,
  })[0]; // ORDER BY observed_at DESC

  try {
    const info = await advancedScrape(url, apiKeys);
    if (!info || !isValidPrice(info.price)) {
      return {
        itemId: item.id,
        itemName: item.name,
        establishmentId: establishment.id,
        status: "no-price",
        url,
      };
    }
    const price = sanitizePrice(info.price);

    if (isDuplicateObservation(recent, price, opts?.maxPriceTolerance)) {
      safeLog(
        `[local-scrape] ${item.name} @ ${establishment.name}: duplicado (${price})`
      );
      return {
        itemId: item.id,
        itemName: item.name,
        establishmentId: establishment.id,
        status: "duplicate",
        price,
        method: info.method,
        url,
      };
    }

    // B2 — heurística valid_until: se não houver promoção explícita, assume
    // que o preço é válido até a próxima observação diferente; marcamnos uma
    // janela móvel de 24h como padrão "estimado".
    const observedAt = new Date();
    const validUntil = new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();

    PriceObservationRepository.create({
      shoppingListItemId: item.id,
      establishmentId: establishment.id,
      price,
      observedAt: observedAt.toISOString(),
      source: "scraping",
      notes: url,
      validUntil,
    });

    safeLog(
      `[local-scrape] ${item.name} @ ${establishment.name}: R$ ${price} (${info.method ?? "scraping"})`
    );
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: "recorded",
      price,
      method: info.method,
      url,
    };
  } catch (err: any) {
    safeLog(`[local-scrape] erro ${item.name} @ ${establishment.name}: ${err.message}`);
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: "error",
      error: err.message,
      url,
    };
  }
}

export async function scanEstablishmentPrices(
  establishment: Establishment,
  items: ShoppingListItem[],
  apiKeys: { lmStudioUrl?: string; nvidiaApiKey?: string; geminiApiKey?: string }
): Promise<LocalPriceScanOutcome> {
  const results: LocalScrapeResult[] = [];
  for (const item of items) {
    results.push(await scrapeItemPrice(establishment, item, apiKeys));
  }
  return {
    establishmentId: establishment.id,
    establishmentName: establishment.name,
    results,
    recorded: results.filter((r) => r.status === "recorded").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    errors: results.filter((r) => r.status === "error").length,
  };
}
