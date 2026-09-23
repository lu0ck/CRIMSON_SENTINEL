// Otimizador de rota de compras (FASE 16 / tarefa #22).
// 1) Atribui cada item à loja mais barata (observação + promoção ativa).
// 2) Poda o conjunto de lojas respeitando route_max_stops.
// 3) Agrupa lojas quando a economia NÃO supera o custo extra de deslocamento
//    (roadmap: "agrupar por loja quando a economia superar o custo de
//    deslocamento" — aqui fazemos o contrário: remove loja se economia <= desloc).

import type { PriceObservation, Promotion, ShoppingListItem } from "../types";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function promotionMatchesItem(promo: Promotion, itemName: string): boolean {
  const p = normalize(promo.productName);
  const i = normalize(itemName);
  if (!p || !i) return false;
  if (p === i) return true;
  return p.length >= 4 && i.length >= 4 && (p.includes(i) || i.includes(p));
}

export interface StoreBasket {
  establishmentId: string;
  items: { itemId: string; itemName: string; price: number }[];
  cost: number;
}

export interface OptimizeRouteResult {
  establishmentIds: string[];
  assignment: Map<string, string>; // itemId -> establishmentId
  baskets: Map<string, StoreBasket>;
  totalPurchaseCost: number;
  itemsWithoutPrice: string[];
  prunedStores: number;
  mergedStores: number;
}

// Preço efetivo por (itemId, establishmentId) = min(menor observação, promoção).
export function buildEffectivePriceMap(
  itemIds: string[],
  observations: PriceObservation[],
  promotions: Promotion[],
  items: ShoppingListItem[]
): Map<string, Map<string, number>> {
  const wanted = new Set(itemIds);
  const itemName = new Map(items.map((i) => [i.id, i.name]));

  const obsMin = new Map<string, Map<string, number>>();
  for (const o of observations) {
    const itemId = o.shoppingListItemId;
    if (!itemId || !wanted.has(itemId)) continue;
    if (!obsMin.has(itemId)) obsMin.set(itemId, new Map());
    const perEst = obsMin.get(itemId)!;
    const prev = perEst.get(o.establishmentId);
    if (prev === undefined || o.price < prev) perEst.set(o.establishmentId, o.price);
  }

  const promoMin = new Map<string, Map<string, number>>();
  const active = promotions.filter((p) => p.isActive !== false);
  for (const itemId of itemIds) {
    const name = itemName.get(itemId);
    if (!name) continue;
    for (const promo of active) {
      if (!promotionMatchesItem(promo, name)) continue;
      if (!promoMin.has(itemId)) promoMin.set(itemId, new Map());
      const perEst = promoMin.get(itemId)!;
      const prev = perEst.get(promo.establishmentId);
      if (prev === undefined || promo.promoPrice < prev) {
        perEst.set(promo.establishmentId, promo.promoPrice);
      }
    }
  }

  const out = new Map<string, Map<string, number>>();
  for (const itemId of itemIds) {
    const perEst = new Map<string, number>();
    const obs = obsMin.get(itemId);
    const promo = promoMin.get(itemId);
    const estIds = new Set<string>([
      ...(obs?.keys() ?? []),
      ...(promo?.keys() ?? []),
    ]);
    for (const estId of estIds) {
      const candidates: number[] = [];
      const o = obs?.get(estId);
      const p = promo?.get(estId);
      if (o !== undefined) candidates.push(o);
      if (p !== undefined) candidates.push(p);
      if (candidates.length > 0) perEst.set(estId, Math.min(...candidates));
    }
    out.set(itemId, perEst);
  }
  return out;
}

// Atribui cada item à loja mais barata; lojas selecionadas = valores da atribuição.
export function assignItemsToCheapestStores(
  itemIds: string[],
  priceMap: Map<string, Map<string, number>>,
  itemName: Map<string, string>,
  allowedStores?: string[]
): {
  assignment: Map<string, string>;
  storeIds: string[];
  itemsWithoutPrice: string[];
} {
  const allowed = allowedStores && allowedStores.length > 0 ? new Set(allowedStores) : null;
  const assignment = new Map<string, string>();
  const itemsWithoutPrice: string[] = [];

  for (const itemId of itemIds) {
    const perEst = priceMap.get(itemId);
    if (!perEst || perEst.size === 0) {
      itemsWithoutPrice.push(itemId);
      continue;
    }
    let bestEst: string | null = null;
    let bestPrice = Infinity;
    for (const [estId, price] of perEst) {
      if (allowed && !allowed.has(estId)) continue;
      if (price < bestPrice) {
        bestPrice = price;
        bestEst = estId;
      }
    }
    if (bestEst) assignment.set(itemId, bestEst);
    else itemsWithoutPrice.push(itemId);
  }

  return {
    assignment,
    storeIds: [...new Set(assignment.values())],
    itemsWithoutPrice,
  };
}

// Poda para route_max_stops: ranqueia lojas pela economia potencial
// (soma de 2º melhor preço − preço na loja) e mantém as top-N.
// Itens órfãos (só existem em loja cortada) reatribuem à melhor loja
// restante com preço; se nenhuma tiver, a loja é re-incluída.
export function pruneStores(
  itemIds: string[],
  priceMap: Map<string, Map<string, number>>,
  assignment: Map<string, string>,
  storeIds: string[],
  maxStops: number
): { assignment: Map<string, string>; storeIds: string[]; pruned: number } {
  if (storeIds.length <= maxStops || maxStops <= 0) {
    return { assignment, storeIds, pruned: 0 };
  }

  // Economia por loja: para cada item nela, 2º melhor − atribuído.
  const savingsByStore = new Map<string, number>();
  for (const estId of storeIds) savingsByStore.set(estId, 0);
  for (const itemId of itemIds) {
    const perEst = priceMap.get(itemId);
    const assigned = assignment.get(itemId);
    if (!perEst || !assigned) continue;
    const prices = [...perEst.values()].sort((a, b) => a - b);
    const second = prices.length >= 2 ? prices[1] : prices[0];
    const cur = savingsByStore.get(assigned) ?? 0;
    savingsByStore.set(assigned, cur + Math.max(0, second - (perEst.get(assigned) ?? 0)));
  }

  const ranked = [...storeIds].sort(
    (a, b) => (savingsByStore.get(b) ?? 0) - (savingsByStore.get(a) ?? 0)
  );
  const kept = new Set(ranked.slice(0, maxStops));

  const newAssignment = new Map<string, string>();
  const forceKeep = new Set<string>();
  for (const itemId of itemIds) {
    const perEst = priceMap.get(itemId);
    const assigned = assignment.get(itemId);
    if (!perEst || !assigned) continue;
    if (kept.has(assigned)) {
      newAssignment.set(itemId, assigned);
      continue;
    }
    let bestEst: string | null = null;
    let bestPrice = Infinity;
    for (const estId of kept) {
      const p = perEst.get(estId);
      if (p !== undefined && p < bestPrice) {
        bestPrice = p;
        bestEst = estId;
      }
    }
    if (bestEst) {
      newAssignment.set(itemId, bestEst);
    } else {
      // Só existe na loja cortada — força mantê-la.
      newAssignment.set(itemId, assigned);
      forceKeep.add(assigned);
    }
  }

  const used = new Set(newAssignment.values());
  const finalStores = ranked.filter((s) => used.has(s) && (kept.has(s) || forceKeep.has(s)));
  for (const s of forceKeep) if (!finalStores.includes(s)) finalStores.push(s);

  const pruned = storeIds.length - finalStores.length;
  return { assignment: newAssignment, storeIds: finalStores, pruned: Math.max(0, pruned) };
}

// Remove lojas secundárias cuja economia (preço) não supera o custo extra de
// deslocamento. `distKm` = matriz completa [home, ...storesOriginais] (home = 0).
// `storeIds` inicial deve estar alinhado aos índices 1..n da matriz; o mapa de
// índices é fixo (a matriz não é reindexada quando lojas são removidas).
export function mergeUneconomicalStores(
  itemIds: string[],
  priceMap: Map<string, Map<string, number>>,
  assignment: Map<string, string>,
  storeIds: string[],
  distKm: number[][],
  costPerKm: number
): { assignment: Map<string, string>; storeIds: string[]; merged: number } {
  // Índice fixo na matriz original (home = 0, stores = 1..n).
  const storeIdx = new Map<string, number>(storeIds.map((s, i) => [s, i + 1]));

  // Distância do caminho home → lojas (NN) → home.
  const pathKm = (stores: string[]): number => {
    if (stores.length === 0) return 0;
    const remaining = new Set(stores.map((s) => storeIdx.get(s)!));
    const order: number[] = [];
    let cur = 0; // home
    while (remaining.size > 0) {
      let best = -1;
      let bestD = Infinity;
      for (const s of remaining) {
        const d = distKm[cur]?.[s] ?? Infinity;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best === -1) break;
      order.push(best);
      remaining.delete(best);
      cur = best;
    }
    let d = 0;
    let prev = 0;
    for (const idx of order) {
      d += distKm[prev]?.[idx] ?? 0;
      prev = idx;
    }
    d += distKm[prev]?.[0] ?? 0; // volta à casa
    return d;
  };

  const basketCost = (storeId: string, assign: Map<string, string>): number => {
    let c = 0;
    for (const itemId of itemIds) {
      if (assign.get(itemId) === storeId) c += priceMap.get(itemId)?.get(storeId) ?? 0;
    }
    return c;
  };

  const reassignTo = (
    assign: Map<string, string>,
    fromStore: string,
    remaining: string[]
  ): Map<string, string> => {
    const next = new Map(assign);
    for (const itemId of itemIds) {
      if (next.get(itemId) !== fromStore) continue;
      const perEst = priceMap.get(itemId);
      if (!perEst) continue;
      let bestEst: string | null = null;
      let bestPrice = Infinity;
      for (const estId of remaining) {
        const p = perEst.get(estId);
        if (p !== undefined && p < bestPrice) {
          bestPrice = p;
          bestEst = estId;
        }
      }
      if (bestEst) next.set(itemId, bestEst);
    }
    return next;
  };

  let current = [...storeIds];
  let currentAssign = new Map(assignment);
  let merged = 0;
  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    const anchor = [...current].sort(
      (a, b) => basketCost(b, currentAssign) - basketCost(a, currentAssign)
    )[0];

    for (const store of [...current]) {
      if (store === anchor) continue;
      const without = current.filter((s) => s !== store);
      const extraKm = Math.max(0, pathKm(current) - pathKm(without));
      const extraCost = extraKm * costPerKm;

      const nextAssign = reassignTo(currentAssign, store, without);
      let savingIfRemoved = 0;
      let allReassigned = true;
      for (const itemId of itemIds) {
        if (currentAssign.get(itemId) !== store) continue;
        if (nextAssign.get(itemId) === store) {
          allReassigned = false;
          break;
        }
        const original = priceMap.get(itemId)?.get(store);
        const fallbackEst = nextAssign.get(itemId);
        const fallback =
          fallbackEst && fallbackEst !== store
            ? priceMap.get(itemId)?.get(fallbackEst)
            : undefined;
        if (original !== undefined && fallback !== undefined) {
          savingIfRemoved += fallback - original; // >0 = loja era mais barata
        }
      }
      // Item órfão (só existe nesta loja) → não remove.
      if (!allReassigned) continue;
      // Mantém a loja somente se economia > custo extra de deslocamento.
      if (savingIfRemoved > extraCost + 1e-9) continue;

      current = without;
      currentAssign = nextAssign;
      merged++;
      changed = true;
      break; // reavalia com nova estrutura
    }
  }

  return { assignment: currentAssign, storeIds: current, merged };
}

export function buildBaskets(
  itemIds: string[],
  assignment: Map<string, string>,
  priceMap: Map<string, Map<string, number>>,
  itemName: Map<string, string>
): { baskets: Map<string, StoreBasket>; totalPurchaseCost: number } {
  const baskets = new Map<string, StoreBasket>();
  let total = 0;
  for (const itemId of itemIds) {
    const estId = assignment.get(itemId);
    if (!estId) continue;
    const price = priceMap.get(itemId)?.get(estId);
    if (price === undefined) continue;
    if (!baskets.has(estId)) {
      baskets.set(estId, { establishmentId: estId, items: [], cost: 0 });
    }
    const b = baskets.get(estId)!;
    b.items.push({ itemId, itemName: itemName.get(itemId) ?? itemId, price });
    b.cost += price;
    total += price;
  }
  for (const b of baskets.values()) b.cost = Math.round(b.cost * 100) / 100;
  return { baskets, totalPurchaseCost: Math.round(total * 100) / 100 };
}
