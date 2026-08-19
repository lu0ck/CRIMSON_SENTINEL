import type { Product, PriceObservation, ShoppingListItem, Establishment } from "../types";

export interface PricePoint {
  date: string;
  price: number;
  source?: string;
}

export interface PriceSeries {
  id: string;
  label: string;
  points: PricePoint[];
  stats: SeriesStats;
}

export interface SeriesStats {
  current: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  changePct: number | null;
  count: number;
}

export interface PriceHistoryEntity {
  id: string;
  label: string;
  kind: "product" | "item";
  series: PriceSeries[];
}

export interface PriceHistoryPayload {
  ecommerce: PriceHistoryEntity[];
  local: PriceHistoryEntity[];
}

export function computeStats(points: PricePoint[]): SeriesStats {
  if (points.length === 0) {
    return { current: null, min: null, max: null, avg: null, changePct: null, count: 0 };
  }
  const prices = points.map((p) => p.price);
  const current = prices[prices.length - 1];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const first = prices[0];
  const changePct = first > 0 ? ((current - first) / first) * 100 : null;
  return { current, min, max, avg, changePct, count: prices.length };
}

export function sortPointsByDate(points: PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export function buildEcommerceEntities(products: Product[]): PriceHistoryEntity[] {
  const entities: PriceHistoryEntity[] = [];
  for (const product of products) {
    if (!product.priceHistory || product.priceHistory.length === 0) continue;
    const points = sortPointsByDate(
      product.priceHistory.map((h) => ({ date: h.date, price: h.price, source: "scrape" }))
    );
    entities.push({
      id: product.id,
      label: product.name,
      kind: "product",
      series: [
        {
          id: `${product.id}::scrape`,
          label: product.name,
          points,
          stats: computeStats(points),
        },
      ],
    });
  }
  return entities;
}

export function buildLocalEntities(
  items: ShoppingListItem[],
  observations: PriceObservation[],
  establishments: Establishment[]
): PriceHistoryEntity[] {
  const estById = new Map(establishments.map((e) => [e.id, e.name]));
  const obsByItem = new Map<string, PriceObservation[]>();
  for (const obs of observations) {
    if (!obs.shoppingListItemId) continue;
    const bucket = obsByItem.get(obs.shoppingListItemId) ?? [];
    bucket.push(obs);
    obsByItem.set(obs.shoppingListItemId, bucket);
  }

  const entities: PriceHistoryEntity[] = [];
  for (const item of items) {
    const obs = obsByItem.get(item.id);
    if (!obs || obs.length === 0) continue;

    const byEst = new Map<string, PriceObservation[]>();
    for (const o of obs) {
      const bucket = byEst.get(o.establishmentId) ?? [];
      bucket.push(o);
      byEst.set(o.establishmentId, bucket);
    }

    const series: PriceSeries[] = [];
    for (const [estId, bucket] of byEst) {
      const points = sortPointsByDate(
        bucket.map((o) => ({ date: o.observedAt, price: o.price, source: o.source ?? "manual" }))
      );
      series.push({
        id: `${item.id}::${estId}`,
        label: estById.get(estId) ?? estId,
        points,
        stats: computeStats(points),
      });
    }

    entities.push({ id: item.id, label: item.name, kind: "item", series });
  }
  return entities;
}

export function filterByRange(points: PricePoint[], days: number): PricePoint[] {
  if (!days || days <= 0) return points;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((p) => new Date(p.date).getTime() >= cutoff);
}
