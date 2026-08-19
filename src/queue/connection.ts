import IORedis, { type Redis } from "ioredis";

const REDIS_URL =
  process.env.REDIS_URL ||
  `redis://${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || "6379"}`;

let connection: Redis | null = null;
let redisAvailable = false;
let loggedUnavailable = false;
let errorLogCount = 0;

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export function getRedis(): Redis {
  if (connection) return connection;

  connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ exige null
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 5) {
        if (!loggedUnavailable) {
          console.error("[redis] Redis indisponível — filas desabilitadas. Inicie Redis para usar scan agendado.");
          loggedUnavailable = true;
        }
        redisAvailable = false;
        return null;
      }
      return Math.min(times * 100, 2000);
    },
  });

  connection.on("error", () => {
    errorLogCount++;
    if (errorLogCount <= 5) {
      console.error("[redis]连接失败 — tentativa", errorLogCount, "/ 5");
    }
  });
  connection.on("connect", () => {
    redisAvailable = true;
    loggedUnavailable = false;
    errorLogCount = 0;
    console.log("[redis] conectado:", REDIS_URL);
  });

  return connection;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
    redisAvailable = false;
    console.log("[redis] desconectado");
  }
}
