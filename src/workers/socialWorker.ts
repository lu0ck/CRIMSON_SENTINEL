import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { SocialMonitorJobPayload } from "../queue/types";
import { safeLog } from "../lib/safeLog";
import { SettingsRepository } from "../repositories/settingsRepository";

// Worker desativado por padrão (flag social_monitoring_enabled=false em user_settings).
// O corpo dos handlers (WhatsApp, Instagram) virá nas FASES 9 e 10.
async function handleSocialMonitor(job: Job<SocialMonitorJobPayload & { type: "social-monitor" }>) {
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    safeLog(`[social-worker] desabilitado em user_settings, pulando job ${job.id}`);
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }
  safeLog(`[social-worker] canais=${job.data.channels.join(",")} — FASE 9/10 implementará`);
  return { processed: job.data.channels };
}

export function startSocialWorker() {
  const worker = new Worker<SocialMonitorJobPayload>(
    QUEUE_NAMES.SOCIAL,
    async (job) => {
      safeLog(`[social-worker] job ${job.id}`);
      return handleSocialMonitor(job as Job<SocialMonitorJobPayload & { type: "social-monitor" }>);
    },
    { connection: getRedis(), concurrency: 1 }
  );

  worker.on("completed", (job) => safeLog(`[social-worker] ${job.id} ok`));
  worker.on("failed", (job, err) => safeLog(`[social-worker] ${job?.id} falhou: ${err.message}`));
  console.log("[social-worker] rodando, escutando " + QUEUE_NAMES.SOCIAL);
  return worker;
}
