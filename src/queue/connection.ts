import IORedis, { type Redis } from "ioredis";

const REDIS_URL =
  process.env.REDIS_URL ||
  `redis://${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || "6379"}`;

let connection: Redis | null = null;
let redisAvailable = false;
let loggedUnavailable = false;

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
        return null; // para de reconectar definitivamente
      }
      return Math.min(times * 100, 2000);
    },
  });

  // Silencia erros ECONNREFUSED após desistir de reconectar
  // (erros vêm do TCP layer do Node.js, não só do ioredis)
  let suppressErrors = false;
  connection.on("error", (err: any) => {
    if (suppressErrors) return;
    if (err?.code === "ECONNREFUSED" && !redisAvailable) {
      suppressErrors = true; // silencia todos os erros futuros deste tipo
      console.error("[redis] ECONNREFUSED — Redis indisponível. Erros de conexão silenciados.");
      return;
    }
    if (redisAvailable) {
      console.error("[redis] conexão perdida");
    }
  });
  connection.on("connect", () => {
    redisAvailable = true;
    loggedUnavailable = false;
    console.log("[redis] conectado:", REDIS_URL);
  });

  return connection;
}

// Eagerly start connecting on module load to avoid race condition with isRedisAvailable()
getRedis();

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
    redisAvailable = false;
    console.log("[redis] desconectado");
  }
}
