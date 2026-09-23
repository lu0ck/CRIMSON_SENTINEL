import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { RouteJobPayload, RouteVehicle } from "../queue/types";
import { safeLog } from "../lib/safeLog";
import { osrmDistanceDurationMatrix, haversineMatrixKm } from "../lib/geo";
import { solveTsp } from "../lib/tsp";
import {
  assignItemsToCheapestStores,
  buildBaskets,
  buildEffectivePriceMap,
  mergeUneconomicalStores,
  pruneStores,
} from "../lib/routeOptimizer";
import { currentBusyScore, suggestBestDepartureHour } from "../lib/popularTimes";
import { EstablishmentRepository } from "../repositories/establishmentRepository";
import { ShoppingListRepository } from "../repositories/shoppingListRepository";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { PromotionRepository } from "../repositories/promotionRepository";
import { SettingsRepository } from "../repositories/settingsRepository";
import { RouteRepository } from "../repositories/routeRepository";
import type { RoutePlan } from "../types";

// Tempo médio de compra por parada (min) — evita subestimar a rota.
const SHOPPING_MIN_PER_STOP = 15;

// B4 — custo por km do veículo (para agrupar lojas: economia vs deslocamento).
function vehicleCostPerKm(vehicle: RouteVehicle | undefined): number {
  if (!vehicle) return 0;
  switch (vehicle.type) {
    case "car":
    case "motorcycle": {
      const kmL = vehicle.fuelConsumptionKmPerL ?? 10;
      const priceL = vehicle.fuelPricePerL ?? 6;
      return priceL / kmL;
    }
    case "public":
      return (vehicle.publicFare ?? 5) / 10;
    case "bike":
    case "foot":
      return 0;
    default:
      return 0;
  }
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
  const { shoppingListItemIds, establishmentIds, name, vehicle, startTime } = job.data;
  // Default: round-trip (volta para a Casa) — #22.
  const roundTrip = job.data.roundTrip !== false;
  // Fallback defensivo: se o payload vier sem partida, usa a Casa (user_lat/user_lng).
  let { startLat, startLng } = job.data;
  if (startLat === undefined || startLng === undefined) {
    const homeLat = SettingsRepository.getNumber("user_lat");
    const homeLng = SettingsRepository.getNumber("user_lng");
    if (homeLat === undefined || homeLng === undefined || isNaN(homeLat) || isNaN(homeLng)) {
      throw new Error("Ponto de partida ausente e Casa (user_lat/user_lng) não configurada");
    }
    startLat = homeLat;
    startLng = homeLng;
    safeLog(`[route-worker] usando Casa como partida (${homeLat},${homeLng})`);
  }
  safeLog(
    `[route-worker] planejando rota com ${shoppingListItemIds.length} itens a partir de (${startLat},${startLng}) vehicle=${vehicle?.type ?? "none"} startTime=${startTime ?? "default"} roundTrip=${roundTrip}`
  );

  // ---- Otimização (#22): atribuição item→loja mais barata + poda + agrupamento ----
  const items = ShoppingListRepository.getByIds(shoppingListItemIds);
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const observations = PriceObservationRepository.getByShoppingItems(shoppingListItemIds);
  const promotions = PromotionRepository.getAll({ onlyActiveOrFlash: true });
  const priceMap = buildEffectivePriceMap(
    shoppingListItemIds,
    observations,
    promotions,
    items
  );

  let { assignment, storeIds } = assignItemsToCheapestStores(
    shoppingListItemIds,
    priceMap,
    itemName,
    establishmentIds
  );
  if (storeIds.length === 0) {
    throw new Error(
      "Nenhum preço observado ou promoção ativa para os itens selecionados — cadastre preços primeiro"
    );
  }

  const maxStops = SettingsRepository.getNumber("route_max_stops") ?? 15;
  const pruned = pruneStores(shoppingListItemIds, priceMap, assignment, storeIds, maxStops);
  assignment = pruned.assignment;
  storeIds = pruned.storeIds;
  if (pruned.pruned > 0) {
    safeLog(`[route-worker] poda route_max_stops=${maxStops}: ${pruned.pruned} loja(s) removida(s)`);
  }

  const allEstabs = EstablishmentRepository.getByIds(storeIds);
  const estabById = new Map(allEstabs.map((e) => [e.id, e]));
  const orderedEstabs = storeIds
    .map((id) => estabById.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e);
  if (orderedEstabs.length === 0) {
    throw new Error("Nenhum estabelecimento encontrado para os itens informados");
  }
  // Mantém storeIds alinhado com orderedEstabs (remove ids sem estabelecimento).
  storeIds = orderedEstabs.map((e) => e.id);

  // ---- Matriz distância/tempo (índice 0 = Casa) ----
  const points = [
    { lat: startLat, lng: startLng },
    ...orderedEstabs.map((e) => ({ lat: e.lat, lng: e.lng })),
  ];
  const osrmMatrix = await osrmDistanceDurationMatrix(points);
  let distancesKm: number[][];
  let durationsMinMatrix: number[][];
  if (osrmMatrix) {
    distancesKm = osrmMatrix.distancesKm;
    durationsMinMatrix = osrmMatrix.durationsMin;
  } else {
    safeLog(
      "[route-worker] OSRM falhou — usando haversine para distância e estimativa 50km/h para tempo"
    );
    distancesKm = haversineMatrixKm(points);
    durationsMinMatrix = distancesKm.map((row) =>
      row.map((d) => (d === Infinity ? Infinity : (d / 50) * 60))
    );
  }

  // ---- Agrupamento: remove loja se economia <= custo extra de deslocamento ----
  const costKm = vehicleCostPerKm(vehicle);
  const merged = mergeUneconomicalStores(
    shoppingListItemIds,
    priceMap,
    assignment,
    storeIds,
    distancesKm,
    costKm
  );
  if (merged.merged > 0) {
    safeLog(
      `[route-worker] agrupamento: ${merged.merged} loja(s) secundária(s) unificadas (economia <= desloc R$${costKm.toFixed(2)}/km)`
    );
  }
  const finalStoreIds = merged.storeIds;
  const finalAssign = merged.assignment;
  const finalEstabs = finalStoreIds
    .map((id) => orderedEstabs.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e);

  // Matriz compacta [Casa, ...lojas finais] para o TSP.
  const keepIdx = [
    0,
    ...finalStoreIds.map((s) => storeIds.indexOf(s) + 1),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const compactDist = keepIdx.map((i) => keepIdx.map((j) => distancesKm[i][j]));
  const compactDur = keepIdx.map((i) => keepIdx.map((j) => durationsMinMatrix[i][j]));

  const { order, distanceKm } = solveTsp(compactDist, 0, roundTrip);

  // Cesto global: cada item conta UMA vez (sem contagem dupla entre lojas).
  const { baskets, totalPurchaseCost } = buildBaskets(
    shoppingListItemIds,
    finalAssign,
    priceMap,
    itemName
  );

  // Tempo total: trechos + 15min de compra por parada + volta (se roundTrip).
  let travelTimeMin = 0;
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const seg = compactDur[a]?.[b];
    if (typeof seg === "number" && seg !== Infinity) travelTimeMin += seg;
  }
  if (roundTrip && order.length > 1) {
    const last = order[order.length - 1];
    const ret = compactDur[last]?.[0];
    if (typeof ret === "number" && ret !== Infinity) travelTimeMin += ret;
  }
  const stopCount = Math.max(0, order.length - 1);
  const totalTimeMin = Math.round(travelTimeMin + stopCount * SHOPPING_MIN_PER_STOP);

  // B4 — suggested departure: se startTime === "suggest", escolhe melhor hora.
  let departureAt: Date;
  if (startTime === "suggest") {
    const catsInOrder: (string | undefined)[] = [];
    for (let i = 1; i < order.length; i++) {
      catsInOrder.push(finalEstabs[order[i] - 1]?.category);
    }
    const best = suggestBestDepartureHour(catsInOrder, totalTimeMin);
    departureAt = new Date();
    departureAt.setHours(best.departureHour, 0, 0, 0);
    if (departureAt.getTime() < Date.now()) {
      departureAt.setDate(departureAt.getDate() + 1);
    }
    safeLog(
      `[route-worker] sugestão saída ${departureAt.toISOString()} (busyScore acumulado ${best.expectedTotalBusy})`
    );
  } else if (startTime && startTime !== "suggest") {
    departureAt = new Date(startTime);
  } else {
    departureAt = new Date();
  }

  // arrivalAt por parada + quietScore via Popular Times best-effort.
  const stops: RoutePlan["stops"] = [];
  let cursor = new Date(departureAt).getTime();
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1];
    const cur = order[i];
    const seg = compactDur[prev]?.[cur];
    const segMin = typeof seg === "number" && seg !== Infinity ? seg : 0;
    cursor += segMin * 60_000;
    const est = finalEstabs[cur - 1];
    if (!est) continue;
    const basket = baskets.get(est.id);
    const stopItems = basket?.items.map((b) => b.itemName) ?? [];
    const cost = basket?.cost ?? 0;
    let quietScore: number | undefined;
    try {
      const busy = await currentBusyScore({ name: est.name, category: est.category }, {});
      quietScore = Math.round(100 - busy.score);
    } catch {
      // best-effort
    }
    stops.push({
      establishmentId: est.id,
      stopOrder: i,
      estimatedCost: cost,
      items: stopItems,
      arrivalTimeEstimate: new Date(cursor).toISOString(),
      quietScore,
    });
    cursor += SHOPPING_MIN_PER_STOP * 60_000;
  }

  // Custo de deslocamento (combustível ou tarifa pública) — km do caminho completo.
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
    `[route-worker] rota ${route.id}: ${stops.length} paradas, ${route.totalDistanceKm}km, ${totalTimeMin}min, saída ${departureAt.toISOString()}, compra R$${totalPurchaseCost}, desloc R$${travel.cost || 0}, total R$${totalCost}, roundTrip=${roundTrip}`
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
    roundTrip,
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
