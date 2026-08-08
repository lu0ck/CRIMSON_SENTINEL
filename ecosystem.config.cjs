// PM2 Ecosystem — FASE 2
// Processos separados para isolamento de falhas:
//  - api: servidor Express (entrada única do usuário)
//  - scan-worker: scraping, scan-all, compare
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
  ],
};
