// FASE 7 — Insights locais com IA.
// Análise determinística (sem rede) dos preços observados + promoções ativas:
// melhor estabelecimento por item, custo por estabelecimento, economia entre
// "comprar tudo em um lugar" vs "rota multi-parada otimizada".

import type {
  Establishment,
  ShoppingListItem,
  PriceObservation,
  Promotion,
} from "../types";

export interface ItemInsight {
  itemId: string;
  itemName: string;
  quantity: number;
  unit?: string;
  targetPrice?: number;
  bestEstablishmentId: string;
  bestEstablishmentName: string;
  bestPrice: number;
  secondBestPrice?: number;
  secondBestEstablishmentName?: string;
  promotionApplied: boolean;
  withinTarget: boolean;
}

export interface EstablishmentInsight {
  establishmentId: string;
  establishmentName: string;
  totalCost: number;
  coveredItems: number;
  missingItems: number;
  promotionCount: number;
}

export interface SingleStoreBest {
  establishmentId: string;
  establishmentName: string;
  totalCost: number;
  coveredItems: number;
}

export interface LocalInsights {
  items: ItemInsight[];
  establishments: EstablishmentInsight[];
  singleStoreBest: SingleStoreBest | null;
  optimizedTotal: number;
  economyVsSingleStore: number;
  economyVsSingleStorePct: number;
  itemsWithPrice: number;
  itemsWithoutPrice: number;
  totalItems: number;
  generatedAt: string;
}

// Normaliza para comparação de nomes (minúsculas, sem acentos).
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A promoção "cobre" o item se os nomes normalizados coincidem por substrings
// (heurística simples — o ideal é o worker de IA refinar).
function promotionMatchesItem(promo: Promotion, itemName: string): boolean {
  const p = normalize(promo.productName);
  const i = normalize(itemName);
  if (!p || !i) return false;
  if (p === i) return true;
  return p.length >= 4 && i.length >= 4 && (p.includes(i) || i.includes(p));
}

export function buildLocalInsights(
  items: ShoppingListItem[],
  observations: PriceObservation[],
  establishments: Establishment[],
  promotions: Promotion[]
): LocalInsights {
  const estName = new Map(establishments.map((e) => [e.id, e.name]));

  // Menor preço observado por (itemId, establishmentId).
  const obsMin = new Map<string, Map<string, number>>();
  for (const o of observations) {
    if (!o.shoppingListItemId) continue;
    if (!obsMin.has(o.shoppingListItemId)) obsMin.set(o.shoppingListItemId, new Map());
    const perEst = obsMin.get(o.shoppingListItemId)!;
    const prev = perEst.get(o.establishmentId);
    if (prev === undefined || o.price < prev) perEst.set(o.establishmentId, o.price);
  }

  // Promoções ativas por estabelecimento, aplicadas como "preço" quando cobrem
  // um item e são mais baratas que a melhor observação.
  const promoPrice = new Map<string, Map<string, number>>();
  const activePromos = promotions.filter((p) => p.isActive !== false);
  for (const promo of activePromos) {
    for (const item of items) {
      if (!promotionMatchesItem(promo, item.name)) continue;
      if (!promoPrice.has(item.id)) promoPrice.set(item.id, new Map());
      const perEst = promoPrice.get(item.id)!;
      const prev = perEst.get(promo.establishmentId);
      if (prev === undefined || promo.promoPrice < prev) {
        perEst.set(promo.establishmentId, promo.promoPrice);
      }
    }
  }

  // Preço efetivo por (itemId, establishmentId) = min(observado, promo).
  function effectivePrice(itemId: string, estId: string): number | undefined {
    const candidates: number[] = [];
    const obs = obsMin.get(itemId)?.get(estId);
    const promo = promoPrice.get(itemId)?.get(estId);
    if (obs !== undefined) candidates.push(obs);
    if (promo !== undefined) candidates.push(promo);
    if (candidates.length === 0) return undefined;
    return Math.min(...candidates);
  }

  // Melhor estabelecimento por item.
  const itemsInsight: ItemInsight[] = items.map((item) => {
    const prices: { estId: string; price: number; promo: boolean }[] = [];
    for (const est of establishments) {
      const price = effectivePrice(item.id, est.id);
      if (price !== undefined) {
        const promo = (promoPrice.get(item.id)?.get(est.id) ?? Infinity) <= price;
        prices.push({ estId: est.id, price, promo });
      }
    }
    prices.sort((a, b) => a.price - b.price);

    if (prices.length === 0) {
      return {
        itemId: item.id,
        itemName: item.name,
        quantity: item.quantity ?? 1,
        unit: item.unit,
        targetPrice: item.targetPrice,
        bestEstablishmentId: "",
        bestEstablishmentName: "",
        bestPrice: 0,
        promotionApplied: false,
        withinTarget: false,
      };
    }

    const best = prices[0];
    const second = prices[1];
    return {
      itemId: item.id,
      itemName: item.name,
      quantity: item.quantity ?? 1,
      unit: item.unit,
      targetPrice: item.targetPrice,
      bestEstablishmentId: best.estId,
      bestEstablishmentName: estName.get(best.estId) ?? "—",
      bestPrice: best.price,
      secondBestPrice: second?.price,
      secondBestEstablishmentName: second ? estName.get(second.estId) ?? "—" : undefined,
      promotionApplied: best.promo,
      withinTarget: item.targetPrice !== undefined && best.price <= item.targetPrice,
    };
  });

  // Custo por estabelecimento (comprar todos os itens ali).
  const establishmentsInsight: EstablishmentInsight[] = establishments.map((est) => {
    let totalCost = 0;
    let covered = 0;
    let promos = 0;
    for (const item of items) {
      const price = effectivePrice(item.id, est.id);
      if (price !== undefined) {
        totalCost += price;
        covered++;
      }
      if (promoPrice.get(item.id)?.has(est.id)) promos++;
    }
    return {
      establishmentId: est.id,
      establishmentName: est.name,
      totalCost: Math.round(totalCost * 100) / 100,
      coveredItems: covered,
      missingItems: items.length - covered,
      promotionCount: promos,
    };
  });

  // Melhor compra "tudo em um lugar": maximiza cobertura, depois minimiza custo.
  const priced = establishmentsInsight.filter((e) => e.coveredItems > 0);
  priced.sort((a, b) => {
    if (b.coveredItems !== a.coveredItems) return b.coveredItems - a.coveredItems;
    return a.totalCost - b.totalCost;
  });
  const singleStoreBest: SingleStoreBest | null =
    priced.length > 0
      ? {
          establishmentId: priced[0].establishmentId,
          establishmentName: priced[0].establishmentName,
          totalCost: priced[0].totalCost,
          coveredItems: priced[0].coveredItems,
        }
      : null;

  // Custo otimizado multi-parada: menor preço de cada item em qualquer lugar.
  const optimizedTotal =
    Math.round(
      itemsInsight.reduce((sum, i) => sum + (i.bestPrice > 0 ? i.bestPrice : 0), 0) * 100
    ) / 100;

  const economy =
    singleStoreBest && optimizedTotal > 0
      ? Math.max(0, Math.round((singleStoreBest.totalCost - optimizedTotal) * 100) / 100)
      : 0;
  const economyPct =
    singleStoreBest && singleStoreBest.totalCost > 0
      ? Math.round((economy / singleStoreBest.totalCost) * 100)
      : 0;

  const itemsWithPrice = itemsInsight.filter((i) => i.bestPrice > 0).length;

  return {
    items: itemsInsight,
    establishments: establishmentsInsight,
    singleStoreBest,
    optimizedTotal,
    economyVsSingleStore: economy,
    economyVsSingleStorePct: economyPct,
    itemsWithPrice,
    itemsWithoutPrice: items.length - itemsWithPrice,
    totalItems: items.length,
    generatedAt: new Date().toISOString(),
  };
}

// Resumo determinístico (fallback quando a IA não está disponível).
export function summarizeInsights(insights: LocalInsights): string {
  const lines: string[] = [];
  lines.push("ANÁLISE DE MERCADO LOCAL — DADOS DETERMINÍSTICOS");
  lines.push("");

  if (insights.totalItems === 0) {
    lines.push("Lista de compras vazia. Registre itens e preços para obter insights.");
    return lines.join("\n");
  }

  if (insights.itemsWithPrice === 0) {
    lines.push(
      `Nenhum preço registrado (${insights.totalItems} itens). Registre observações de preço nos estabelecimentos.`
    );
    return lines.join("\n");
  }

  const inTarget = insights.items.filter((i) => i.withinTarget).length;
  lines.push(
    `Cobertura: ${insights.itemsWithPrice}/${insights.totalItems} itens com preço, ${inTarget} dentro do alvo.`
  );

  if (insights.singleStoreBest) {
    lines.push(
      `Comprar tudo em ${insights.singleStoreBest.establishmentName}: R$ ${insights.singleStoreBest.totalCost.toFixed(2)} (${insights.singleStoreBest.coveredItems} itens).`
    );
  }
  lines.push(`Rota otimizada multi-parada: R$ ${insights.optimizedTotal.toFixed(2)}.`);
  if (insights.economyVsSingleStore > 0) {
    lines.push(
      `Economia potencial: R$ ${insights.economyVsSingleStore.toFixed(2)} (${insights.economyVsSingleStorePct}%).`
    );
  } else {
    lines.push("Comprar tudo no melhor estabelecimento já é a estratégia ótima.");
  }

  const bestItems = insights.items.filter((i) => i.bestPrice > 0).slice(0, 5);
  if (bestItems.length > 0) {
    lines.push("");
    lines.push("Melhor preço por item:");
    for (const i of bestItems) {
      lines.push(
        `  • ${i.itemName}: R$ ${i.bestPrice.toFixed(2)} em ${i.bestEstablishmentName}${i.promotionApplied ? " (promoção)" : ""}`
      );
    }
  }

  const noPrice = insights.items.filter((i) => i.bestPrice === 0);
  if (noPrice.length > 0) {
    lines.push("");
    lines.push(`Itens sem preço registrado: ${noPrice.map((i) => i.itemName).join(", ")}.`);
  }

  return lines.join("\n");
}

// Prompt para o núcleo SENTINEL (Gemini) gerar análise em tom de HUD militar.
export function buildInsightPrompt(insights: LocalInsights): string {
  const itemLines = insights.items
    .filter((i) => i.bestPrice > 0)
    .map((i) => {
      const target = i.targetPrice ? ` (alvo R$ ${i.targetPrice})` : "";
      const promo = i.promotionApplied ? " [PROMO]" : "";
      return `- ${i.itemName}: melhor R$ ${i.bestPrice.toFixed(2)} em ${i.bestEstablishmentName}${target}${promo}`;
    })
    .join("\n");

  const estLines = insights.establishments
    .filter((e) => e.coveredItems > 0)
    .map((e) => `- ${e.establishmentName}: R$ ${e.totalCost.toFixed(2)} (${e.coveredItems}/${insights.totalItems} itens)`)
    .join("\n");

  return `Você é o SENTINEL, o sistema de inteligência de mercado do usuário. Analise os dados locais de compras abaixo e gere um relatório CURTO e DIRETO em português, tom de HUD militar (sem saudação, sem markdown pesado).

DADOS:
- Itens na lista: ${insights.totalItems}
- Itens com preço: ${insights.itemsWithPrice}
- Itens dentro do alvo: ${insights.items.filter((i) => i.withinTarget).length}

MELHOR PREÇO POR ITEM:
${itemLines}

CUSTO POR ESTABELECIMENTO (comprar tudo em um lugar):
${estLines}

Estratégia otimizada multi-parada: R$ ${insights.optimizedTotal.toFixed(2)}
Economia vs melhor estabelecimento único: R$ ${insights.economyVsSingleStore.toFixed(2)} (${insights.economyVsSingleStorePct}%)

Formato de resposta (máximo ~12 linhas):
1. VEREDICTO: uma frase recomendando a melhor estratégia de compra.
2. ECONOMIA: quanto o usuário economiza escolhendo a rota otimizada.
3. DESTAQUES: 2-3 observações importantes (promoções imperdíveis, itens sem preço, itens acima do alvo).
4. DICA: um conselho prático.`;
}
