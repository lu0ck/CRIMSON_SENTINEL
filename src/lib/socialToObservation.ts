// #34 — bridge social → price_observations.
// Roadmap FASE 16: Stories/WhatsApp "→ observação local". O socialWorker só
// gravava promotions; insights/rota/histórico/flash leem price_observations
// (com shoppingListItemId). Dual-write: promoção E observação.

import type { ParsedPromo } from "./socialParse";
import type { PriceObservation, ShoppingListItem } from "../types";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { ShoppingListRepository } from "../repositories/shoppingListRepository";
import { promotionMatchesItem } from "./itemMatch";
import { isDuplicateObservation } from "./localPriceScrape";
import { isValidPrice, sanitizePrice } from "./price";
import { safeLog } from "./safeLog";

export type SocialObservationSource =
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "social";

export interface BridgeResult {
  status: "recorded" | "duplicate" | "no-item" | "no-establishment" | "invalid-price";
  itemId?: string;
  observationId?: number;
}

export interface BridgeCounters {
  recorded: number;
  duplicates: number;
  noItem: number;
}

export function emptyBridgeCounters(): BridgeCounters {
  return { recorded: 0, duplicates: 0, noItem: 0 };
}

export function mergeBridgeCounters(into: BridgeCounters, results: BridgeResult[]): BridgeCounters {
  for (const r of results) {
    if (r.status === "recorded") into.recorded++;
    else if (r.status === "duplicate") into.duplicates++;
    else if (r.status === "no-item") into.noItem++;
  }
  return into;
}

/** Itens da lista de compras cobertos pela promoção (fonte: itemMatch #27). */
export function matchItemsForPromo(
  promo: Pick<ParsedPromo, "productName">,
  items?: ShoppingListItem[]
): ShoppingListItem[] {
  const list = items ?? ShoppingListRepository.getAll();
  return list.filter((item) => promotionMatchesItem(promo, item.name));
}

/**
 * Bridge de uma promoção social → price_observations (uma linha por item casado).
 * Dedup independente de isDuplicatePromo: só observação (Δ < 0,01 no par item+est).
 * Sem match de item → no-item (linha sem shoppingListItemId é invisível p/ insights/rota).
 */
export function bridgePromoToObservations(input: {
  promo: Pick<ParsedPromo, "productName" | "promoPrice" | "establishmentId">;
  source: SocialObservationSource;
  notes?: string;
  observedAt?: string;
  validUntil?: string;
  items?: ShoppingListItem[];
}): BridgeResult[] {
  const { promo, source, notes, observedAt, validUntil, items } = input;

  if (!promo.establishmentId) {
    return [{ status: "no-establishment" }];
  }
  const price = sanitizePrice(Number(promo.promoPrice));
  if (!isValidPrice(price)) {
    return [{ status: "invalid-price" }];
  }

  const matched = matchItemsForPromo(promo, items);
  if (matched.length === 0) {
    return [{ status: "no-item" }];
  }

  const now = observedAt || new Date().toISOString();
  const until =
    validUntil || new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const note = notes || `social:${source}`;

  const results: BridgeResult[] = [];
  for (const item of matched) {
    const recent = PriceObservationRepository.getAll({
      shoppingListItemId: item.id,
      establishmentId: promo.establishmentId,
    })[0];

    if (isDuplicateObservation(recent, price)) {
      results.push({ status: "duplicate", itemId: item.id });
      continue;
    }

    const created = PriceObservationRepository.create({
      shoppingListItemId: item.id,
      establishmentId: promo.establishmentId,
      price,
      observedAt: now,
      source,
      notes: note,
      validUntil: until,
    });
    safeLog(
      `[social-bridge] ${item.name} @ ${promo.establishmentId}: R$ ${price} (${source})`
    );
    results.push({ status: "recorded", itemId: item.id, observationId: created.id });
  }
  return results;
}

export function bridgeSummary(c: BridgeCounters): string {
  return `${c.recorded} obs, ${c.duplicates} dup, ${c.noItem} sem item`;
}
