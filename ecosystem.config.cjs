// PM2 Ecosystem — SENTINELA
// Processos separados para isolamento de falhas:
//  - api: servidor Express (entrada única do usuário)
//  - scan-worker: scraping, scan-all, compare, local-insight, analyze (A2), local-price-scan
//      4 instâncias em cluster × concurrency 5 = até 20 jobs simultâneos
//  - route-worker: roteirização (TSP/OSRM)
//  - social-worker: monitoramento Instagram
//  - instagram-service: microserviço Python instagrapi (#28 — DONO ÚNICO PM2;
//      server.ts não faz mais spawn em :8721; credenciais via python_instagram/.ig.env)

const path = require("path");
const os = require("os");
const fs = require("fs");

// Banco único entre Electron e stack pm2: o Electron usa app.getPath('userData')
// (= ~/.config/crimson-sentinel), onde vivem os dados reais do usuário. Sem esta
// variável, db.ts cai no __dirname do projeto e cria um segundo banco vazio
// (split-brain: scans automáticos não enxergam os produtos).
const USER_DATA_PATH = path.join(os.homedir(), ".config", "crimson-sentinel");

// #28 — credenciais Instagram gravadas pelo API (SettingsRepository → .ig.env)
// em vez de env do spawn. Gitignored; chmod 600.
function loadInstagramEnv() {
  try {
    const file = path.join(__dirname, "python_instagram", ".ig.env");
    const out = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  apps: [
    {
      name: "sentinela-api",
      script: "npm run dev",
      interpreter: "none",
      env: {
        NODE_ENV: "development",
        USER_DATA_PATH,
        // Porta dedicada — a 3000 é usada por outro serviço (afiliados-bot)
        PORT: "3001",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "sentinela-scan-worker",
      // Cluster mode exige script JS carregável direto pelo node (pm2 rejeita
      // .ts sem Node>=22.18). Bootstrap registra o hook tsx e importa o worker,
      // preservando IPC do cluster (.bin/tsx = shell wrapper; cli.mjs spawn de
      // filho quebra IPC).
      script: "scripts/scan-worker-cluster.mjs",
      // A3: 4 instâncias em cluster; cada worker tem concurrency 5 → 20 jobs em paralelo
      // sem OOM (Playwright distribuído em 4 processos, não 1 com 20 browsers).
      instances: 4,
      exec_mode: "cluster",
      env: {
        NODE_ENV: "development",
        USER_DATA_PATH,
        LM_STUDIO_API_KEY: "RGroFhc4b2ESmq87Yrf469iOkW-T2DvQW4a1iYvOEIc",
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "sentinela-route-worker",
      script: "./node_modules/.bin/tsx",
      args: "src/workers/routeWorkerEntry.ts",
      env: {
        NODE_ENV: "development",
        USER_DATA_PATH,
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      name: "sentinela-social-worker",
      script: "./node_modules/.bin/tsx",
      args: "src/workers/socialWorkerEntry.ts",
      env: {
        NODE_ENV: "development",
        USER_DATA_PATH,
      },
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 3000,
      time: true,
    },
    {
      // C3 — microserviço Python instagrapi. DONO ÚNICO: PM2 (#28).
      // server.ts apenas pm2 startOrReload/stop (não faz spawn em :8721).
      // Toggle da UI (user_settings.instagram_enabled) → start/stop deste app.
      // Credenciais: python_instagram/.ig.env (gravado ao salvar no painel).
      // Se venv ausente, rode: bash scripts/setup-instagram.sh
      name: "sentinela-instagram-service",
      script: "python_instagram/.venv/bin/uvicorn",
      args: "python_instagram.server:app --host 127.0.0.1 --port 8721",
      interpreter: "none",
      env: {
        INSTAGRAM_SERVICE_PORT: "8721",
        ...loadInstagramEnv(),
      },
      max_restarts: 5,
      min_uptime: "10s",
      restart_delay: 5000,
      time: true,
    },
  ],
};
