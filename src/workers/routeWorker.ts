import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { RouteJobPayload } from "../queue/types";
import { safeLog } from "../lib/safeLog";

// Stub funcional — a lógica de roteirização completa (TSP + OSRM)
// será implementada na FASE 7. Aqui já validamos o pipeline.
async function handleRoute(job: Job<RouteJobPayload & { type: "route" }>) {
  const { shoppingListItemIds, startLat, startLng } = job.data;
  safeLog(`[route-worker] planejando rota com ${shoppingListItemIds.length} itens a partir de (${startLat},${startLng})`);
  return {
    plannedAt: new Date().toISOString(),
    itemCount: shoppingListItemIds.length,
    note: "FASE 7 implementará TSP/OSRM",
  };
}

export function startRouteWorker() {
  const worker = new Worker<RouteJobPayload>(
    QUEUE_NAMES.ROUTE,
    async (job) => {
      safeLog(`[route-worker] job ${job.id}`);
      return handleRoute(job as Job<RouteJobPayload & { type: "route" }>);
    },
    { connection: getRedis(), concurrency: 1 }
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
