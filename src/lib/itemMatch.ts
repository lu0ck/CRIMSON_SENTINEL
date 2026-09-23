// Match item × promoção — FONTE ÚNICA (#27).
// Antes era copiado byte a byte em localInsights.ts e routeOptimizer.ts
// (insights e rota podiam divergir se um fosse alterado sem o outro).

import type { Promotion } from "../types";
import { normalizeText } from "./text";

/**
 * A promoção "cobre" o item se os nomes normalizados coincidem por
 * igualdade ou substring (≥4 chars em cada lado — heurística simples).
 */
export function promotionMatchesItem(
  promo: Pick<Promotion, "productName">,
  itemName: string
): boolean {
  const p = normalizeText(promo.productName);
  const i = normalizeText(itemName);
  if (!p || !i) return false;
  if (p === i) return true;
  return p.length >= 4 && i.length >= 4 && (p.includes(i) || i.includes(p));
}
