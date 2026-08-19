import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { RouteJobPayload, RouteVehicle } from "../queue/types";
import { safeLog } from "../lib/safeLog";
import { haversineKm, osrmDistanceDurationMatrix, haversineMatrixKm } from "../lib/geo";
import { solveTsp } from "../lib/tsp";
import { currentBusyScore, suggestBestDepartureHour } from "../lib/popularTimes";
import { EstablishmentRepository } from "../repositories/establishmentRepository";
import { ShoppingListRepository } from "../repositories/shoppingListRepository";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { RouteRepository } from "../repositories/routeRepository";
import type { RoutePlan } from "../types";

// Resolve o conjunto de estabelecimentos a visitar. Prioriza os explícitos no
// payload; senão, deriva dos itens via price_observations (os locais onde cada
// item já teve preço observado).
function resolveEstablishmentIds(
  shoppingListItemIds: string[],
  explicit: string[] | undefined
): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const obs = PriceObservationRepository.getByShoppingItems(shoppingListItemIds);
  return [...new Set(obs.map((o) => o.establishmentId))];
}

// Custo estimado por parada: soma do MENOR preço observado de cada item naquele
// estabelecimento. Itens sem observação ali não entram no custo daquela parada.
function costPerStop(
  establishmentId: string,
  shoppingListItemIds: string[]
): { cost: number; items: string[] } {
  const itemNames = new Map(
    ShoppingListRepository.getByIds(shoppingListItemIds).map((i) => [i.id, i.name])
  );
  const obs = PriceObservationRepository.getByShoppingItems(shoppingListItemIds).filter(
    (o) => o.establishmentId === establishmentId && o.shoppingListItemId
  );

  const minByItem = new Map<string, number>();
  for (const o of obs) {
    const id = o.shoppingListItemId!;
    const prev = minByItem.get(id);
    if (prev === undefined || o.price < prev) minByItem.set(id, o.price);
  }

  let cost = 0;
  const items: string[] = [];
  for (const [itemId, price] of minByItem) {
    cost += price;
    const name = itemNames.get(itemId);
    if (name) items.push(name);
  }
  return { cost: Math.round(cost * 100) / 100, items };
}

// B4 — custo de deslocamento baseado no veículo. Para car/motorcycle:
// (km / km_l) * R$/L. Para public: tarifa fixa por viagem. bike/foot: 0.
function calculateTravelCost(
  vehicle: RouteVehicle | undefined,
  totalDistanceKm: number
): { cost: number; fuelConsumptionKmPerL?: number; fuelPricePerL?: number } {
  if (!vehicle) return { cost: 0 };
  switch (vehicle.type) {
    case "car":
    case "motorcycle": {
      const kmL = vehicle.fuelConsumptionKmPerL ?? 10;
      const priceL = vehicle.fuelPricePerL ?? 6;
      return {
        cost: Math.round((totalDistanceKm / kmL) * priceL * 100) / 100,
        fuelConsumptionKmPerL: kmL,
        fuelPricePerL: priceL,
      };
    }
    case "public":
      return { cost: vehicle.publicFare ?? 5 };
    case "bike":
    case "foot":
      return { cost: 0 };
    default:
      return { cost: 0 };
  }
}

async function handleRoute(job: Job<RouteJobPayload & { type: "route" }>) {
  const { shoppingListItemIds, startLat, startLng, establishmentIds, name, vehicle, startTime } = job.data;
  safeLog(
    `[route-worker] planejando rota com ${shoppingListItemIds.length} itens a partir de (${startLat},${startLng}) vehicle=${vehicle?.type ?? "none"} startTime=${startTime ?? "default"}`
  );

  const estIds = resolveEstablishmentIds(shoppingListItemIds, establishmentIds);
  const establishments = EstablishmentRepository.getByIds(estIds);
  if (establishments.length === 0) {
    throw new Error("Nenhum estabelecimento encontrado para os itens informados");
  }

  // B4 — matriz distância E duração via OSRM (fallback haversine só distância).
  // Índice 0 = ponto de partida, demais = estabelecimentos.
  const points = [
    { lat: startLat, lng: startLng },
    ...establishments.map((e) => ({ lat: e.lat, lng: e.lng })),
  ];
  const osrmMatrix = await osrmDistanceDurationMatrix(points);
  let distancesKm: number[][];
  let durationsMinMatrix: number[][];
  if (osrmMatrix) {
    distancesKm = osrmMatrix.distancesKm;
    durationsMinMatrix = osrmMatrix.durationsMin;
  } else {
    safeLog("[route-worker] OSRM falhou — usando haversine para distância e estimativa 50km/h para tempo");
    distancesKm = haversineMatrixKm(points);
    // Estimativa: 50 km/h urbano → minutos = km / 50 * 60
    durationsMinMatrix = distancesKm.map((row) =>
      row.map((d) => (d === Infinity ? Infinity : (d / 50) * 60))
    );
  }
  const { order, distanceKm } = solveTsp(distancesKm, 0);

  // B4 — totalTimeMin somando durations entre paradas consecutivas na ordem.
  let totalTimeMin = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const seg = durationsMinMatrix[a]?.[b];
    if (typeof seg === "number" && seg !== Infinity) totalTimeMin += seg;
  }
  totalTimeMin = Math.round(totalTimeMin);

  // B4 — suggested departure: se startTime === "suggest", escolhe melhor hora.
  let departureAt: Date;
  if (startTime === "suggest") {
    const catsInOrder: (string | undefined)[] = [];
    for (let i = 1; i < order.length; i++) {
      catsInOrder.push(establishments[order[i] - 1].category);
    }
    const best = suggestBestDepartureHour(catsInOrder, totalTimeMin);
    departureAt = new Date();
    departureAt.setHours(best.departureHour, 0, 0, 0);
    if (departureAt.getTime() < Date.now()) {
      // Se já passou da hora hoje, agenda para amanhã mesmo horário
      departureAt.setDate(departureAt.getDate() + 1);
    }
    safeLog(`[route-worker] sugestão saída ${departureAt.toISOString()} (busyScore acumulado ${best.expectedTotalBusy})`);
  } else if (startTime && startTime !== "suggest") {
    departureAt = new Date(startTime);
  } else {
    departureAt = new Date();
  }

  // B4 — arrivalAt por parada + quietScore via Popular Times best-effort.
  const stops: RoutePlan["stops"] = [];
  let totalPurchaseCost = 0;
  let cursor = new Date(departureAt).getTime();
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1];
    const cur = order[i];
    const seg = durationsMinMatrix[prev]?.[cur];
    const segMin = typeof seg === "number" && seg !== Infinity ? seg : 0;
    cursor += segMin * 60_000;
    const est = establishments[cur - 1];
    const { cost, items } = costPerStop(est.id, shoppingListItemIds);
    totalPurchaseCost += cost;
    // Quiet score (0=lotado, 100=vazio) — best effort, low-cost
    let quietScore: number | undefined;
    try {
      const busy = await currentBusyScore({ name: est.name, category: est.category }, {});
      quietScore = Math.round(100 - busy.score);
    } catch {
      // best-effort; anda sem score se falhar
    }
    stops.push({
      establishmentId: est.id,
      stopOrder: i,
      estimatedCost: cost,
      items,
      arrivalTimeEstimate: new Date(cursor).toISOString(),
      quietScore,
    });
  }

  // B4 — custo de deslocamento (combustível ou tarifa pública)
  const travel = calculateTravelCost(vehicle, distanceKm);
  const totalCost = Math.round((totalPurchaseCost + (travel.cost || 0)) * 100) / 100;

  const route: RoutePlan = {
    id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    startLat,
    startLng,
    totalDistanceKm: Math.round(distanceKm * 100) / 100,
    totalEstimatedCost: totalCost,
    createdAt: new Date().toISOString(),
    stops,
    vehicleType: vehicle?.type,
    totalTimeMin,
    suggestedDepartureAt: departureAt.toISOString(),
    travelCost: travel.cost || 0,
    fuelConsumptionKmPerL: travel.fuelConsumptionKmPerL,
    fuelPricePerL: travel.fuelPricePerL,
  };
  RouteRepository.save(route);

  safeLog(
    `[route-worker] rota ${route.id}: ${establishments.length} paradas, ${route.totalDistanceKm}km, ${totalTimeMin}min, saída ${departureAt.toISOString()}, compra R$${totalPurchaseCost}, desloc R$${travel.cost || 0}, total R$${totalCost}`
  );
  return {
    routeId: route.id,
    stopCount: stops.length,
    totalDistanceKm: route.totalDistanceKm,
    totalTimeMin,
    suggestedDepartureAt: route.suggestedDepartureAt,
    totalPurchaseCost: Math.round(totalPurchaseCost * 100) / 100,
    travelCost: travel.cost || 0,
    totalEstimatedCost: totalCost,
    vehicleType: vehicle?.type,
    stops: stops.map((s) => ({
      establishmentId: s.establishmentId,
      stopOrder: s.stopOrder,
      estimatedCost: s.estimatedCost,
      items: s.items,
      arrivalTimeEstimate: s.arrivalTimeEstimate,
      quietScore: s.quietScore,
    })),
  };
}

export function startRouteWorker() {
  const worker = new Worker<RouteJobPayload>(
    QUEUE_NAMES.ROUTE,
    async (job) => {
      safeLog(`[route-worker] job ${job.id}`);
      return handleRoute(job as Job<RouteJobPayload & { type: "route" }>);
    },
    {
      connection: getRedis(),
      concurrency: 1,
      // A4: lock para evitar jobs presos
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    }
  );

  worker.on("completed", (job, result) => {
    safeLog(`[route-worker] ${job.id} ok`);
  });
  worker.on("failed", (job, err) => {
    safeLog(`[route-worker] ${job?.id} falhou: ${err.message}`);
  });
  console.log("[route-worker] rodando, escutando " + QUEUE_NAMES.ROUTE);
  return worker;
}
