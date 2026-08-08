import IORedis, { type Redis } from "ioredis";

const REDIS_URL =
  process.env.REDIS_URL ||
  `redis://${process.env.REDIS_HOST || "127.0.0.1"}:${process.env.REDIS_PORT || "6379"}`;

let connection: Redis | null = null;

export function getRedis(): Redis {
  if (connection) return connection;

  connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ exige null
    enableReadyCheck: false,
  });

  connection.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });
  connection.on("connect", () => {
    console.log("[redis] conectado:", REDIS_URL);
  });

  return connection;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
    console.log("[redis] desconectado");
  }
}
