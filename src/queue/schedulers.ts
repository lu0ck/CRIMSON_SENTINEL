import { getScanQueue, QUEUE_NAMES } from "./queues";
import type { ScanJobPayload } from "./types";

// Chave para o scheduler diário. Mantida constante para que BullMQ não duplique.
const REPEAT_DAILY_KEY = "scan-daily-cron";
const REPEAT_INTERVAL_KEY = "scan-interval-12h";

export async function registerSchedulers(opts?: {
  scanIntervalMs?: number;
  dailyHour?: number;
}): Promise<void> {
  const queue = getScanQueue();

  const intervalMs = opts?.scanIntervalMs ?? 12 * 60 * 60 * 1000; // 12h
  const hour = opts?.dailyHour ?? 15;

  // 1. Daily scan — substitui o `setTimeout` recursivo antigo (server.ts:815).
  //    Upsert = idempotente: não duplica se já existir.
  await queue.upsertJobScheduler(
    REPEAT_DAILY_KEY,
    { pattern: `0 ${hour} * * *` },
    {
      name: "scan-all",
      data: { type: "scan-all", triggeredBy: "cron-daily" } as ScanJobPayload,
    }
  );

  // 2. Interval 12h backup — substitui o `setInterval(SCAN_INTERVAL)` antigo (server.ts:826).
  await queue.upsertJobScheduler(
    REPEAT_INTERVAL_KEY,
    { every: intervalMs },
    {
      name: "scan-all",
      data: { type: "scan-all", triggeredBy: "cron-interval" } as ScanJobPayload,
    }
  );

  console.log(
    `[scheduler] schedulers registrados: daily=${hour}:00, interval=${Math.round(intervalMs / 60000)}min`
  );
}

export async function unregisterSchedulers(): Promise<void> {
  const queue = getScanQueue();
  for (const id of [REPEAT_DAILY_KEY, REPEAT_INTERVAL_KEY]) {
    try {
      await queue.removeJobScheduler(id);
      console.log(`[scheduler] removido ${id}`);
    } catch {
      // já não existia
    }
  }
}

// Utilitário para listar status (usado por /api/status e debug)
export async function listScheduledJobs() {
  const queue = getScanQueue();
  const schedulers = await queue.getJobSchedulers();
  return schedulers.map((s) => ({
    id: s.id ?? null,
    name: s.name,
    pattern: s.pattern ?? null,
    every: s.every ?? null,
    next: s.next ?? null,
  }));
}
