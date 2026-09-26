import { getScanQueue, getSocialQueue, QUEUE_NAMES } from "./queues";
import type { ScanJobPayload, SocialMonitorJobPayload } from "./types";
import { SettingsRepository } from "../repositories/settingsRepository";

// Chave para o scheduler diário. Mantida constante para que BullMQ não duplique.
const REPEAT_DAILY_KEY = "scan-daily-cron";
// Nome legado ("12h") — #60: scheduler de intervalo REMOVIDO (todo dia 1× só).
const REPEAT_INTERVAL_KEY = "scan-interval-12h";
const SOCIAL_SCAN_KEY = "social-scan-cron";
const INSTAGRAM_SCAN_KEY = "instagram-stories-scan-cron";
const LOCAL_PRICE_SCAN_KEY = "local-price-scan-cron";
const TRIGGER_EVALUATE_KEY = "trigger-evaluate-cron";

// #60 — horário ÚNICO diário p/ todas as frentes (e-commerce + mercado +
// social/instagram): usuário escolhe "HH:MM" e o sistema roda 1× por dia.
const DAILY_TIME_KEY = "scan_daily_time";
const DAILY_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidDailyTime(v: string): boolean {
  return DAILY_TIME_RE.test(v);
}

export function getScanDailyTime(): string {
  const raw = SettingsRepository.get(DAILY_TIME_KEY);
  if (raw && DAILY_TIME_RE.test(raw)) return raw;
  // migração do legado scan_daily_hour (0-23 — nunca teve UI de hora cheia)
  const legacyHour = SettingsRepository.getNumber("scan_daily_hour");
  return `${String(legacyHour ?? 15).padStart(2, "0")}:00`;
}

/** "HH:MM" → cron `MM HH * * *`. dailyTime validada antes de chegar aqui. */
function dailyCronPattern(dailyTime: string): string {
  const m = dailyTime.match(DAILY_TIME_RE);
  if (!m) throw new Error(`dailyTime inválida: ${dailyTime}`);
  return `${m[2]} ${Number(m[1])} * * *`;
}

// #60 (#25 original) — registra TODOS os schedulers a partir de user_settings.
// Idempotente (upsertJobScheduler); seguro no boot, após backup import
// e após mudança do horário em runtime.
export async function registerAllSchedulers(): Promise<void> {
  const dailyTime = getScanDailyTime();
  await registerSchedulers({ dailyTime });
  await registerSocialScheduler({ dailyTime });
  await registerLocalPriceScanScheduler({ dailyTime });
  await registerTriggerEvaluateScheduler();
}

export async function registerSchedulers(opts?: {
  dailyTime?: string;
}): Promise<void> {
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — scan schedulers ignorados");
    return;
  }

  const dailyTime = opts?.dailyTime ?? getScanDailyTime();

  // 1. Daily scan no horário escolhido (1× por dia).
  //    Upsert = idempotente: não duplica se já existir.
  await queue.upsertJobScheduler(
    REPEAT_DAILY_KEY,
    { pattern: dailyCronPattern(dailyTime) },
    {
      name: "scan-all",
      data: { type: "scan-all", triggeredBy: "cron-daily" } as ScanJobPayload,
    }
  );

  // 2. #60 — limpa o scheduler legado de intervalo (every: scan_interval_ms).
  try {
    await queue.removeJobScheduler(REPEAT_INTERVAL_KEY);
  } catch {
    // já não existia
  }

  console.log(`[scheduler] e-commerce: diário às ${dailyTime} (intervalo removido)`);
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
  dailyTime?: string;
}): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — social scheduler ignorado");
    return;
  }
  // #60 — social + instagram no MESMO horário único diário das demais frentes.
  const dailyTime = opts?.dailyTime ?? getScanDailyTime();
  const pattern = dailyCronPattern(dailyTime);

  // Social scan all
  await queue.upsertJobScheduler(
    SOCIAL_SCAN_KEY,
    { pattern },
    {
      name: "social-scan-all",
      data: { type: "social-scan-all", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  // Instagram stories scan (mesmo horário do social scan)
  await queue.upsertJobScheduler(
    INSTAGRAM_SCAN_KEY,
    { pattern },
    {
      name: "instagram-stories-scan",
      data: { type: "instagram-stories-scan", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  console.log(`[scheduler] scan social: diário às ${dailyTime} (social + instagram)`);
}

export async function unregisterSocialScheduler(): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    return;
  }
  for (const id of [SOCIAL_SCAN_KEY, INSTAGRAM_SCAN_KEY]) {
    try {
      await queue.removeJobScheduler(id);
      console.log(`[scheduler] removido ${id}`);
    } catch {
      // já não existia
    }
  }
}

// ---------------------------------------------------------------------------
// FRENTE 4 — agendador de avaliação de triggers (a cada 1h)
// ---------------------------------------------------------------------------

export async function registerTriggerEvaluateScheduler(): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — trigger-evaluate scheduler ignorado");
    return;
  }

  await queue.upsertJobScheduler(
    TRIGGER_EVALUATE_KEY,
    { every: 60 * 60 * 1000 }, // 1h
    {
      name: "trigger-evaluate",
      data: { type: "trigger-evaluate", triggeredBy: "cron" } as SocialMonitorJobPayload,
    }
  );

  console.log("[scheduler] trigger-evaluate registrado: a cada 60min");
}

export async function unregisterTriggerEvaluateScheduler(): Promise<void> {
  let queue;
  try {
    queue = getSocialQueue();
  } catch {
    return;
  }
  try {
    await queue.removeJobScheduler(TRIGGER_EVALUATE_KEY);
    console.log(`[scheduler] removido ${TRIGGER_EVALUATE_KEY}`);
  } catch {
    // já não existia
  }
}

// ---------------------------------------------------------------------------
// FASE 12 — agendador do scan de preços locais (price_url dos estabelecimentos).
// Mesmo padrão do social: repeatable job na scan-queue (a fila do scanWorker que
// hospeda o handleLocalPriceScan), via upsert idempotente.
// ---------------------------------------------------------------------------

export async function registerLocalPriceScanScheduler(opts?: {
  dailyTime?: string;
}): Promise<void> {
  let queue;
  try {
    queue = getScanQueue();
  } catch {
    console.warn("[scheduler] Redis indisponível — local-price-scan scheduler ignorado");
    return;
  }
  // #60 — mercado no horário único diário (antes: a cada X horas).
  const dailyTime = opts?.dailyTime ?? getScanDailyTime();

  await queue.upsertJobScheduler(
    LOCAL_PRICE_SCAN_KEY,
    { pattern: dailyCronPattern(dailyTime) },
    {
      name: "local-price-scan",
      data: { type: "local-price-scan" } as ScanJobPayload,
    }
  );

  console.log(`[scheduler] scan de preços locais: diário às ${dailyTime}`);
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
