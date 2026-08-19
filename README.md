# 🛡️ Crimson Sentinel — Iron Man HUD Price Tracker

**Crimson Sentinel** é um rastreador de preços inspirado no HUD do Homem de Ferro. Ele monitora produtos online e lojas físicas locais, roteiriza compras, detecta promoções-relâmpago e notifica via Discord/Telegram — tudo processado por uma arquitetura de **fila de jobs assíncrona** (BullMQ + Redis) com workers isolados em PM2.

---

## 🏗️ Arquitetura

```
┌────────────┐   HTTP (UI)   ┌─────────────┐      BullMQ/Redis      ┌─────────────────────┐
│ React+Vite │ ────────────► │ Express API │ ─────────────────────► │ crimson-scan-worker  │ 4× cluster
│ (HUD)      │               │  server.ts  │                        │   scrape, scan-all,   │ concurrency 5
└────────────┘               └─────────────┘                        │   compare, analyze,   │ = até 20 jobs
                                    │  SQLite (better-sqlite3)      │   local-price-scan,   │
                                    │  src/database/crimson.db      │   discover, insight   │
                                    ▼                               └─────────────────────┘
                          ┌────────────────────┐                    ┌─────────────────────┐
                          │ Filas (3):         │                    │ crimson-route-worker │
                          │  scan-queue        │◄───────────────────│   roteirização TSP   │
                          │  route-queue       │                    │   (OSRM + veículo)   │
                          │  social-monitor-   │                    └─────────────────────┘
                          │    queue           │                    ┌─────────────────────┐
                          └────────────────────┘                    │ crimson-social-worker│
                                                                    │   whatsapp-web.js    │
                                                                    │   instagrapi client  │
                                                                    └─────────────────────┘
                                                                     ┌─────────────────────┐
                                                                     │ crimson-instagram-  │
                                                                     │   service (Python)  │
                                                                     │   FastAPI:8721      │
                                                                     └─────────────────────┘
```

- **Fila única de scan** com 4 instâncias PM2 em cluster (`concurrency: 5` cada) → até **20 jobs simultâneos** sem OOM.
- **Lock anti-travamento**: `lockDuration: 65s`, `stalledInterval: 30s`, `maxStalledCount: 1`.
- **Toda IA roda em worker** (nunca no handler HTTP): LM Studio → NVIDIA → Gemini, em cascata.
- **Persistência** em SQLite (`src/database/schema.sql`), acessada via repositórios em `src/repositories/`.

---

## ⚡ Início rápido

### 1. Pré-requisitos
- Node.js ≥ 18 e npm
- Docker (para o Redis) ou um Redis em `127.0.0.1:6379`
- Python 3.10+ **apenas se** for usar o módulo Instagram (C3)

### 2. Suba o Redis
```bash
docker compose up -d        # redis:7-alpine na porta 6379 (persistente)
```

### 3. Instale e configure
```bash
npm install
cp .env.example .env        # preencha GEMINI_API_KEY e canais de notificação
```

### 4. Suba tudo com PM2
```bash
npm run pm2:start           # 5 processos: api, scan-worker(4), route-worker, social-worker, instagram-service
npm run pm2:logs            # acompanhe os logs
```

A UI fica em **http://localhost:3000**.

> Sem PM2: `npm run dev` (API) + `npm run worker:scan`, `worker:route`, `worker:social` em terminais separados.

---

## 📦 Módulos

### Módulo Local (geolocalizado)
- **Localização**: `POST /api/location` (endereço via Nominatim **ou** lat/lng + raio). Fica em `user_settings`.
- **Descoberta de mercados**: `POST /api/establishments/discover` → enfileira job no scan-queue → Overpass (OpenStreetMap) busca supermercados no raio e faz *upsert* (dedup por `osmId`).
- **Scan de preços locais**: `POST /api/local-price-scan` — usa a `price_url` dos estabelecimentos (`{term}` = nome do item) e respeita o raio da localização.
- **Roteirização** (`POST /api/route`): resolve o TSP pela ordem dos itens, calcula **distâncias/durations via OSRM** com fallback haversine, e aceita:
  - `vehicle`: `car`/`motorcycle` (consumo km/L + preço do combustível), `public` (tarifa), `bike`, `foot`;
  - `startTime`: ISO específico **ou** `"suggest"` (heurística Popular Times escolhe janela de menor movimento 7h–20h);
  - retorna `suggestedDepartureAt`, `arrivalTimeEstimate` e `quietScore` por parada.

### Promoções-relâmpago (flash)
- Detecção automática (média dos últimos N dias × threshold **ou** abaixo do menor preço histórico × 0.99) ao registrar preços — `src/lib/flashDetect.ts`.
- Expiração em 24h (`expires_at`), badge `RELÂMPAGO` na UI e alerta prioritário no Telegram (`flash_telegram_priority`).

### Monitoramento Social
- **WhatsApp (C2)** — `whatsapp-web.js` lê os *Status* dos contatos salvos em `establishments.whatsapp_number` e extrai promoções.
  - `GET /api/social/whatsapp/qr` (QR para o celular), `GET /api/social/whatsapp/status`, `POST /api/social/whatsapp/scan`.
  - Throttle: `user_settings.whatsapp_scan_per_contact_min` (default 20min).
- **Instagram Stories (C3)** — microserviço **Python (instagrapi)** baixa Stories dos handles cadastrados, e o **Gemini Vision** (`gemini-2.0-flash`) extrai preços da imagem.
  - `GET /api/social/instagram/health`, `POST /api/social/instagram/login`, `POST /api/social/instagram/scan`.
  - Throttle: `user_settings.instagram_scan_per_handle_min` (default 45min).
- **Captura manual**: `POST /api/social/capture` (texto colado do WhatsApp ou URL de perfil público).
- **⚠️ Aviso**: os módulos C2/C3 usam APIs **não oficiais** e violam os ToS. Use SEMPRE conta secundária dedicada. Ligue apenas se `WHATSAPP_ENABLED=true`/`INSTAGRAM_ENABLED=true` (ver `python_instagram/README.md`).

### Análise com IA
- `POST /api/analyze` e `POST /api/local-insights/analyze` **enfileiram** jobs e respondem `{ jobId }`; a UI faz *poll* via `GET /api/jobs/:queue/:id`.
- Cadeia de provedores: **LM Studio → NVIDIA → Gemini** (a primeira disponível vence).

---

## 🧪 Verificação (validação de cada fase)

```bash
npm run lint               # typecheck (tsc --noEmit)
docker compose ps          # Redis saudável
pm2 ls                     # 5 processos online, scan-worker 4/4
curl -s localhost:3000/api/status
curl -s "localhost:3000/api/jobs/scan-queue/<JOB_ID>"
```

Teste de estresse de 24h: `bash scripts/stress-test-24h.sh` (gera `RELATORIO_TESTE_24H.md`).

---

## 🔑 Variáveis de ambiente

Ver `.env.example`. Destaques: `GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `REDIS_URL`, `SERPAPI_KEY` (Popular Times best-effort), `SOCIAL_MONITORING_ENABLED`, `WHATSAPP_ENABLED`, `INSTAGRAM_ENABLED`, `INSTAGRAM_SERVICE_PORT=8721`.

---

## ⚠️ Segurança
- Nunca commite `.env` nem `data.json`/`crimson.db` com chaves privadas.
- Chaves podem ser configuradas pela UI (aba CONFIG), salvas por perfil de operador.

---

*[SISTEMA SENTINEL ATIVO]*
