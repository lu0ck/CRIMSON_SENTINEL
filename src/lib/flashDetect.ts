// C1 — Detecção de promoção relâmpago (flash)
// Regra: preço observado está X% (configurável, default 30%) abaixo da média
// histórica dos últimos N dias (default 30) daquele produto/item, OU abaixo do
// menor preço já visto.

import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { SettingsRepository } from "../repositories/settingsRepository";
import { PromotionRepository } from "../repositories/promotionRepository";
import type { Promotion } from "../types";

export interface FlashParams {
  thresholdPct: number; // ex: 30 → 30% abaixo da média
  historyDays: number; // janela temporal
}

export function getFlashParams(): FlashParams {
  return {
    thresholdPct: SettingsRepository.getNumber("flash_threshold_pct") ?? 30,
    historyDays: SettingsRepository.getNumber("flash_history_days") ?? 30,
  };
}

// Histórico de preço para um(item локал) ou produto e-commerce. Nota: para
// e-commerce, a função caller deve passar priceHistory[] separadamente; este
// helper é apenas para itens locais (price_observations).
export function itemHistoricalPrices(itemId: string): { observedAt: string; price: number }[] {
  return PriceObservationRepository.getAll({ shoppingListItemId: itemId }).map((o) => ({
    observedAt: o.observedAt,
    price: o.price,
  }));
}

// Calcula a média dos preços observados nos últimos N dias. Retorna null se
// não houver histórico suficiente (mínimo 2 pontos).
export function averageOfLastNDays(
  history: { observedAt: string; price: number }[],
  days: number
): number | null {
  if (!history || history.length === 0) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = history.filter((h) => new Date(h.observedAt).getTime() >= cutoff);
  if (recent.length < 2) return null;
  return recent.reduce((s, h) => s + h.price, 0) / recent.length;
}

export function lowestHistoryPrice(
  history: { observedAt?: string; price: number }[]
): number | null {
  if (!history || history.length === 0) return null;
  return history.reduce((min, h) => (h.price < min ? h.price : min), history[0].price);
}

// Decide se o preço observado é uma promoção relâmpago.
// Retorna dados para criar a promoção caso sim.
export function isFlashPrice(
  currentPrice: number,
  history: { observedAt?: string; price: number }[]
): { isFlash: boolean; reason?: string; average?: number; lowest?: number } {
  const params = getFlashParams();
  const avg = averageOfLastNDays(
    history.filter((h) => h.observedAt).map((h) => ({ observedAt: h.observedAt!, price: h.price })),
    params.historyDays
  );
  const lowest = lowestHistoryPrice(history);

  // Critério 1: X% abaixo da média histórica
  if (avg && currentPrice <= avg * (1 - params.thresholdPct / 100)) {
    return { isFlash: true, reason: `abaixo de ${params.thresholdPct}% da média ${params.historyDays}d`, average: avg, lowest: lowest ?? undefined };
  }
  // Critério 2: abaixo do menor preço já visto (com tolerância de 1%)
  if (lowest !== null && currentPrice < lowest * 0.99) {
    return { isFlash: true, reason: `novo mínimo histórico (era ${lowest})`, average: avg ?? undefined, lowest };
  }
  return { isFlash: false, average: avg ?? undefined, lowest: lowest ?? undefined };
}

// Cria a promoção relâmpago no banco automaticamente. Idempotente: se já
// existe uma flash ativa para o mesmo produto/estabelecimento/preço nas
// últimas 24h, não duplica (dedup simples por produto+est+price).
export function createFlashPromotion(input: {
  productName: string;
  establishmentId: string;
  currentPrice: number;
  regularPrice?: number;
  source?: Promotion["source"];
  detectedAt: string;
}): Promotion | null {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const id = `flash-${input.establishmentId}-${input.productName.toLowerCase().replace(/\s+/g, "-").slice(0, 30)}-${Date.now()}`;
  const promo: Promotion = {
    id,
    establishmentId: input.establishmentId,
    productName: input.productName,
    regularPrice: input.regularPrice,
    promoPrice: input.currentPrice,
    source: input.source ?? "scraping",
    detectedAt: input.detectedAt,
    isActive: true,
    isFlash: true,
    expiresAt,
  };
  PromotionRepository.save(promo);
  return promo;
}
