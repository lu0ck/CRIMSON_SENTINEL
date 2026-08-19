// PM2 Ecosystem — FASE 2 + A3
// Processos separados para isolamento de falhas:
//  - api: servidor Express (entrada única do usuário)
//  - scan-worker: scraping, scan-all, compare, local-insight, analyze (A2), local-price-scan
//      A3: 4 instâncias em cluster × concurrency 5 = até 20 jobs simultâneos
//  - route-worker: roteirização (TSP/OSRM, FASE 7)
//  - social-worker: monitoramento WhatsApp/Instagram (FASE 9/10)
module.exports = {
  apps: [
    {
      name: "crimson-api",
      script: "npm run dev",
      interpreter: "none",
      env: {
        NODE_ENV: "development",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "crimson-scan-worker",
      script: "./node_modules/.bin/tsx",
      args: "src/workers/scanWorkerEntry.ts",
      // A3: 4 instâncias em cluster; cada worker tem concurrency 5 → 20 jobs em paralelo
      // sem OOM (Playwright distribuído em 4 processos, não 1 com 20 browsers).
      instances: 4,
      exec_mode: "cluster",
      env: {
        NODE_ENV: "development",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "crimson-route-worker",
      script: "./node_modules/.bin/tsx",
      args: "src/workers/routeWorkerEntry.ts",
      env: {
        NODE_ENV: "development",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "crimson-social-worker",
      script: "./node_modules/.bin/tsx",
      args: "src/workers/socialWorkerEntry.ts",
      env: {
        NODE_ENV: "development",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      // C3 — microserviço Python instagrapi. Só relevante se INSTAGRAM_ENABLED=true.
      // Sobe automaticamente; se usuário não usar Instagram, processo roda idle
      // (consome poucos recursos). Desativar via `pm2 stop crimson-instagram-service`.
      name: "crimson-instagram-service",
      script: "python_instagram/.venv/bin/uvicorn",
      args: "python_instagram.server:app --host 127.0.0.1 --port 8721",
      interpreter: "none",
      env: {
        INSTAGRAM_SERVICE_PORT: "8721",
      },
      max_restarts: 5,
      min_uptime: "10s",
      restart_delay: 5000,
      time: true,
    },
  ],
};
