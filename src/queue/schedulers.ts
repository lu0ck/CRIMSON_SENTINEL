import { getScanQueue, getSocialQueue, QUEUE_NAMES } from "./queues";
import type { ScanJobPayload, SocialMonitorJobPayload } from "./types";

// Chave para o scheduler diário. Mantida constante para que BullMQ não duplique.
const REPEAT_DAILY_KEY = "scan-daily-cron";
const REPEAT_INTERVAL_KEY = "scan-interval-12h";
const SOCIAL_SCAN_KEY = "social-scan-cron";
const WHATSAPP_SCAN_KEY = "whatsapp-status-scan-cron";
const INSTAGRAM_SCAN_KEY = "instagram-stories-scan-cron";
const LOCAL_PRICE_SCAN_KEY = "local-price-scan-cron";

export async function registerSchedulers(opts?: {
  scanIntervalMs?: number;
  dailyHour?: number;
}): Promise<void> {
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — scan schedulers ignorados");
    return;
  }

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
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    return;
  }
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
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    return [];
  }
  const schedulers = await queue.getJobSchedulers();
  return schedulers.map((s) => ({
    // getJobSchedulers() expõe o campo `key`, não `id` (FASE 9)
    id: s.id ?? (s as any).key ?? null,
    name: s.name,
    pattern: s.pattern ?? null,
    every: s.every ?? null,
    next: s.next ?? null,
  }));
}

// ---------------------------------------------------------------------------
// FASE 9 — agendador do scan social (varredura recorrente das fontes).
// Usa um repeatable job do BullMQ, como o scan de e-commerce.
// ---------------------------------------------------------------------------

export async function registerSocialScheduler(opts?: {
  intervalMs?: number;
}): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — social scheduler ignorado");
    return;
  }
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000; // 6h

  // Social scan all
  await queue.upsertJobScheduler(
    SOCIAL_SCAN_KEY,
    { every: intervalMs },
    {
      name: "social-scan-all",
      data: { type: "social-scan-all", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  // WhatsApp status scan (a cada 6h)
  await queue.upsertJobScheduler(
    WHATSAPP_SCAN_KEY,
    { every: intervalMs },
    {
      name: "whatsapp-status-scan",
      data: { type: "whatsapp-status-scan", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  // Instagram stories scan (a cada 6h)
  await queue.upsertJobScheduler(
    INSTAGRAM_SCAN_KEY,
    { every: intervalMs },
    {
      name: "instagram-stories-scan",
      data: { type: "instagram-stories-scan", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  console.log(
    `[scheduler] scan social registrado: a cada ${Math.round(intervalMs / 60000)}min (social + whatsapp + instagram)`
  );
}

export async function unregisterSocialScheduler(): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    return;
  }
  for (const id of [SOCIAL_SCAN_KEY, WHATSAPP_SCAN_KEY, INSTAGRAM_SCAN_KEY]) {
    try {
      await queue.removeJobScheduler(id);
      console.log(`[scheduler] removido ${id}`);
    } catch {
      // já não existia
    }
  }
}

// ---------------------------------------------------------------------------
// FASE 12 — agendador do scan de preços locais (price_url dos estabelecimentos).
// Mesmo padrão do social: repeatable job na scan-queue (a fila do scanWorker que
// hospeda o handleLocalPriceScan), via upsert idempotente.
// ---------------------------------------------------------------------------

export async function registerLocalPriceScanScheduler(opts?: {
  intervalMs?: number;
}): Promise<void> {
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — local-price-scan scheduler ignorado");
    return;
  }
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000; // 6h

  await queue.upsertJobScheduler(
    LOCAL_PRICE_SCAN_KEY,
    { every: intervalMs },
    {
      name: "local-price-scan",
      data: { type: "local-price-scan" } as ScanJobPayload,
    }
  );

  console.log(
    `[scheduler] scan de preços locais registrado: a cada ${Math.round(intervalMs / 60000)}min`
  );
}

export async function unregisterLocalPriceScanScheduler(): Promise<void> {
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    return;
  }
  try {
    await queue.removeJobScheduler(LOCAL_PRICE_SCAN_KEY);
    console.log(`[scheduler] removido ${LOCAL_PRICE_SCAN_KEY}`);
  } catch {
    // já não existia
  }
}

export async function listSocialScheduledJob() {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    return [];
  }
  const schedulers = await queue.getJobSchedulers();
  return schedulers.map((s) => ({
    id: (s as any).key ?? null,
    name: s.name,
    pattern: s.pattern ?? null,
    every: s.every ?? null,
    next: s.next ?? null,
  }));
}
