import { Queue } from "bullmq";
import { getRedis, isRedisAvailable } from "./connection";
import type {
  ScanJobPayload,
  RouteJobPayload,
  SocialMonitorJobPayload,
} from "./types";

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 86_400, count: 1000 }, // 24h ou últimos 1000
  removeOnFail: { age: 7 * 86_400 }, // 7d para debug
};

export const QUEUE_NAMES = {
  SCAN: "scan-queue",
  ROUTE: "route-queue",
  SOCIAL: "social-monitor-queue",
} as const;

let scanQueue: Queue<ScanJobPayload> | null = null;
let routeQueue: Queue<RouteJobPayload> | null = null;
let socialQueue: Queue<SocialMonitorJobPayload> | null = null;

export function getScanQueue(): Queue<ScanJobPayload> {
  if (!isRedisAvailable()) throw new Error("Redis indisponível — filas desabilitadas");
  if (!scanQueue) {
    try {
      scanQueue = new Queue<ScanJobPayload>(QUEUE_NAMES.SCAN, {
        connection: getRedis(),
        defaultJobOptions: DEFAULT_JOB_OPTS,
      });
      console.log("[queue] scan-queue pronta");
    } catch (err: any) {
      throw new Error("Redis indisponível — filas desabilitadas. Inicie Redis para usar scan agendado.");
    }
  }
  return scanQueue;
}

export function getRouteQueue(): Queue<RouteJobPayload> {
  if (!isRedisAvailable()) throw new Error("Redis indisponível — filas desabilitadas");
  if (!routeQueue) {
    try {
      routeQueue = new Queue<RouteJobPayload>(QUEUE_NAMES.ROUTE, {
        connection: getRedis(),
        defaultJobOptions: DEFAULT_JOB_OPTS,
      });
      console.log("[queue] route-queue pronta");
    } catch (err: any) {
      throw new Error("Redis indisponível — filas desabilitadas. Inicie Redis para usar scan agendado.");
    }
  }
  return routeQueue;
}

export function getSocialQueue(): Queue<SocialMonitorJobPayload> {
  if (!isRedisAvailable()) throw new Error("Redis indisponível — filas desabilitadas");
  if (!socialQueue) {
    try {
      socialQueue = new Queue<SocialMonitorJobPayload>(QUEUE_NAMES.SOCIAL, {
        connection: getRedis(),
        defaultJobOptions: DEFAULT_JOB_OPTS,
      });
      console.log("[queue] social-monitor-queue pronta");
    } catch (err: any) {
      throw new Error("Redis indisponível — filas desabilitadas. Inicie Redis para usar scan agendado.");
    }
  }
  return socialQueue;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all([
    scanQueue?.close(),
    routeQueue?.close(),
    socialQueue?.close(),
  ]);
  scanQueue = null;
  routeQueue = null;
  socialQueue = null;
}
