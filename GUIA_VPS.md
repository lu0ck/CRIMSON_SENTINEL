# Guia VPS — SENTINELA (FASE 16 / #31)

Runbook para subir e validar a stack completa **headless** em VPS (sem Electron).  
Decisões e evidências no [`DIAGNOSTICO.md`](DIAGNOSTICO.md) §6.16.

---

## 1. Arquitetura alvo

| Componente | PM2 / processo | Porta |
|---|---|---|
| API Express (UI + REST) | `sentinela-api` | **3001** |
| Scan worker (cluster) | `sentinela-scan-worker` × **4** | — |
| Route worker | `sentinela-route-worker` | — |
| Social worker | `sentinela-social-worker` | — |
| Instagram (Python FastAPI) | `sentinela-instagram-service` | **8721** (127.0.0.1) |
| Redis | Docker `crimson-redis` ou nativo | **6379** (127.0.0.1) |

**8 processos** no total (1 + 4 + 1 + 1 + 1).

| Dado | Caminho |
|---|---|
| SQLite | `$USER_DATA_PATH/crimson.db` → default `~/.config/crimson-sentinel/crimson.db` |
| Redis AOF | volume Docker `redis-data` |
| Credenciais IG | `python_instagram/.ig.env` (0600, gitignored) |
| Sessão WhatsApp | `.wwebjs_auth/` |
| Sessão IG (instagrapi) | `python_instagram/session.json` |
| Env da app | `.env` (gitignored) |

Não há Electron na VPS — só Node/PM2 + Redis + venv opcional do Instagram.

---

## 2. Bootstrap (Ubuntu/Debian)

```bash
# 2.1 Sistema
sudo apt-get update
sudo apt-get install -y curl git build-essential python3 python3-venv docker.io
sudo systemctl enable --now docker

# 2.2 Node ≥ 18 (ex.: NodeSource 22 LTS) + pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2

# 2.3 Código
git clone https://github.com/lu0ck/CRIMSON_SENTINEL.git
cd CRIMSON_SENTINEL
git checkout rebuild-v2
npm ci
# better-sqlite3 é nativo — se falhar após upgrade de Node:
npm rebuild better-sqlite3

# 2.4 Playwright (scraper)
npx playwright install chromium
# em VPS minimal, deps do Chromium:
npx playwright install-deps chromium || true

# 2.5 Redis
docker compose up -d
docker compose ps          # crimson-redis → healthy
redis-cli ping             # PONG

# 2.6 Ambiente
cp .env.example .env
# edite .env — ver seção 3

# 2.7 Instagram (opcional, só se for usar C3)
bash scripts/setup-instagram.sh
```

**Arch/CachyOS local:** ver [`INSTRUCOES_LOCAL.md`](INSTRUCOES_LOCAL.md) (`pacman`).

---

## 3. Variáveis de ambiente no VPS

| Variável | Obrigatória? | Nota |
|---|---|---|
| `GEMINI_API_KEY` | Recomendada | Insights + Vision; pode vir do **perfil UI** (override) |
| `SERPER_API_KEY` / `TAVILY_API_KEY` | Opcional | Busca/compare |
| `DISCORD_WEBHOOK_URL` / `TELEGRAM_*` / `GMAIL_*` | Opcional | Notificações |
| `REDIS_URL` | Default ok | `redis://127.0.0.1:6379` |
| `PORT` | Default | **3001** (3000 é de outro serviço) |
| `BIND_HOST` | Default | **127.0.0.1** — ver §5 |
| `NODE_ENV` | `development` ou `production` | ecosystem fixa `development` (tsx); production serve `dist/` |
| `SOCIAL_MONITORING_ENABLED` | `false` default | Toggles WhatsApp/IG ficam na **UI** |
| `INSTAGRAM_SERVICE_PORT` | 8721 | Só se C3 ativo |
| `USER_DATA_PATH` | Definido no ecosystem | `~/.config/crimson-sentinel` — **não** unset (split-brain de DB) |

Credenciais Instagram: salve no painel SOCIAL → API grava `python_instagram/.ig.env` (não no `.env` da app).

Precedência de chaves de IA: **perfil (UI) > .env**.

---

## 4. Subir / parar / atualizar

```bash
# Subir tudo (5 apps · 8 processos)
npm run pm2:start
# ou: npx pm2 start ecosystem.config.cjs

npx pm2 ls
# esperado: 8 online (scan-worker 4/4 cluster)

# Logs
npm run pm2:logs
# ou: npx pm2 logs sentinela-api

# Persistir após reboot da VPS
npx pm2 startup          # cole o comando que ele imprimir (systemd)
npx pm2 save

# Atualizar deploy
git pull
npm ci
npx playwright install chromium
npx pm2 restart sentinela-api
npx pm2 restart sentinela-scan-worker
npx pm2 restart sentinela-route-worker
npx pm2 restart sentinela-social-worker
# Instagram (se venv mudou):
npx pm2 restart sentinela-instagram-service

# Parar tudo
npm run pm2:stop
```

### Produção vs development

Hoje `ecosystem.config.cjs` roda API via `npm run dev` (`tsx server.ts`) com `NODE_ENV=development`. Para servir o bundle estático buildado:

```bash
npm run build            # gera dist/
# ajustar env do app sentinela-api para NODE_ENV=production
# (só depois de validar; server.ts passa a servir dist/ quando production)
npx pm2 restart sentinela-api
```

Não altere o ecosystem em produção sem testar — workers usam `scripts/scan-worker-cluster.mjs` (bootstrap tsx).

---

## 5. Exposição e segurança

| Cenário | Como | Risco |
|---|---|---|
| **Recomendado** | `BIND_HOST=127.0.0.1` (default) + **SSH tunnel** | Painel só na VPS |
| LAN | `BIND_HOST=0.0.0.0` + Host allowlist alinhado | Ver server.ts (FASE 13) |
| Público | Proxy reverso (Caddy/nginx) TLS + auth | **`/api/data` expõe segredos em claro** — não exponha sem camada de auth |

```bash
# Acesso remoto seguro sem abrir porta:
ssh -L 3001:127.0.0.1:3001 usuario@vps
# depois: http://127.0.0.1:3001 no navegador local
```

Checks de Host (FASE 13): Host não allowlisted → **403**. Faça health checks **na própria VPS** (loopback) ou via túnel.

WhatsApp QR: gere no painel SOCIAL **uma vez**, escaneie pelo celular; sessão persiste em `.wwebjs_auth/`.

---

## 6. Health checks (checklist rápido)

Rodar **na VPS**:

```bash
# 1. Redis
docker compose ps && redis-cli ping          # healthy + PONG

# 2. Typecheck (opcional no deploy)
npm run lint                                  # tsc → 0

# 3. 8 processos
npx pm2 jlist | python3 -c '
import json,sys
apps=json.load(sys.stdin)
online=[a for a in apps if a.get("pm2_env",{}).get("status")=="online"]
print("online", len(online))
print("scan", sum(1 for a in online if a["name"]=="sentinela-scan-worker"))
'
# esperado: online 8 · scan 4

# 4. API + Redis + schedulers
curl -s http://127.0.0.1:3001/api/status
# → redis.connected=true; nextScanMinutes / nextSocialScanMinutes / nextLocalPriceScanMinutes

curl -s http://127.0.0.1:3001/api/scan/settings
curl -s http://127.0.0.1:3001/api/social/settings
curl -s http://127.0.0.1:3001/api/local-price-scan/settings
# → scheduler ids: scan-interval-12h, scan-daily-cron, social-scan-cron, local-price-scan-cron

# 5. Instagram service
npx pm2 status sentinela-instagram-service   # online (ou stopped se toggle off = ok)
curl -s http://127.0.0.1:8721/health         # {"status":"ok",...} se venv+toggle on
curl -s http://127.0.0.1:3001/api/social/instagram/health
# toggle off → {"enabled":false} é válido

# 6. UI
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/
# 200
```

---

## 7. Checklist E2E ponta a ponta

### Tier A — sem segredos (infra + filas)

| # | Passo | Esperado |
|---|---|---|
| A1 | Redis | `PONG` + compose healthy |
| A2 | `npm run lint` | exit 0 |
| A3 | `npm run pm2:start` | **8** online, scan 4/4 |
| A4 | `GET /api/status` | 200, `redis.connected=true`, 3 contadores de scheduler |
| A5 | Settings endpoints | 4 cron ids listados |
| A6 | IG `/health` (127.0.0.1:8721) | `ok` se toggle on; API proxy `{enabled:false}` se off |
| A7 | `POST /api/social/capture` (texto promo) | grava; re-POST → dedup (`saved:0`) |
| A8 | `bash scripts/stress-cluster-20.sh` | **APROVADO** em `RELATORIO_TESTE_CLUSTER.md` |
| A9 | Opcional: `DURATION_MINUTES=10 bash scripts/stress-test-24h.sh` | uptime 100% nas amostras |

Exemplo A7:

```bash
curl -s -X POST http://127.0.0.1:3001/api/social/capture \
  -H 'Content-Type: application/json' \
  -d '{"channel":"whatsapp","text":"OFERTA Café 500g de R$24,90 por R$17,90 no Atacadão"}'
```

### Tier B — rede pública, sem chaves de API

| # | Passo | Esperado |
|---|---|---|
| B1 | Fake market: servidor local 127.0.0.1:5678 servindo `R$ 12,34` + estabelecimento com `price_url` | — |
| B2 | `POST /api/local-price-scan` | job → `recorded: 2` |
| B3 | Repetir scan | `duplicates: 2` (dedup) |
| B4 | `GET /api/price-history` | série local com pontos |
| B5 | `POST /api/location` + `POST /api/establishments/discover` | job Overpass (sem key) |
| B6 | `POST /api/route` com itens + Casa | rota OSRM/haversine |

Evidência local do caminho fake-market: DIAGNOSTICO §6.11.1 (recorded 2 → dup 2 → history).

### Tier C — precisa de segredos / contas

| # | Passo | Esperado |
|---|---|---|
| C1 | Insights com chave no perfil (#29) | job → `method: "gemini"` (badge GEMINI na UI) |
| C2 | Scrape de 1 link da vitrine 8/8 | job → name + price + imageUrl |
| C3 | Notificações (Discord/Telegram/Gmail) | entrada em notifications; 2ª em cooldown não incrementa |
| C4 | Instagram login + scan | painel → `.ig.env` + startOrReload; `sessionLoaded:true` |
| C5 | WhatsApp QR (uma vez) | status `{enabled, ready:true}` |

---

## 8. Carga na VPS

```bash
# Cluster (mesmo critério do #30 local — APROVADO)
bash scripts/stress-cluster-20.sh
# com retries longos:
N_JOBS=20 TIMEOUT_S=600 bash scripts/stress-cluster-20.sh

# Soak curto
DURATION_MINUTES=10 bash scripts/stress-test-24h.sh
```

Critérios APROVADO (stress-cluster-20): 4 workers · jobs nossos 20/20 · `stalled_hits=0` · API 200 em todas as amostras markadas.

Baseline local de referência: [`RELATORIO_TESTE_CLUSTER.md`](RELATORIO_TESTE_CLUSTER.md) (2026-09-23, APROVADO).  
Na VPS, o script sobrescreve esse arquivo — **copie o relatório da VPS** para o repo se quiser arquivar.

---

## 9. Backup / rollback

| Artefato | Como copiar |
|---|---|
| `~/.config/crimson-sentinel/crimson.db` | `scp` / `sqlite3 .backup` com stack parada ou online (WAL) |
| Volume Redis | `docker run --rm -v crimson_sentinel_redis-data:/d -v $PWD:/o alpine tar czf /o/redis-backup.tgz -C /d .` |
| `.env`, `python_instagram/.ig.env` | nunca para git; backup cifrado |
| `.wwebjs_auth/`, `python_instagram/session.json` | sessões — regeneráveis (QR/login) |

Rollback de deploy: `git checkout <tag/commit anterior>` + `npm ci` + `npx pm2 restart all`.

---

## 10. Troubleshooting

| Sintoma | Ação |
|---|---|
| Jobs não rodam | Redis down? `docker compose ps` · `npx pm2 logs sentinela-scan-worker` |
| `WRONGTYPE` em métricas Redis | Só scripts antigos; atualizado em #30 (`ZCARD` p/ completed/failed) |
| Playwright não acha browser | `npx playwright install chromium` |
| `better-sqlite3` não carrega | `npm rebuild better-sqlite3` (ABI do Node) |
| 403 na API de fora | Host allowlist / `BIND_HOST=127.0.0.1` — use túnel |
| IG em erro | `bash scripts/setup-instagram.sh` · toggle off/on no painel · `npx pm2 logs sentinela-instagram-service` |
| Porta 3000 ocupada | SENTINELA usa **3001** |
| Split-brain de DB | Não remova `USER_DATA_PATH` do ecosystem |
| PM2 não está no PATH | `npx pm2 ...` (scripts stress já fazem fallback) |

Mais: [`INSTRUCOES_LOCAL.md`](INSTRUCOES_LOCAL.md) · [`GUIA_SOCIAL.md`](GUIA_SOCIAL.md) · [`DIAGNOSTICO.md`](DIAGNOSTICO.md).

---

*[GUIA VPS — SENTINELA]*
