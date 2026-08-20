import { Queue } from "bullmq";
import { getRedis } from "./connection";
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
  if (!scanQueue) {
    scanQueue = new Queue<ScanJobPayload>(QUEUE_NAMES.SCAN, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    console.log("[queue] scan-queue pronta");
  }
  return scanQueue;
}

export function getRouteQueue(): Queue<RouteJobPayload> {
  if (!routeQueue) {
    routeQueue = new Queue<RouteJobPayload>(QUEUE_NAMES.ROUTE, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    console.log("[queue] route-queue pronta");
  }
  return routeQueue;
}

export function getSocialQueue(): Queue<SocialMonitorJobPayload> {
  if (!socialQueue) {
    socialQueue = new Queue<SocialMonitorJobPayload>(QUEUE_NAMES.SOCIAL, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    console.log("[queue] social-monitor-queue pronta");
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
