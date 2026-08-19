// B4 — Popular Times: best-effort via SerpAPI (se key configurada) +
// heurística simples por tipo de estabelecimento + dia da semana.
//
// Não-bloqueante: se SerpAPI falhar ou não houver key, usa heurística.
// Não passamos por rota HTTP server.ts; o route-worker chama aqui direto.

import { safeLog } from "./safeLog";

// Score 0-100; maior = mais movimentado. Queremos janela de MENOR movimento.
// Heurística simples baseada em hábitos típicos BR:
//   - Supermercado/convenience: pico 17h-19h (dia útil), 10h-12h (sábado)
//   - Padaria: 7h-9h (manhã cedo, pão quente) e 17h-19h
//   - Marketplace/centro: 12h (almoco) e 18h
//   - Default: pico genérico 18h-19h dia útil
export function heuristicBusyScore(
  establishmentCategory: string | undefined,
  date: Date
): number {
  const hour = date.getHours();
  const day = date.getDay(); // 0=dom, 6=sáb
  const isWeekend = day === 0 || day === 6;
  const cat = (establishmentCategory || "").toLowerCase();
  const isSupermarket =
    cat.includes("super") || cat.includes("convenience") || cat.includes("market");
  const isBakery = cat.includes("bakery") || cat.includes("pão") || cat.includes("padaria");

  if (isSupermarket) {
    if (!isWeekend) return 18 <= hour && hour <= 19 ? 90 : hour < 8 || hour > 20 ? 20 : 50;
    return 10 <= hour && hour <= 12 ? 85 : hour < 8 || hour > 20 ? 25 : 55;
  }
  if (isBakery) {
    return (7 <= hour && hour <= 9) || (17 <= hour && hour <= 19) ? 80 : 40;
  }
  // Default
  if (!isWeekend && 17 <= hour && hour <= 19) return 85;
  if (!isWeekend && 12 <= hour && hour <= 13) return 70;
  if (hour < 8 || hour > 20) return 15;
  return 45;
}

// SerpAPI best-effort: busca Popular Times via endpoint "locations" ou
// directo Google Maps scrape. Como SerpAPI pode não ter places com este nome,
// retornamos null sempre que falhar e o caller usa heurística.
async function popularTimesBestEffort(
  placeName: string,
  opts: { serpApiKey?: string; timeoutMs?: number } = {}
): Promise<{ busyScore: number; popsByHour: Record<number, number> } | null> {
  if (!opts.serpApiKey) return null;
  // Implementação mínima: SerpAPI "google_maps" query. Retorno "popular_times"
  // no campo `popular_results` ou direto. Skipamos quando não há dados.
  const url = `https://serpapi.com/maps?engine=google_maps&query=${encodeURIComponent(placeName)}&api_key=${opts.serpApiKey}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as any;
    // SerpAPI pode retornar "place_results" com "popular_times"
    const todayIdx = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
    const popArr = data?.place_results?.popular_times;
    if (Array.isArray(popArr) && popArr.length > todayIdx) {
      const today = popArr[todayIdx];
      if (today && Array.isArray(today.data)) {
        const popsByHour: Record<number, number> = {};
        const currentHour = new Date().getHours();
        let currentBusy = 50;
        for (const item of today.data) {
          popsByHour[item.hour] = item.spikes ?? 50;
          if (item.hour === currentHour) currentBusy = item.spikes ?? 50;
        }
        return { busyScore: currentBusy, popsByHour };
      }
    }
    return null;
  } catch (err: any) {
    safeLog(`[popular-times] SerpAPI falhou: ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Score combinado de "quão ocupado" está agora esta parada. 0 = fantasma,
// 100 = lotado. Usa Popular Times se disponível; senão heurística.
export async function currentBusyScore(
  establishment: { name: string; category?: string },
  opts: { serpApiKey?: string } = {}
): Promise<{ score: number; source: "popular-times" | "heuristic" }> {
  const pt = await popularTimesBestEffort(establishment.name, { serpApiKey: opts.serpApiKey });
  if (pt) return { score: pt.busyScore, source: "popular-times" };
  return { score: heuristicBusyScore(establishment.category, new Date()), source: "heuristic" };
}

// Escolhe a melhor janela de saída entre 7h e 20h do dia atual: a janela em
// que a soma dos scores de movimento das paradas (heurística por categoria e
// horário de chegada) é mínima. Simples e determinístico — good enough para
// personal use.
export function suggestBestDepartureHour(
  stopCategories: (string | undefined)[],
  travelMinutesTotal: number,
  windowStart = 7,
  windowEnd = 20
): { departureHour: number; expectedTotalBusy: number } {
  let bestHour = windowStart;
  let bestScore = Infinity;
  for (let h = windowStart; h <= windowEnd; h++) {
    let acc = 0;
    let t = h * 60;
    for (const cat of stopCategories) {
      // Rough: distribui o tempo total igualmente entre as paradas
      const arrival = new Date();
      arrival.setHours(0, 0, 0, 0);
      arrival.setMinutes(t);
      acc += heuristicBusyScore(cat, arrival);
      t += Math.max(15, Math.round(travelMinutesTotal / Math.max(1, stopCategories.length)));
    }
    if (acc < bestScore) {
      bestScore = acc;
      bestHour = h;
    }
  }
  return { departureHour: bestHour, expectedTotalBusy: bestScore };
}
