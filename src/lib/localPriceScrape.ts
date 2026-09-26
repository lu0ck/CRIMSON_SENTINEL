// Scraping de preços locais (FASE 11)
// Varre a URL de busca de preço de um estabelecimento, substituindo {term}
// pelo nome do item, e grava price_observations com source "scraping".
// Dedup por (item, estabelecimento, preço): não re-registra preço idêntico.
//
// #32 — cascade 3-tier quando establishments.price_url está vazio:
//   Tier 1 — market-handler + Serper/Tavily + NVIDIA/Gemini → busca "«item» «rede» preço"
//   Tier 2 — chain/handler sem keys ou sem preço → social-dependent (1 por est.)
//   Tier 3 — sem price_url e sem chain/handler → social-dependent (1 por est.)

import type { ShoppingListItem, Establishment, PriceObservation } from "../types";
import { advancedScrape, type ScrapeProgressInfo } from "./scraper";
import { isValidPrice, sanitizePrice } from "./price";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { safeLog } from "./safeLog";
import {
  resolveMarketHandler,
  searchMarketPrice,
  type MarketSearchKeys,
} from "./market-handlers";
import { findActivePromo } from "./offerSweep";

export interface LocalScrapeResult {
  itemId: string;
  itemName: string;
  establishmentId: string;
  /**
   * #56 — "notFound": página de ofertas varrida com sucesso mas o item não
   * está entre as promoções atuais (não conta como erro, não queima strategies).
   */
  status: "recorded" | "duplicate" | "no-price" | "error" | "social-dependent" | "notFound";
  price?: number;
  method?: string;
  error?: string;
  url: string;
}

// #52 — progresso vivo do scan local (emitido por item e por estratégia).
export interface LocalScanProgress {
  /** item dentro do estabelecimento (1-based) */
  index: number;
  /** total de itens do estabelecimento */
  total: number;
  itemName: string;
  /** estratégia do scraper quando disponível (ex.: PLAYWRIGHT_STEALTH) */
  strategy?: string;
  strategyTried?: number;
  strategyTotal?: number;
  /** contagem viva dentro deste estabelecimento */
  recorded: number;
  duplicates: number;
  errors: number;
}

export type LocalScrapeProgressCallback = (p: LocalScanProgress) => void;

export interface LocalPriceScanOutcome {
  establishmentId: string;
  establishmentName: string;
  results: LocalScrapeResult[];
  recorded: number;
  duplicates: number;
  errors: number;
  /** #32 — est. que precisam de coleta social (sem price_url e sem busca possível). */
  socialDependent?: number;
  /** Motivo legível do socialDependent (tier 2/3). */
  socialReason?: string;
  /** #55 — promoções extraídas da página de ofertas neste scan (varredura). */
  swept?: number;
  /** #55 — itens atendidos pelo promo-cache (promoção vigente, sem re-busca). */
  promoHits?: number;
}

export type LocalScrapeApiKeys = {
  lmStudioUrl?: string;
  nvidiaApiKey?: string;
  geminiApiKey?: string;
  /** #54 — PRINCIPAL da cadeia de interpretação */
  deepseekApiKey?: string;
} & MarketSearchKeys;

export function buildSearchUrl(priceUrl: string, term: string): string {
  const encoded = encodeURIComponent(term);
  if (priceUrl.includes("{term}")) {
    return priceUrl.replace("{term}", encoded);
  }
  const joiner = priceUrl.includes("?") ? "&" : "?";
  return `${priceUrl}${joiner}q=${encoded}`;
}

/** #27/#34 — dedup: preço idêntico (tolerância) na observação mais recente do par. */
export function isDuplicateObservation(
  previous: PriceObservation | undefined,
  price: number,
  tolerance = 0.01
): boolean {
  if (!previous) return false;
  return Math.abs(previous.price - price) < tolerance;
}

function recordObservation(
  establishment: Establishment,
  item: ShoppingListItem,
  price: number,
  notes: string,
  method?: string
): "recorded" | "duplicate" {
  const recent = PriceObservationRepository.getAll({
    shoppingListItemId: item.id,
    establishmentId: establishment.id,
  })[0];

  if (isDuplicateObservation(recent, price)) {
    safeLog(`[local-scrape] ${item.name} @ ${establishment.name}: duplicado (${price})`);
    return "duplicate";
  }

  const observedAt = new Date();
  const validUntil = new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  PriceObservationRepository.create({
    shoppingListItemId: item.id,
    establishmentId: establishment.id,
    price,
    observedAt: observedAt.toISOString(),
    source: "scraping",
    notes,
    validUntil,
  });
  safeLog(
    `[local-scrape] ${item.name} @ ${establishment.name}: R$ ${price} (${method ?? "scraping"})`
  );
  return "recorded";
}

async function scrapeViaPriceUrl(
  establishment: Establishment,
  item: ShoppingListItem,
  apiKeys: LocalScrapeApiKeys,
  opts?: { maxPriceTolerance?: number; onStrategyProgress?: (p: ScrapeProgressInfo) => void }
): Promise<LocalScrapeResult> {
  const url = buildSearchUrl(establishment.priceUrl!, item.name);
  const recent = PriceObservationRepository.getAll({
    shoppingListItemId: item.id,
    establishmentId: establishment.id,
  })[0];

  try {
    const info = await advancedScrape(url, {
      ...apiKeys,
      // #52 — estratégia atual da cascata (UI mostra PLAYWRIGHT → SEARCH → ...)
      onProgress: opts?.onStrategyProgress,
    });
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
      safeLog(`[local-scrape] ${item.name} @ ${establishment.name}: duplicado (${price})`);
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

function socialDependentResult(
  establishment: Establishment,
  item?: ShoppingListItem,
  reason?: string
): LocalScrapeResult {
  return {
    itemId: item?.id ?? "",
    itemName: item?.name ?? establishment.name,
    establishmentId: establishment.id,
    status: "social-dependent",
    error: reason,
    url: "",
  };
}

async function scrapeViaMarketSearch(
  establishment: Establishment,
  item: ShoppingListItem,
  apiKeys: LocalScrapeApiKeys
): Promise<LocalScrapeResult> {
  const handler = resolveMarketHandler(establishment.chain || establishment.name);
  if (!handler) {
    return socialDependentResult(establishment, item, "sem market-handler");
  }
  try {
    const hit = await searchMarketPrice(item.name, handler, apiKeys);
    if (!hit || !isValidPrice(hit.price)) {
      return socialDependentResult(
        establishment,
        item,
        "busca sem preço válido (depende de social)"
      );
    }
    const query = `search: ${item.name} ${handler.searchLabel}`;
    const outcome = recordObservation(
      establishment,
      item,
      hit.price,
      query,
      hit.method
    );
    if (outcome === "duplicate") {
      return {
        itemId: item.id,
        itemName: item.name,
        establishmentId: establishment.id,
        status: "duplicate",
        price: hit.price,
        method: hit.method,
        url: query,
      };
    }
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: "recorded",
      price: hit.price,
      method: hit.method,
      url: query,
    };
  } catch (err: any) {
    safeLog(`[local-scrape] market-search erro ${item.name} @ ${establishment.name}: ${err.message}`);
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: "error",
      error: err.message,
      url: "",
    };
  }
}

export async function scrapeItemPrice(
  establishment: Establishment,
  item: ShoppingListItem,
  apiKeys: LocalScrapeApiKeys,
  opts?: {
    maxPriceTolerance?: number;
    onStrategyProgress?: (p: ScrapeProgressInfo) => void;
    /** #56 — est. de página de ofertas varrida neste job ({swept: 0} = varredura vazia). */
    offersPage?: { swept: number };
  }
): Promise<LocalScrapeResult> {
  // #55 — promo-cache: promoção vigente desta loja que cobre o item → usa o
  // preço da promo SEM re-buscar (validade em promotions.expires_at; preenche
  // o histórico p/ "onde está mais barato" na hora).
  const promo = findActivePromo(establishment.id, item.name);
  if (promo) {
    const st = recordObservation(
      establishment,
      item,
      promo.promoPrice,
      `promo-cache:${promo.source || "sweep"}`,
      "promocao-vigente"
    );
    safeLog(
      `[local-scrape] PROMO-CACHE ${item.name} @ ${establishment.name}: R$ ${promo.promoPrice} (promo ${promo.id}, até ${(promo.expiresAt || "").slice(0, 10)})`
    );
    return {
      itemId: item.id,
      itemName: item.name,
      establishmentId: establishment.id,
      status: st,
      price: promo.promoPrice,
      method: `promo-vigente(${(promo.expiresAt || promo.endDate || "").slice(0, 10)})`,
      url: promo.sourceUrl || establishment.priceUrl || "",
    };
  }

  // #56 — página de ofertas (priceUrl sem {term}): `?q=<item>` é ignorado pelo
  // site (sempre mostra o encarte inteiro) → NUNCA entra na cascata de scrape.
  // Varredura OK + sem promo p/ o item = fora do encarte de hoje; varredura
  // vazia = erro curto (IA indisponível em vez de 7 strategies queimadas).
  if (opts?.offersPage) {
    const base = { itemId: item.id, itemName: item.name, establishmentId: establishment.id, url: establishment.priceUrl || "" };
    if (opts.offersPage.swept > 0) {
      safeLog(`[local-scrape] FORA DAS OFERTAS ${item.name} @ ${establishment.name} (varredura: ${opts.offersPage.swept} promoções)`);
      return {
        ...base,
        status: "notFound",
        method: "fora-das-ofertas",
        error: "fora das ofertas de hoje",
      };
    }
    safeLog(`[local-scrape] varredura vazia em ${establishment.name} → ${item.name} sem cascata ?q=`);
    return {
      ...base,
      status: "error",
      method: "varredura-vazia",
      error: "varredura não extraiu promoções — sem chave de IA ou IA indisponível (ver DeepSeek/Gemini)",
    };
  }

  if (establishment.priceUrl) {
    return scrapeViaPriceUrl(establishment, item, apiKeys, opts);
  }

  // #32 cascade sem price_url
  const handler = resolveMarketHandler(establishment.chain || establishment.name);
  if (!handler) {
    return socialDependentResult(establishment, item, "sem price_url e sem market-handler");
  }
  const canSearch =
    !!(apiKeys.serperApiKey || apiKeys.tavilyApiKey) &&
    !!(apiKeys.deepseekApiKey || apiKeys.geminiApiKey || apiKeys.nvidiaApiKey);
  if (!canSearch) {
    return socialDependentResult(
      establishment,
      item,
      "sem Serper/Tavily ou sem NVIDIA/Gemini (depende de social)"
    );
  }
  return scrapeViaMarketSearch(establishment, item, apiKeys);
}

export async function scanEstablishmentPrices(
  establishment: Establishment,
  items: ShoppingListItem[],
  apiKeys: LocalScrapeApiKeys,
  onItemProgress?: LocalScrapeProgressCallback,
  opts?: { offersPage?: { swept: number } }
): Promise<LocalPriceScanOutcome> {
  const base = {
    establishmentId: establishment.id,
    establishmentName: establishment.name,
  };

  // Tier 2/3 sem price_url: 1 outcome por est., sem loop por item
  if (!establishment.priceUrl) {
    const handler = resolveMarketHandler(establishment.chain || establishment.name);
    const canSearch =
      !!(apiKeys.serperApiKey || apiKeys.tavilyApiKey) &&
      !!(apiKeys.deepseekApiKey || apiKeys.geminiApiKey || apiKeys.nvidiaApiKey);
    if (!handler || !canSearch) {
      const reason = !handler
        ? "sem price_url e sem market-handler"
        : "sem Serper/Tavily ou DeepSeek/Gemini/NVIDIA — depende de social";
      safeLog(`[local-scrape] ${establishment.name}: social-dependent (${reason})`);
      return {
        ...base,
        results: [socialDependentResult(establishment, undefined, reason)],
        recorded: 0,
        duplicates: 0,
        errors: 0,
        socialDependent: 1,
        socialReason: reason,
      };
    }
  }

  const results: LocalScrapeResult[] = [];
  const liveCounts = () => ({
    recorded: results.filter((r) => r.status === "recorded").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    errors: results.filter((r) => r.status === "error").length,
  });
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const emit = (strategy?: string, strategyTried?: number, strategyTotal?: number) =>
      onItemProgress?.({
        index: i + 1,
        total: items.length,
        itemName: item.name,
        strategy,
        strategyTried,
        strategyTotal,
        ...liveCounts(),
      });
    emit(); // início do item
    results.push(
      await scrapeItemPrice(establishment, item, apiKeys, {
        onStrategyProgress: (p) => emit(p.strategy, p.triedCount, p.totalStrategies),
        offersPage: opts?.offersPage,
      })
    );
    emit(); // item concluído (contagens atualizadas)
  }

  const socialHits = results.filter((r) => r.status === "social-dependent");
  // socialDependent = 1 se o est. inteiro caiu no tier 2/3 (ou todos os itens)
  const socialDependent =
    socialHits.length === 0
      ? 0
      : socialHits.length === results.length || !establishment.priceUrl
      ? 1
      : socialHits.length;

  return {
    ...base,
    results,
    recorded: results.filter((r) => r.status === "recorded").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    errors: results.filter((r) => r.status === "error").length,
    socialDependent,
    socialReason: socialHits[0]?.error || undefined,
  };
}
