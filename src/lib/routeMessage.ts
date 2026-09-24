// #35 — compositor puro da mensagem "lista + roteiro" para WhatsApp do operador.
// Não toca em rede/sessão; só monta string a partir de RoutePlan + estabelecimentos.

import type { RoutePlan, Establishment } from "../types";

const VEHICLE_LABEL: Record<string, string> = {
  car: "CARRO",
  motorcycle: "MOTO",
  public: "TRANSPORTE PÚBLICO",
  bike: "BIKE",
  foot: "A PÉ",
};

const WA_SPLIT_CHARS = 4000;

function fmtMoney(n: number | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtLocal(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function buildRouteWhatsappMessage(
  route: RoutePlan,
  estById: Map<string, Establishment> | Record<string, Establishment>
): string {
  const getEst = (id: string): Establishment | undefined =>
    estById instanceof Map ? estById.get(id) : estById[id];

  const uniqueItems = new Map<string, string>();
  for (const stop of route.stops) {
    for (const item of stop.items || []) {
      uniqueItems.set(item.toLowerCase(), item);
    }
  }
  const itemList = [...uniqueItems.values()];

  const lines: string[] = [];
  lines.push("🛡️ [SENTINELA] LISTA + ROTEIRO");
  lines.push(
    `rota: ${route.name || route.id} • criada ${fmtLocal(route.createdAt)}`
  );
  lines.push("");

  lines.push(`📋 LISTA (${itemList.length} itens — da rota):`);
  if (itemList.length === 0) {
    lines.push(" (sem itens atribuídos às paradas)");
  } else {
    itemList.forEach((name, i) => lines.push(` ${i + 1}. ${name}`));
  }
  lines.push("");

  const vehicle = route.vehicleType ? VEHICLE_LABEL[route.vehicleType] || route.vehicleType : "";
  const meta: string[] = [];
  meta.push(`${route.stops.length} paradas`);
  if (route.totalDistanceKm !== undefined) meta.push(`${route.totalDistanceKm.toFixed(1)} km`);
  if (route.totalTimeMin !== undefined) meta.push(`~${Math.round(route.totalTimeMin)} min`);
  if (route.suggestedDepartureAt) meta.push(`saída ${fmtLocal(route.suggestedDepartureAt)}`);
  lines.push(`🧭 ROTEIRO (${meta.join(" • ")})`);
  lines.push(` Partida: (${route.startLat}, ${route.startLng})`);

  for (const stop of [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder)) {
    const est = getEst(stop.establishmentId);
    const parts: string[] = [];
    parts.push(`${stop.stopOrder}. ${(est?.name || stop.establishmentId).toUpperCase()}`);
    const arrival = fmtTime(stop.arrivalTimeEstimate);
    if (arrival) parts.push(`chega ${arrival}`);
    if (stop.estimatedCost !== undefined) parts.push(fmtMoney(stop.estimatedCost));
    if (stop.quietScore !== undefined) parts.push(`MOV ${stop.quietScore}% tranquilo`);
    lines.push(` ${parts.join(" — ")}`);
    if (stop.items && stop.items.length > 0) {
      lines.push(` itens: ${stop.items.join(", ")}`);
    }
    if (est?.address) {
      const loc = [est.address, est.city, est.state].filter(Boolean).join(", ");
      lines.push(` endereço: ${loc}`);
    }
  }

  lines.push("");
  const purchase = (route.totalEstimatedCost ?? 0) - (route.travelCost ?? 0);
  const totalParts: string[] = [];
  if (purchase > 0) totalParts.push(`compra ${fmtMoney(purchase)}`);
  if (route.travelCost) totalParts.push(`desloc ${fmtMoney(route.travelCost)}`);
  if (route.totalEstimatedCost !== undefined) totalParts.push(`total ${fmtMoney(route.totalEstimatedCost)}`);
  lines.push(`💵 ${totalParts.length ? totalParts.join(" + ") : "—"}`);
  if (vehicle) lines.push(`🚗 veículo: ${vehicle}`);

  return lines.join("\n");
}

/** Divide em chunks de no máximo WA_SPLIT_CHARS (quebra em newline quando possível). */
export function splitWhatsappMessage(msg: string, maxChars = WA_SPLIT_CHARS): string[] {
  if (msg.length <= maxChars) return [msg];
  const parts: string[] = [];
  let rest = msg;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}
