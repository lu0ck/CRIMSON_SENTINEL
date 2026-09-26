# DIAGNÓSTICO — Crimson Sentinel (estado pré-reconstrução)

**Branch analisada**: `rebuild-v2` (commit `0c62073`, igual a `main`/`legacy-ecommerce`)
**Data**: 2026-08-07
**Objetivo**: catalogar, antes de qualquer alteração, todos os pontos do código atual onde (a) chamadas de rede externas acontecem de forma síncrona dentro de handlers Express, (b) agendamentos via `setInterval`/`setTimeout`, e (c) leitura/escrita direta em `data.json`. Nada foi corrigido — este documento é a baseline para a Fase 2 em diante.

> **ATUALIZAÇÃO — FASE 1 (2026-08-08):** Este documento descreve o estado pré-reconstrução. O item **3 (data.json I/O)** foi **completamente resolvido na Fase 1** (SQLite + repositórios). Veja seção "6.1 Status da FASE 1" abaixo. Itens 1 e 2 serão atacados nas Fases 2-3.

---

## 1. Chamadas de rede síncronas dentro de handlers Express (`server.ts`)

O `server.ts` é a única camada backend do projeto atual. Cada rota abaixo executa chamadas de rede externas (Gemini, Serper, Tavily, LM Studio, NVIDIA, Discord, Telegram, Gmail) **de forma bloqueante dentro do handler HTTP** — o cliente fica preso aguardando a resposta, e múltiplas requisições concorrentes sobrecarregam o event loop.

| Rota | Linha (server.ts) | O que faz síncrono | APIs externas chamadas |
|---|---|---|---|
| `POST /api/test-discord` | 235-243 | Dispara webhook Discord e aguarda retorno | `axios.post(webhookUrl)` via `sendDiscordNotification` (`notifications.ts:7`) |
| `POST /api/test-telegram` | 245-253 | Envia mensagem para Telegram Bot API | `axios.post('https://api.telegram.org/bot.../sendMessage')` (`notifications.ts:16`) |
| `POST /api/test-email` | 255-263 | Envia e-mail via Gmail SMTP | `nodemailer → transporter.sendMail` (`notifications.ts:33`) |
| `POST /api/scrape` | 265-297 | Executa scraping completo (Playwright multi-estratégia) e retorna resultado | `advancedScrape` (`scraper.ts:209`) → pode chamar Playwright, LM Studio (`fetch /v1/models`, `scraper.ts:57,257`), Gemini (`GoogleGenAI.generateContent`, `scraper.ts:1128`), NVIDIA NIM, fetch cru |
| `POST /api/compare` | 385-550 | Busca produtos via Serper/Tavily, então chama `advancedScrape` em cada URL encontrada (loop) | `fetch('https://google.serper.dev/search')` (`server.ts:328`), `fetch('https://api.tavily.com/search')` (`server.ts:358`), `GoogleGenAI.generateContent` (gemini-3-flash-preview, `server.ts:433`), `advancedScrape` em loop (`server.ts:507`) |
| `GET /api/status` | 555-604 | Verifica status do LM Studio com timeout 5s | `fetch('${lmStudioUrl}/v1/models')` (`server.ts:574`) |
| `POST /api/analyze` | 609-704 | Cadeia de fallback LLM: LM Studio → NVIDIA → Gemini | OpenAI SDK com LM Studio (`server.ts:645-654`), OpenAI SDK com NVIDIA (`server.ts:664-673`), `GoogleGenAI.generateContent` gemini-3-flash-preview (`server.ts:683-689`) |

### Pontos críticos de bloqueio
- `server.ts:265-297` (`/api/scrape`): A requisição HTTP só responde depois de todo o pipeline de scraping terminar (Playwright + multi-estratégia, ~30-60s). O cliente fica em loading state, e múltiplos scans concorrentes saturam o event loop.
- `server.ts:385-550` (`/api/compare`): Soma Serper/Tavily (5-10s) **+** `advancedScrape` em loop para cada URL (cada um com timeout de 30s). Tempo total🕒 pode passar 10min. Implementado com `isComparing` global flag (`server.ts:299-301`) — **bloqueia todas as outras comparações simultâneas** (anti-pattern).
- `server.ts:609-704` (`/api/analyze`): Três chamadas de IA síncronas em cadeia — falha em uma degrada a resposta inteira.
- `server.ts:235-263` (testes de notificação): são rápidos mas mesmo assim bloqueiam a thread; aceitáveis em dev, mas ruim como padrão.

### Circuit breaker / rate limit
Não existe. Nenhum backoff, nenhum retry configurável, nenhuma proteção contra falhas em cascata das fontes externas.

---

## 2. `setInterval` / `setTimeout` para agendamento

### `server.ts`
| Linha | Tipo | Propósito | Problema |
|---|---|---|---|
| 301 | `const lastSearchTime = 0` | Throttle manual entre comparações | Implementado à mão, não concurrency-safe, perdido em restart |
| 302 | `const SCAN_TIMEOUT_MS = 590000` | Timeout para Serper/Tavily | Hardcoded 9.5min |
| 325 | `setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)` | Abort do Serper | Per-request, OK, mas seria melhor no nível do job |
| 355 | `setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)` | Abort do Tavily | Idem |
| 573 | `setTimeout(() => controller.abort(), 5000)` | Abort da checagem de LM Studio | Curto demais para rede lenta |
| 753 | `const SCAN_INTERVAL = 12 * 60 * 60 * 1000` | Intervalo de backup (12h) hardcodado | **Não configurável pelo usuário** |
| 787 | `await new Promise(resolve => setTimeout(resolve, 5000))` | Delay 5s entre scans no `scanAllProducts` | Sem retry, sem backoff |
| 815 | `setTimeout(async () => { ...; scheduleDailyScan(); }, delay)` | **Agendador diário 15h recursivo** | Péssimo: `setTimeout` encadeado em `setTimeout` para próximas 24h. Se o processo morrer entre um tick e o outro, o scan diário desaparece. Não sobrevive a restart. |
| 826 | `setInterval(async () => { scanAllProducts(); }, SCAN_INTERVAL)` | **Backup 12h** | Idem: perdido em restart. Roda paralelo ao diário = duplicação em dias que coincidem. |

### `src/App.tsx`
| Linha | Tipo | Propósito |
|---|---|---|
| 315 | `setTimeout(() => { saveDataSilent; addToast; }, 1000)` | Debounce autosave config (1s) | OK — uso legítimo de debounce |
| 336 | `setTimeout(() => fetchData(retries - 1), 1500)` | Retry de fetch no boot (5x) | Frontend, aceitável |
| 352 | `setInterval(checkSystemStatus, 60*60*1000)` | Poll status de APIs a cada 1h | Frontend, mas debounce adequadamente não |
| 359 | `setInterval(() => setNextScanMinutes(prev => prev - 1), 60000)` | Countdown do próximo scan (a cada 1min) | UI display, OK |
| 650 | `setTimeout(() => individualController.abort(), 60000)` | Timeout de scrape (frente do browser) | OK, mas seria concerns do backend |
| 863 | `setInterval(...)` | Countdown 600s do modal de comparação | UI, OK |
| 2582 | `setInterval(...)` | Timer 5s do toast | UI, OK |

### `electron/main.cjs`
| Linha | Tipo | Propósito |
|---|---|---|
| 102 | `setTimeout(loadURL, 1500)` | Retry de carregamento de URL no Electron | OK — Emil contornado com isDestroyed |

### `src/lib/scraper.ts`
| Linha | Tipo | Propósito |
|---|---|---|
| 302 | `setTimeout(() => reject(new Error('Strategy timeout (30s)')), 30000)` | Timeout por estratégia de scrape | OK — dentro de `Promise.race`, aceitável |
| 720 | `var timer = setInterval(...)` | Scroll progressivo dentro de `page.evaluate` | Tempo de execução do browser, OK |

### `src/lib/gemini.ts`
| Linha | Tipo | Propósito |
|---|---|---|
| 107 | `await new Promise(resolve => setTimeout(resolve, 1000))` | Delay entre retries de Gemini quando price<=0 | Hardcoded |
| 121 | `await new Promise(resolve => setTimeout(resolve, waitTime))` | Backoff exponencial entre retries de Gemini (`Math.pow(2,i)*1000`) | OK — backoff em worker, mas roda dentro da rota síncrona |

### Resumo de agendamentos problemáticos
- **`server.ts:815` + `server.ts:826`**: dois agendadores independentes de scan automático (`scheduleDailyScan` recursivo com setTimeout + `setInterval` 12h). Ambos perderiam o estado em restart do processo. Não sobrevivem a pm2/systemd reiniciando a máquina. Devem virar **repeatable jobs do BullMQ**.
- **Throttle de comparação (`server.ts:299-301`)**: estado global em memória → perdido em restart, e não é robusto entre múltiplas instâncias.
- **Intervalo 12h hardcodado (`server.ts:753`)**: deve virar configuração em `user_settings`, não const.

---

## 3. Leitura/escrita direta em `data.json`

### `server.ts` — caminho do arquivo
| Linha | Operação |
|---|---|
| 69 | `DATA_DIR = process.env.USER_DATA_PATH || (process.env.NODE_ENV === 'production' ? '/tmp' : __dirname)` |
| 71-73 | `fs.existsSync(DATA_DIR)` + `fs.mkdirSync(DATA_DIR, {recursive:true})` |
| 75 | `const DATA_FILE = path.join(DATA_DIR, "data.json")` — definição |
| 79-86 | `if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(...)` — inicialização com `profiles:[], lists:[], products:[], notifications:[]` |
| 104-106 | `if (!fs.existsSync(DATA_FILE))` em `GET /api/data` |
| 108 | `const content = fs.readFileSync(DATA_FILE, "utf-8")` em `GET /api/data` |
| 124 | `fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2))` em `POST /api/data` |
| 138 | `const content = fs.readFileSync(DATA_FILE, "utf-8")` em `POST /api/products` |
| 188 | `fs.writeFileSync(DATA_FILE, ...)` em `POST /api/products` (substituir corrompido) |
| 202 | `fs.writeFileSync(DATA_FILE, ...)` em `POST /api/products` (adicionar) |
| 220 | `fs.writeFileSync(DATA_FILE, ...)` em `POST /api/products` (atualizar preço) |
| 268 | `const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))` em `POST /api/scrape` |
| 388 | `const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))` em `POST /api/compare` |
| 557 | `const rawData = fs.readFileSync(DATA_FILE, "utf-8")` em `GET /api/status` |
| 613 | `const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))` em `POST /api/analyze` |
| 760 | `const content = fs.readFileSync(DATA_FILE, "utf-8")` em `scanAllProducts` |
| 794 | `fs.writeFileSync(DATA_FILE, ...)` em `scanAllProducts` |

### Concorrência
A Mutex `async-mutex` (`server.ts:4,76,122,135`) **só protege `POST /api/data`**. As demais escritas (`POST /api/products`, `scanAllProducts` background) **não adquirem o mutex** → race condition real em escritas simultâneas durante o `scanAllProducts` do agendador (rodando a cada 12h e às 15h) combinado com escritas de UI.

### `src/lib/gemini.ts` (acesso fora do server)
| Linha | Operação |
|---|---|
| 15 | `const DATA_FILE = path.join(process.cwd(), "data.json")` — **caminho diferente do server**: usa `process.cwd()` enquanto `server.ts:69` usa `DATA_DIR` (que em produção Electron vira `USER_DATA_PATH`). Em produção empacotada isso aponta para o diretório errado. |
| 17 | `if (fs.existsSync(DATA_FILE))` |
| 18 | `const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))` |

### `src/lib/scraper.ts` (acesso a arquivos auxiliares — cache e cookies, não data.json)
| Linha | Operação |
|---|---|
| 12 | `CACHE_DIR = path.join(process.cwd(), ".cache")` |
| 13 | `COOKIE_DIR = path.join(process.cwd(), ".cookies")` |
| 14-15 | `fs.existsSync` + `fs.mkdirSync` |
| 219-239 | `fs.existsSync(cacheFile)` + `fs.statSync` + `readFileSync` + `unlinkSync` em cache de 1h |
| 333 | `fs.writeFileSync(cacheFile, JSON.stringify(result))` — salvar cache |
| 547-552 | `fs.existsSync(cookieFile)` + `readFileSync` cookies |
| 591-592 | `fs.writeFileSync(cookieFile, ...)` cookies |
| 608-609 | `fs.writeFileSync(cookieFile, ...)` cookies |
| 669-676 | `fs.existsSync(cookieFile)` + `readFileSync` cookies |
| 775-776 | `fs.writeFileSync(cookieFile, ...)` cookies |

> Cache/cookies não são o alvo principal desta reconstrução (vão junto com o scraper para o worker na Fase 3), mas registra-se que dependem de `process.cwd()` e quebram em produção Electron quando cwd é diferente.

---

## 4. Outras observações relevantes para a reconstrução

### Frontend (`src/App.tsx`)
- **11 fetches HTTP** para `/api/*` (linhas 174, 189, 207, 238, 281, 295, 325, 561, 653, 745, 875). Todos síncronos do ponto de vista do usuário, aguardando o backend responder. Esse padrão permanece no redesign (frontend calling backend HTTP), mas o backend deverá **enfileirar jobs** e responder imediatamente com um `jobId`, em vez de bloquear até o scraping terminar.
- `localStorage` usado apenas para `activeProfileId` (linhas 138, 143, 145). Aceitável, mas vai ser substituído por `user_settings` em SQLite.
- Lógica de normalização de URL e geração de ID duplicada **no cliente** (App.tsx:677-726) — mesma lógica existe em `server.ts:20-66`. Vai ser centralizada no repositório SQLite, eliminando a duplicação.

### `electron/main.cjs`
- Linha 23-70: `startServer()` faz `fork` do `server.ts` via `tsx` dentro do processo Electron. Em crash, **não há restart automático** — só `safeLog('Server process exited with code: ' + code)` (`main.cjs:60-62`). Na reconstrução: abandona-se Electron (decisão do usuário), `server.ts` roda como processo pm2 separado, workers também.

### Tipos inconsistentes
- `server.ts:84` inicializa `data.json` com `notifications: []`, mas `src/types.ts` (`AppData`) **não declara `notifications`**. Isso não dá erro de tipo apenas porque o server lida com `any` (req.body) e o cliente ignora o campo. A tabela `notifications` foi pretendida (existe no init) mas nunca implementada. Reconstrução: remover do `AppData` velho ou implementar нетação no novo schema — provavelmente removida em prol de `price_observations`/`promotions`.

---

## 5. Resumo consolidado — contagem

| Categoria | Total de ocorrências |
|---|---|
| Handlers Express síncronos com rede externa | **7** (`/api/scrape`, `/api/compare`, `/api/analyze`, `/api/status`, `/api/test-discord`, `/api/test-telegram`, `/api/test-email`) |
| Agendadores em background (server.ts) | **2** (`scheduleDailyScan` recursivo em `setTimeout`, `setInterval` 12h) — ambos perdidos em restart |
| Outros `setInterval`/`setTimeout` relevantes | **13** (UI debounce, retry, timeouts per-request) |
| Leituras/escritas diretas em `data.json` (server.ts) | **17** (todas síncronas, sem transação, sem ACID) |
| Acesso a `data.json` fora do server | **3** em `gemini.ts` (caminho divergente: `process.cwd()` vs `DATA_DIR`) |
| Acesso a cache/cookies em `scraper.ts` | **14** (não é `data.json`, mas dependem de `cwd`) |
| Mutex protegendo apenas 1 de 4 escritas | Sim — só `POST /api/data` protegido, demais escritas têm race condition |

---

## 6. Plano de atacar cada ponto (link para próximas fases)

| Problema | Fase que resolve |
|---|---|
| Handlers síncronos (scrape/compare/analyze) viram workers | Fase 2 (infra de fila) + Fase 3 (mover scraping para worker) |
| Agendadores `setTimeout`/`setInterval` viram repeatable jobs do BullMQ | Fase 2 |
| Throttle de comparação em memória (`isComparing`, `lastSearchTime`) | Fase 2 (BullMQ tem rate limit próprio) |
| Circuit breaker | Fase 3 |
| `data.json` → SQLite com repository pattern | Fase 1 (migração) |
| Mutex parcial → transações SQLite | Fase 1 (better-sqlite3 é síncrono nativo, sem race) |
| Caminho `data.json` divergente em `gemini.ts` (`process.cwd()` vs `DATA_DIR`) | Eliminado em Fase 1 (repositório unificado) |
| Cache/cookies em `scraper.ts` (caminho `cwd`) | Mantido como cache local no worker (Fase 3), criminaliza-se caminho relativo a `DATA_DIR` |
| Lógica de normalização/ID duplicada (frontend vs backend) | Eliminada em Fase 1 (unificada em `ProductRepository`) |

---

## 6.1 Status da FASE 1 (resolvido)

O problema estrutural de I/O em `data.json` foi eliminado. Arquivos criados:

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` | 12 tabelas (profiles, product_lists, products, price_history + 8 do módulo local) + defaults em user_settings |
| `src/database/db.ts` | `getDb()` singleton, WAL, FK, executa schema.sql, path idêntico ao antigo `DATA_DIR` |
| `src/repositories/profileRepository.ts` | CRUD + `saveAll` com upsert transacional |
| `src/repositories/productListRepository.ts` | Idem para lists |
| `src/repositories/productRepository.ts` | Idem + `price_history` normalizado em `syncPriceHistory` |
| `src/repositories/settingsRepository.ts` | `get/set/getNumber/getBool` para user_settings (substitui consts hardcoded) |
| `src/repositories/appDataRepository.ts` | `getAll()`/`saveAll()` = equivalente do antigo data.json |
| `src/repositories/types.ts` | Row↔Domain mappers |

**Mudanças no `server.ts`** (API HTTP inalterada — frontend continua igual):
- Removidos `Mutex`/`async-mutex` e toda leitura/escrita em `data.json` (17 ocorrências) → repositórios.
- `SCAN_TIMEOUT_MS`, `SCHEDULE_HOUR`, `SCAN_INTERVAL` agora leem de `user_settings` (com fallback igual aos valores antigos).
- Timers de scan agora usam `.unref()` para não segurar o processo.
- `gemini.ts` não lê mais `data.json` — usa `ProfileRepository.getById`.

**Migração**: `npm run migrate` (script one-shot) copia `data.json` → SQLite e renomeia o original para `.bak-<timestamp>`.

**Testes realizados (2026-08-08)**:
- ✅ Boot limpo: SQLite criado com 12 tabelas, server sobe via pm2
- ✅ `GET /api/data` → 200 com `{profiles, lists, products}`
- ✅ `POST /api/data` → 200, persiste profiles/lists/products
- ✅ `POST /api/products` → add/replaced/exists/update conforme esperado (mesma lógica do original)
- ✅ Deduplicação por URL normalizada funciona (params tracking da lista removidos)
- ✅ Migração `data.json` → SQLite: profiles, lists, products + price_history normalizado + backup `.bak-<timestamp>`
- ✅ `user_settings` populada com 7 defaults; `SCHEDULE_HOUR`/`SCAN_INTERVAL`/`SCAN_TIMEOUT_MS` lidos do banco
- ✅ Typecheck: 41 erros pré-existentes (store-handlers.ts, scraper.ts), **zero erros novos**
- ⚠️ Observação: param `tag` (Amazon) não está na lista `trackingParams` do `server.ts` — bug pré-existente, será corrigido quando a lógica for centralizada (Fase 3)
- ⚠️ Nota: melhorar estratégia de start (pm2, ver Fase 2) — durante teste, processos órfãos seguraram a porta 3000

---

## 6.2 Status da FASE 2 (concluída)

Infraestrutura de filas BullMQ + Redis + pm2 implementada e testada E2E. O backend passa a **enfileirar jobs** e responder imediatamente com `{jobId, status:"queued"}`; o processamento acontece em **workers separados**.

| Arquivo | Papel |
|---|---|
| `src/queue/connection.ts` | Singleton ioredis (`maxRetriesPerRequest: null`) |
| `src/queue/types.ts` | Payloads tipados dos jobs (ScrapeJob, CompareJob, ScanAllJob, RouteJob, SocialJob) |
| `src/queue/queues.ts` | 3 filas (`scan-queue`, `route-queue`, `social-monitor-queue`) + `closeAllQueues` |
| `src/queue/schedulers.ts` | API BullMQ v6: `upsertJobScheduler`/`removeJobScheduler`/`getJobSchedulers` (substitui `add`+`repeat` antigos) |
| `src/workers/scanWorker.ts` | Handlers `scrape`/`scan-all`/`compare`; concurrency 2; retries 3, backoff exp. 30s |
| `src/workers/scanWorkerEntry.ts` | Entry point pm2 com SIGTERM/SIGINT limpo |
| `src/workers/routeWorker.ts` | Stub (TSP/OSRM na Fase 7) |
| `src/workers/socialWorker.ts` | Stub (respeita `social_monitoring_enabled`; corpo nas Fases 9/10) |
| `src/lib/safeLog.ts` | Log compartilhado API/workers |
| `ecosystem.config.cjs` | 4 processos pm2 (api + 3 workers) |

**Mudanças no contrato da API (FASE 2):**
- `POST /api/scrape` e `POST /api/compare` → respondem `{jobId, status:"queued"}` (compare também `jobKey`) em vez de bloquear. **`src/App.tsx` precisa fazer polling em `GET /api/jobs/:queue/:id`** (ainda não alterado).
- Novo `GET /api/jobs/:queue/:id` → `{id, name, state, attemptsMade, progress, returnvalue, failedReason, timestamp}`.
- `GET /api/status` → `nextScanMinutes` lido do scheduler BullMQ (`getJobScheduler("scan-daily-cron")`).
- Agendadores `setTimeout`/`setInterval` removidos; substituídos por `upsertJobScheduler` idempotente (`scan-daily-cron` 15:00 e `scan-interval-12h`), intervalos lidos de `user_settings`.

**Testes realizados (2026-08-08):**
- ✅ `pm2 start ecosystem.config.cjs` → 4 processos online (api + 3 workers), sem crash
- ✅ Schedulers registrados no boot: log `[scheduler] schedulers registrados: daily=15:00, interval=720min`; keys no Redis `bull:scan-queue:repeat:scan-daily-cron` e `repeat:scan-interval-12h`
- ✅ O scheduler `scan-interval-12h` disparou scan-all automático no registro (prova do ciclo completo)
- ✅ `POST /api/scrape` → `{jobId:"6", status:"queued"}`; `GET /api/jobs/scan/6` → `state: delayed`, `attemptsMade: 2`, `failedReason` (retry automático com backoff funcionando; falha real do scraper externo, esperado)
- ✅ `POST /api/compare` → `{jobId:"9", jobKey, status:"queued"}`; `GET /api/jobs/scan/9` → `state: completed` com `returnvalue: {jobKey, results:[]}`
- ✅ `route-queue`: job manual → worker processou (`[route-worker] planejando rota com 2 itens`), state completed
- ✅ `GET /api/status` → `nextScanMinutes: 1186` (lido do scheduler)
- ⚠️ Bug corrigido: `/api/jobs/:queue/:id` estava registrado **depois** do SPA fallback (`app.get('*')`), retornando index.html — movido para antes do bloco Vite
- ⚠️ Bug corrigido: `ecosystem.config.cjs` usava `script: "tsx"`, que o pm2 não resolve (path relativo do CLI) — trocado para `./node_modules/.bin/tsx`

---

## 6.3 Status da FASE 3 (concluída)

Hardening do scraper dentro do worker. Três frentes resolvidas:

| Frente | Arquivo(s) | O que mudou |
|---|---|---|
| Normalização/ID centralizada | `src/lib/url.ts` (novo) | `normalizeProductUrl`/`generateProductId` — FONTE ÚNICA. Elimina duplicação entre `server.ts` e `App.tsx` que gerava **IDs divergentes** para a mesma URL. Lista de tracking params unificada: agora inclui `tag` (Amazon), `th`, `psc`, `smid`, `smile`, `linkCode`, `gad_source`, `gad_campaignid` (bug pré-existente documentado no §6.1). Forma canônica = `origin + caminho canônico`, **query e hash sempre descartados**. |
| Circuit breaker por domínio | `src/lib/circuitBreaker.ts` (novo) | Abre após 3 falhas consecutivas por domínio, cooldown 5min, half-open com probe. Quando aberto, `advancedScrape` pula as estratégias Playwright (caras, 10-30s) e só tenta `FETCH_FALLBACK`/`GEMINI_FALLBACK`. |
| Cache/cookies sob DATA_DIR | `src/database/db.ts`, `src/lib/scraper.ts` | `.cache`/`.cookies` passam a derivar de `DATA_DIR` (exportado por `db.ts`) em vez de `process.cwd()` — consistente entre api, workers pm2 e produção (`USER_DATA_PATH`/`/tmp`). `.gitignore` ganhou `.cache/` e `.cookies/`. |

**Integração do breaker em `advancedScrape`** (`src/lib/scraper.ts`):
- `domain = getDomain(url)`; `circuitOpen = scraperBreaker.isOpen(domain)`.
- Se aberto: pula `PLAYWRIGHT_HANDLER`, `PLAYWRIGHT_LM_STUDIO_*`, `PLAYWRIGHT_STEALTH_BASIC`, `PLAYWRIGHT_BASIC`; mantém `FETCH_FALLBACK` (barato) e `GEMINI_FALLBACK` (se key).
- Sucesso → `recordSuccess(domain)` (fecha o circuito); falha total → `recordFailure(domain)`.

**Testes realizados (2026-08-08):**
- ✅ Normalização: `tag`/`th`/`psc` da Amazon removidos → mesma URL normalizada e **mesmo ID** variando params de tracking (ex: `/dp/B0BDK3PDYQ` id `8f8tev` estável); suffixo `/ref=` removido; Magalu `/produto/p/x` → `/p/x`; trailing slash removido.
- ✅ Breaker unit: fecha após 3 falhas, reabre após cooldown (probe), probe ok fecha, re-trip funciona.
- ✅ Breaker E2E no worker: 3 falhas consecutivas de `kabum.com.br` → job seguinte logou `⏸ Circuit OPEN — pulando estratégias Playwright` e falhou com `tried: FETCH_FALLBACK` (só estratégia barata).
- ✅ Sucesso real: scrape de `/produto/88888` (produto real Kabum) via `FETCH_FALLBACK` → `{name:"Crepioca 3 em 1 Britânia", price:11}` — pipeline completo até salvar preço.
- ✅ Typecheck: 41 erros pré-existentes (store-handlers.ts + 1 em scraper.ts pré-existente), **zero novos**.
- ✅ `vite build` OK (App.tsx com import do módulo compartilhado).
- ⚠️ Nota técnica: imports de módulos TS com e sem extensão `.ts` no mesmo processo criam **duas instâncias** de módulo em tsx (visto com `scraperBreaker`). No worker não há impacto (só `scraper.ts` importa o breaker), mas padronizou-se `./circuitBreaker.ts` com extensão para evitar a armadilha futuramente.
- ⚠️ Atenção: ao unificar a normalização, o ID canônico passou a descartar TODA query string (antes o backend mantinha params não-tracking via `parsed.toString()`). Para produtos adicionados pelo frontend não muda nada (o frontend já descartava query); só afeta produtos salvos diretamente via API com query params não-tracking (migração dev).

---

## 6.4 Status da FASE 4 (concluída)

Frontend adaptado ao contrato assíncrono da FASE 2 (`/api/scrape` e `/api/compare` agora respondem `{jobId, status:"queued"}` em vez de bloquear até processar). Antes desta fase o UI **quebrava** ao adicionar produtos/rodar comparação.

**O que mudou em `src/App.tsx`:**
- Novo helper `pollJob(jobId, signal, intervalMs, timeoutMs)`: faz polling em `GET /api/jobs/scan/:jobId` a cada 2s até `completed` (devolve `returnvalue`) ou `failed` (lança `Error(failedReason)`); respeita `AbortSignal` (cancelamento do usuário) e timeout.
- `addProduct`: `POST /api/scrape` → `pollJob` → `info` = returnvalue do worker (`ScrapeResult` com `name/price/currency/available/imageUrl/method`). Timeout por alvo 240s (antes era 60s de HTTP síncrono, que não refletia o processamento real).
- `compareProduct`: `POST /api/compare` → `pollJob` → `results = returnvalue.results` (shape `{jobKey, results}`). Timeout 590s (alinhado ao countdown de 600s do modal).
- Cancelamento do scrape: `AbortError` com o controller principal abortado → não exibe toast falso de "TIMEOUT" (trata como cancelamento silencioso).

**Testes realizados (2026-08-08):**
- ✅ `POST /api/scrape` (produto real Kabum) → `{jobId:"4"}` → poll → `completed` com `returnvalue {name:"Crepioca 3 em 1 Britânia", price:11, method:"FETCH_FALLBACK"}` — shape idêntico ao que `info` consome.
- ✅ `POST /api/compare` → `{jobId, jobKey}` → poll → `completed` com `returnvalue {jobKey, results:[]}` — shape idêntico ao `jobResult.results`.
- ✅ Caminho de falha: URL inválida → job `delayed` (retry com backoff) → eventualmente `failed` com `failedReason` → `pollJob` lança o erro → toast existente exibe.
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK.

**Nota FASE 4→5:** com o UI de volta ao contrato novo, a FASE 5 pode partir para o módulo local/geolocalizado: `routeWorker` (TSP/OSRM) e `shopping_list_items`/`price_observations`/`promotions` com notificações.

---

## 6.5 Status da FASE 5 (concluída) — ver histórico de trabalho

Módulo local/geolocalizado completo: roteirização com TSP/OSRM (worker BullMQ), CRUD de estabelecimentos/lista de compras/promoções, observações de preço e rotas salvas. Frontend na aba **LOCAL**. Detalhes e correções de auditoria registrados na sessão anterior.

---

## 6.6 Status da FASE 6 (concluída)

Sistema de Notificações — integrou o `notify.ts` (antes código morto) com alertas tipados e **dedup anti-spam**.

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` | Tabela `notification_log` (histórico + dedup) + settings `notifications_enabled`, `notification_cooldown_hours` (default 24h) |
| `src/repositories/notificationRepository.ts` | `hasSentWithin` (cooldown), `record`, `getAll`, `deleteByEntity` |
| `src/lib/notify.ts` | `alertProductTargetReached`, `alertShoppingItemTargetReached`, `alertActivePromotion` — todos com dedup via `notification_log` + master switch |
| `src/workers/scanWorker.ts` | Dispara alerta de preço-alvo em `handleScrape` e `handleScanAll` quando `currentPrice <= targetPrice` |
| `server.ts` | Alerta em `POST /api/price-observations` (item local entra no alvo) e `POST /api/promotions` (promoção ativa); novo `GET /api/notifications` |
| `src/components/NotificationsTab.tsx` | Aba **ALERTAS** no frontend (histórico de notificações) |
| `src/App.tsx` | Tab `alerts` + StatCard "ALERTAS ENVIADOS" agora usa contador real de `notification_log` |

**Fluxo de alertas:**
1. **Produto e-commerce** (`scanWorker`): após scrape/scan-all, se `currentPrice <= targetPrice` → envia para o perfil do produto.
2. **Item local** (`POST /api/price-observations`): se `price <= item.targetPrice` → envia para todos os perfis com canal configurado.
3. **Promoção ativa** (`POST /api/promotions`): alerta com % OFF calculado.
4. **Dedup**: qualquer alerta é registrado em `notification_log`; o mesmo alvo não é re-notificado dentro de `notification_cooldown_hours` (24h). Master switch `notifications_enabled`.

**Testes realizados (2026-08-09):**
- ✅ Dedup unit: `hasSentWithin` false → record → true; cooldown respeitado.
- ✅ E2E API: perfil com webhook + estabelecimento + item (alvo R$25) + observação R$23,90 → alerta gravado; segunda observação R$22,50 → **count permaneceu 1** (dedup).
- ✅ Promoção ativa → alerta gravado com % OFF.
- ✅ Alerta de produto (script): primeiro `true`, repetição imediata `false` (dedup 24h). Erro Discord 405 é esperado (webhook fake) — `sendDiscordNotification` já engole falha de canal.
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK; 4 processos pm2 online.
- ⚠️ Ambiente: `better-sqlite3` precisou de `npm rebuild` (compilado para Node 20, atual Node 22) — recompilado com sucesso.
- ⚠️ Nota: `alertShoppingItemTargetReached`/`alertActivePromotion` enviam a **todos** os perfis com canal (itens/promoções locais não têm `profile_id` no schema) — comportamento proposital.

**Nota FASE 6→7:** próximo passo natural é o monitoramento social (`socialWorker`: WhatsApp/Instagram) previsto nas Fases 9/10, ou análise local com IA (melhor estabelecimento por item/economia entre rotas).

## 6.7 Status da FASE 7 (concluída) — Insights locais com IA

Análise local determinística (sem rede) + narrativa do núcleo SENTINEL (Gemini) via job assíncrono, com painel INSIGHTS no módulo local.

| Arquivo | Papel |
|---|---|
| `src/lib/localInsights.ts` | `normalize` (minúsculas/sem acento), `promotionMatchesItem` (substring ≥4 chars), `buildLocalInsights` (preço efetivo = min(observado, promo)), `singleStoreBest` (max cobertura → min custo), `economyVsSingleStore` (+Pct), `summarizeInsights` (fallback determinístico), `buildInsightPrompt` (tom HUD militar) |
| `src/queue/types.ts` | `LocalInsightJobPayload { type: "local-insight"; profileId? }` na união `ScanJobPayload` |
| `src/workers/scanWorker.ts` | `handleLocalInsight`: `buildLocalInsights` + Gemini (`profile?.geminiApiKey \|\| GEMINI_API_KEY`) com fallback em `summarizeInsights`; retorna `{ insights, text, method }` |
| `server.ts` | `GET /api/local-insights` (síncrono) + `POST /api/local-insights/analyze` (enfileira na scan-queue, retorna `{ jobId }`) |
| `src/components/LocalTab.tsx` | Painel INSIGHTS: melhor preço por item (com flag NO ALVO/PROMO), cartões de estratégia (rota otimizada × tudo-em-um × economia), botão "ANALISAR COM IA" (poll `queue="scan"`) |

**Fluxo:**
1. `GET /api/local-insights` → resposta imediata e determinística (dados locais via repositórios, sem rede).
2. "ANALISAR COM IA" → `POST /api/local-insights/analyze` → job `local-insight` na scan-queue → worker computa insights e gera narrativa Gemini (se API key configurada) ou fallback determinístico.
3. Frontend faz `pollJob(jobId, …, "scan")` e exibe o relatório com badge `method: gemini|deterministic`.

**Testes realizados (2026-08-09):**
- ✅ E2E determinístico: 2 estabelecimentos + 3 itens + promoção de café. Resultado: multi-parada R$49,70 vs tudo-em-um R$52,30 → economia R$2,60 (5%); promo aplicada (Café R$17,90 no Atacadão); flags NO ALVO corretas.
- ✅ Pipeline IA: job `local-insight` enfileirado → `state: completed` com `returnvalue` (insights + texto). Sem `GEMINI_API_KEY` no ambiente, `method: deterministic` (fallback funciona).
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK; 4 processos pm2 online.
- ✅ **#29 (2026-09-23)** — bug de `profileId` corrigido em `LocalTab.analyzeWithAI` (body mandava `{}`); App agora passa `hasGeminiKey` e o badge do relatório diferencia `GEMINI` / `DETERMINISTIC SEM CHAVE` / `GEMINI FALHOU`. Caminho Gemini do perfil → worker validável na UI.

**Nota FASE 7→8:** próximo passo natural é o monitoramento social (`socialWorker`: WhatsApp/Instagram) previsto nas Fases 9/10.

## 6.8 Status da FASE 8 (concluída) — Monitoramento social

Antecipou o monitoramento social previsto para as Fases 9/10: `socialWorker` deixa de ser stub e captura promoções de WhatsApp (texto colado) e Instagram (captions via Playwright) → grava em `promotions` (source `whatsapp`/`instagram`) + alerta nos canais configurados.

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` | Tabela `social_sources` (id, channel whatsapp/instagram, name, url, establishment_hint, enabled, last_checked_at) |
| `src/repositories/socialSourceRepository.ts` | CRUD de fontes sociais + `setLastChecked` |
| `src/queue/types.ts` | `SocialCaptureJobPayload` (channel/text/url/sourceId/profileId) + `SocialScanAllJobPayload`; união `SocialMonitorJobPayload` |
| `src/lib/socialParse.ts` | `parsePromosFromText` (determinístico: "de R$ X por R$ Y", preço único, múltiplos preços), `cleanProductName` (remove prefixos "OFERTA RELÂMPAGO/PROMOÇÃO" e nomes de estabelecimento), `matchEstablishment` (por nome normalizado no texto ou hint), `parsePromosFromTextWithAI` (Gemini opcional), `isDuplicatePromo` (dedup por produto+estabelecimento ativos) |
| `src/workers/socialWorker.ts` | `handleSocialCapture` (texto → parse → save + alerta, atualiza last_checked; Instagram sem texto baixa captions via Playwright), `handleSocialScanAll`; respeita `social_monitoring_enabled` |
| `server.ts` | CRUD `/api/social/sources` (GET/POST/DELETE), `POST /api/social/capture` (enfileira), `POST /api/social/scan-all` (enfileira); queue `social` adicionada ao map `/api/jobs/:queue/:id` |
| `src/components/SocialTab.tsx` | Aba **SOCIAL**: lista de fontes com "CAPTURAR", formulário de nova fonte, botão SCAN ALL, caixa de captura manual de texto WhatsApp |
| `src/App.tsx` | Tab `social` + NavButton com ícone Radio |

**Correção de bug pré-existente:** `PromotionRepository.save` passava `is_active` como boolean puro → better-sqlite3 rejeita booleans ("can only bind numbers, strings..."). Agora coerce para `1|0`. (O fluxo manual da aba LOCAL já enviava `isActive: true` e falharia no mesmo ponto.)

**Testes realizados (2026-08-09):**
- ✅ Captura WhatsApp (texto colado): 3 promoções extraídas com nomes limpos (`Café 500g` de R$24,90 por R$17,90; `Arroz 5kg` por R$22,90; `Leite Integral 1L` R$4,99), todas associadas ao estabelecimento correto via match por nome/hint, source=`whatsapp`.
- ✅ Dedup: segunda captura do mesmo texto → `saved: 0`, `skippedDuplicates: [Café 500g, Arroz 5kg]`.
- ✅ Alerta: com perfil + webhook fake, `notification_log` gravou 3 alertas `promotion` (erro 405 do Discord é esperado — canal fake).
- ✅ Instagram via Playwright: `npx playwright install chromium` (headless shell 1217) baixado; captura do perfil público retornou `method: playwright` com captions, 0 promoções (perfil sem preços — correto).
- ✅ CRUD fontes + scan-all: fonte instagram criada/removida, `scan-all` completou com `{sources: 1}`.
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK.
- ⚠️ Limite: Instagram público exige browser (heavy); o profile view mostra captions mas preços podem vir em imagens — Gemini (se `GEMINI_API_KEY`) refina.
- ⚠️ pm2 caiu durante o teste (sem OOM log explícito) — reiniciado com `pm2 start ecosystem.config.cjs`.

**Nota FASE 8→9:** próximos passos naturais: agendamento recorrente do scan social (repeatable jobs), integração WhatsApp real (sessão), ou painel de histórico de preços.

## 6.9 Status da FASE 9 (concluída) — Agendador do scan social

Transformou o scan social em **repeatable job do BullMQ** (mesmo padrão do scan de e-commerce), com frequência configurável via UI.

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` | Setting `social_scan_interval_ms` (default 6h) |
| `src/queue/schedulers.ts` | `registerSocialScheduler` (upsert idempotente do `social-scan-cron` na social-queue), `unregisterSocialScheduler`, `listSocialScheduledJob` (usa `key` do scheduler, não `id`) |
| `src/workers/socialWorker.ts` | `handleSocialScanAll` agora **enfileira um `social-capture` por fonte ativa** (retorna `{sources, enqueued}`); `last_checked_at` é atualizado mesmo quando não há texto/URL válida |
| `server.ts` | Registro do scheduler no boot; `GET /api/social/settings` (intervalo + scheduler ativo), `PUT /api/social/settings` (altera intervalo e re-registra); `/api/status` agora expõe `nextSocialScanMinutes` |
| `src/components/SocialTab.tsx` | Seletor de frequência (1h/6h/12h/24h) + indicador "PRÓXIMO SCAN ..." com refresh a cada 60s |

**Testes realizados (2026-08-09):**
- ✅ Scheduler registrado no boot com default 6h; `PUT` para 1h → `/api/status` retornou `nextSocialScanMinutes: 60`.
- ✅ Persistência: scheduler listado com `key: social-scan-cron`, `every: 21600000` após revert.
- ✅ scan-all com 3 fontes (1 IG + 2 WhatsApp) → `returnvalue {sources:3, enqueued:3}`; jobs `social-capture` individuais completaram (Instagram `method: playwright`; WhatsApp sem texto → `reason: sem texto nem URL válida`, sem crash).
- ✅ `last_checked_at` atualizado em todas as fontes após o scan-all.
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK; 4 processos pm2 online.
- ✅ Nota: fix em `listSocialScheduledJob` — `getJobSchedulers()` expõe o campo `key`, não `id`.

**Nota FASE 9→10:** próximos passos naturais: painel de histórico de preços (price_history + price_observations), integração WhatsApp real (sessão), ou dedup/mescla de estabelecimentos.

## 6.10 Status da FASE 10 (concluída) — Painel de histórico de preços

Visualização de séries temporais unificadas: **e-commerce** (tabela `price_history`, acumulada por scan) e **local** (`price_observations`, por item + estabelecimento).

| Arquivo | Papel |
|---|---|
| `src/lib/priceHistory.ts` | `buildEcommerceEntities`, `buildLocalEntities` (agrupa observações por item→estabelecimento), `computeStats` (atual/mín/máx/média/variação %), `sortPointsByDate`, `filterByRange` |
| `server.ts` | `GET /api/price-history?rangeDays=N` — séries + stats, com filtro de período aplicado server-side |
| `src/components/PriceHistoryTab.tsx` | Nova aba com switch E-COMMERCE/LOCAL, dropdown de produto/item, gráfico recharts multi-série, filtros TUDO/7D/30D/90D e cards de estatísticas |
| `src/App.tsx` | Tab `history` + NavButton (ícone Activity) |

**Testes realizados (2026-08-09):**
- ✅ Seed: produto `f10-prod` (4 pontos `price_history`), item `f10-item` + est. `f10-est` com 4 `price_observations`; ambos criados via repositórios (FK `profile_id` exige profile real — criado `profile-1`).
- ✅ `GET /api/price-history?rangeDays=0`: e-commerce 4 pts (variação +22,1%), local item "Café Torrado 500g" @ "Mercado F10" com min 18,9 / max 21 / atual 18,9.
- ✅ `rangeDays=5` corta pontos antigos (e-commerce 4→3, local 4→2) — filtro server-side OK.
- ✅ Frontend (Playwright): tela de perfil → aba HISTÓRICO → gráfico e-commerce renderiza (`svg.recharts-surface` = 2, cards ATUAL etc. presentes); escopo LOCAL mostra item + estabelecimento + série. Sem pageerror.
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK.
- ✅ Dados de teste removidos (produto/item/observações/estabelecimento); perfil `profile-1` preservado.

**Nota FASE 10→11:** próximos passos naturais: integração WhatsApp real (sessão), dedup/mescla de estabelecimentos, ou scraping de preços locais assíncrono.

## 6.11 Status da FASE 11 (concluída) — Scraping de preços locais assíncrono

Coleta automática de preços de itens locais via scraping em background (sem travar o event loop), alimentando `price_observations` (source `scraping`) e, por consequência, o painel de histórico da FASE 10.

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` + `src/database/db.ts` | Coluna `price_url` em `establishments` (URL de busca com `{term}`); migração defensiva via `ensureColumn` (`ALTER TABLE` só quando a coluna falta) — SQLite não tem `ADD COLUMN IF NOT EXISTS` |
| `src/types.ts`, `src/repositories/types.ts`, `establishmentRepository.ts` | Campo `priceUrl` + mapeamento `price_url` |
| `src/lib/localPriceScrape.ts` | `buildSearchUrl` (substitui `{term}` ou usa `?q=`), `scrapeItemPrice` (chama `advancedScrape` com chaves do perfil, dedup por item+est+preço com tolerância R$0,01, grava observation com notes=URL), `scanEstablishmentPrices` |
| `src/queue/types.ts` | `LocalPriceScanJobPayload { type: "local-price-scan", establishmentId?, profileId? }` |
| `src/workers/scanWorker.ts` | `handleLocalPriceScan` — varre est. específico (ou todos com `price_url`) × todos os itens, retorna `{ establishments, recorded, duplicates, errors, outcomes }` |
| `server.ts` | `POST /api/local-price-scan` (enfileira na scan-queue, retorna `{ jobId }`) |
| `src/components/LocalTab.tsx` | Campo "URL DE PREÇO LOCAL" no form de estabelecimento + botão **SCAN PREÇOS** por estabelecimento com spinner e toast do resumo |

**Testes realizados (2026-08-10):**
- ✅ Migração `price_url` aplicada no banco existente (log `[db] migração: establishments.price_url adicionada`).
- ✅ URL sem `{term}` recebe `?q=` automaticamente; com `{term}` é substituída (encodeURIComponent).
- ✅ Servidor fake local (`127.0.0.1:5678`) devolvendo "R$ 12,34": job registrou **2 observações** (`recorded: 2`, method `PLAYWRIGHT_STEALTH_BASIC`).
- ✅ **Dedup**: re-scan → `recorded: 0, duplicates: 2`, banco mantém 2 linhas.
- ✅ URL inacessível (example.com 404): falhas capturadas (`errors` contados) **sem crash do worker**.
- ✅ Integração FASE 10: `price_history` local mostra as observações com fonte `scraping`.
- ⚠️ Nota: durante o teste, o **pm2 estava vazio** (ambiente reiniciado) — tudo recuperado com `pm2 start ecosystem.config.cjs` (4 processos online).
- ✅ Typecheck: 41 erros pré-existentes, **zero novos**; `vite build` OK. Dados de teste removidos.

**Nota FASE 11→12:** próximos passos naturais: integração WhatsApp real (sessão), dedup/mescla de estabelecimentos, ou agendador do scan de preços locais (repeatable job, como o social).

### 6.11.1 Migração de ambiente (2026-08-24) — quebras e correções

O ambiente foi migrado para outro disco; o projeto agora vive em `/mnt/SSD_Games_2/Projetos/CRIMSON_SENTINEL` (antes `/mnt/ssd_dados/...`). Impactos e resoluções:

| Item | Problema | Resolução |
|---|---|---|
| Node | v22.23.2 → **v20.20.2** | `node_modules` recompilados (`npm install --ignore-scripts` + `npm rebuild`); better-sqlite3 compilou OK para ABI do Node 20 |
| better-sqlite3 | `gyp ERR! ... .d.raw: Arquivo ou diretório inexistente` no install padrão | Instalar com `--ignore-scripts` e depois `npx node-gyp rebuild --release` dentro de `node_modules/better-sqlite3` |
| tsc | Os 41 erros pré-existentes em scraper.ts/store-handlers.ts **desapareceram** com o fresh install — typecheck agora 100% limpo | — |
| Redis | Não existia no novo ambiente (sem sudo) | Compilado do fonte em `/tmp/opencode/redis-7.4.1`; binários persistidos em `~/.local/opt/{redis-server,redis-cli}`. Iniciar com: `~/.local/opt/redis-server --port 6379 --daemonize yes` (**volátil entre boots — reiniciar se ping falhar**) |
| pm2 | Não estava global; dump antigo restaurado com entradas obsoletas | Usar `npx pm2 ...`; `pm2 kill` + start + `pm2 save` para limpar dump |
| scan-worker cluster | pm2 rejeita script `.ts` sem Node>=22.18 ("TypeScript apps require bun, Node.js >= 22.18..."); `.bin/tsx` é shell wrapper (SyntaxError em cluster); `cli.mjs` spawn filho e quebra IPC do cluster | Novo bootstrap `scripts/scan-worker-cluster.mjs`: `import { register } from "tsx/esm/api"; register(); await import(...)` — mantém 4 instâncias × concurrency 5 no cluster |

**E2E pós-migração validado**: fake market → job `local-price-scan` consumido pelo cluster → `recorded: 2` (R$12,34, method PLAYWRIGHT_STEALTH) → re-scan dedup (`dup: 2`) → séries visíveis em `/api/price-history`. Scheduler social visível (`social-scan-cron`, next ok). 8 processos online (api + 4×scan cluster + route + social + instagram-service).

---

## 6.15b Stress cluster scan-worker (#30)

**Problema (roadmap pendência):** validar 4×cluster / até 20 jobs simultâneos "num scan real com muitos produtos". O `stress-test-24h.sh` só **amostrava** `/api/status` — não enfileirava carga.

**Risco de lock descoberto:** estratégia de scrape tem `timeoutMs = 90_000` (`scraper.ts:620`) mas o worker usava `lockDuration: 65_000` + `maxStalledCount: 1` → sob carga, lock podia expirar antes do fim de uma estratégia → stalled + re-delivery + falha.

**Mudanças:**
| Arquivo | Change |
|---|---|
| `src/workers/scanWorker.ts` | `lockDuration: 120_000`, `stalledInterval: 60_000` (cobre 90s + margem); comentário #30 |
| `scripts/stress-cluster-20.sh` | **novo** — enfileira N=20 `POST /api/scrape`, amostra filas Redis + workers pm2, gera `RELATORIO_TESTE_CLUSTER.md` (APROVADO/REVISAR) |
| `README.md` | lock documentado 120s/60s |

**Uso (VPS / stack completa):**
```bash
# pré: Redis + pm2 start ecosystem + API :3001
bash scripts/stress-cluster-20.sh
# opcional (retries attempts:3 podem segurar delayed ~2min):
N_JOBS=20 TIMEOUT_S=600 bash scripts/stress-cluster-20.sh
```

**Critérios de aprovação (relatório):**
- 4× `sentinela-scan-worker` online
- `count_ids_in_zset`: jobs nossos em completed+failed == N_JOBS (pending=0)
- `stalled_hits=0` no log
- API 200 em todas as amostras markadas (`^SAMPLE`)

**Validação nesta sessão:** `npx tsc --noEmit` → 0 erros.

**Bug de métrica do script (corrigido):** a 1ª execução gerou `REVISAR` só por `qlen` errado — `completed`/`failed`/`delayed` são **ZSET** (BullMQ) mas o script chamava `LLEN`, e `redis-cli` imprime `WRONGTYPE` no **stdout** com exit 0 (o `2>/dev/null` não ajuda). Havia ainda case-mismatch: comparava `[ "$op" = "zcard" ]` mas os call sites passavam `ZCARD` → caía no ramo `LLEN` também para `delayed`. Fix: `qlen` detecta o tipo via `TYPE` (list→LLEN, zset→ZCARD, none→0) e valida saída numérica; contagem final por `ZSCORE` dos job IDs enfileirados (`count_ids_in_zset`). Mesmo fix de ZCARD aplicado em `stress-test-24h.sh`.

**Evidência 1ª execução (carga/estabilidade):** 20/20 enfileirados (ids 372–391); pico `active=17`; `workers=4` em todas as amostras; **0** menções a stalled; API `status=ok` em todas as amostras markadas; jobs: 2 completed + 18 failed com `failedReason = Failed to scrape product data from all strategies` (URLs fake de stress — **não** stalled).

**Evidência 2ª execução (script corrigido, 2026-09-23 16:04–16:14):** métricas numéricas limpas no log; drain até `wait=active=0` com `delayed` só de backoff; **veredito APROVADO** em `RELATORIO_TESTE_CLUSTER.md` (4 workers, todos os jobs nossos finalizados via `count_ids_in_zset`, `stalled_hits=0`, API 100% nas amostras markadas). `npx tsc --noEmit` → 0.

## 6.12 Status da FASE 12 (concluída) — Agendador do scan de preços locais + auditoria de código

Três frentes: (1) o **scan de preços locais recorrente** como repeatable job do BullMQ; (2) **auditoria de alta prioridade** (domínios confiáveis, modelos de IA, catchup assíncrono); (3) pequenos fixes de robustez.

### 6.12.1 Agendador do scan de preços locais (repeatable job)

| Arquivo | Papel |
|---|---|
| `src/database/schema.sql` + `src/database/db.ts` | Setting `local_price_scan_interval_ms` default 6h; migração defensiva em bancos antigos (INSERT se ausente) |
| `src/queue/schedulers.ts` | `registerLocalPriceScanScheduler`/`unregisterLocalPriceScanScheduler` (upsert idempotente do `local-price-scan-cron` na scan-queue, name `local-price-scan`); `listScheduledJobs` passou a expor `id` corretamente (BullMQ v6 usa `key`, não `id` — bug herdado da FASE 9 que deixava `scheduler:null` no retorno) |
| `server.ts` | Registro no boot; `GET/PUT /api/local-price-scan/settings`; `/api/status` expõe `nextLocalPriceScanMinutes`; `PORT` passou a ler `process.env.PORT` (era hardcoded 3000 — bug descoberto no teste) |
| `src/components/LocalTab.tsx` | Seletor de frequência (1h/6h/12h/24h) + indicador "PRÓXIMO SCAN" no header de ESTABELECIMENTOS (refresh 60s) |

**Testes realizados (2026-09-15):**
- ✅ Boot: `[scheduler] scan de preços locais registrado: a cada 360min`
- ✅ `GET /api/local-price-scan/settings` → `{intervalMs, scheduler:{id:"local-price-scan-cron", every, next}}`
- ✅ `PUT` para 1h → 3600000 e scheduler re-registrado; revert para 6h persistido
- ✅ Repeat key no Redis: `bull:scan-queue:repeat:local-price-scan-cron`
- ✅ Tick imediato gerou job na fila `wait` com data `{"type":"local-price-scan"}` (mesmo padrão FASE 2/9)
- ✅ `/api/status` → `redis.connected` e `nextLocalPriceScanMinutes`
- ⚠️ Porta 3000 estava ocupada por outro projeto (`afiliados-bot`); teste feito na 3150 via `PORT` — fix `PORT = Number(process.env.PORT) || 3000`

### 6.12.2 Auditoria de alta prioridade

1. **Domínios confiáveis unificados** — `src/lib/trustedDomains.ts` (`TRUSTED_DOMAINS` + `isTrustedHost`). Removidas listas duplicadas/divergentes de `server.ts` (2x compare synchronous fallback) e `scanWorker.ts` (`handleCompare`); **shopee/aliexpress/casasbahia/americanas** deixaram de constar (inconsistentes com o resto).
2. **Modelos de IA centralizados** — `src/lib/aiModels.ts` (`TEXT`/`URL_CONTEXT`/`VISION`/`LOCAL_LLM`). Substituídos strings hardcoded (`gemini-3.6-flash`, `gemini-2.0-flash`, `qwen`) em `server.ts`, `scanWorker.ts`, `gemini.ts`, `scraper.ts`, `socialParse.ts`, `socialWorker.ts`.
3. **`handleScanAll` sem Gemini obrigatório** — trocado `scrapeProductInfo()` (só Gemini urlContext, exigia API key e pulava o produto sem ela) por `advancedScrape()` (multi-estratégia). Worker grava `last_scan_timestamp` ao concluir.
4. **Catchup assíncrono** — `checkAndRunCatchupScan` (server.ts) deixou de scrapar síncrono no boot (travava o event loop; explicava marca de 5s por produto no boot) e agora enfileira `scan-all` no BullMQ com `triggeredBy:"catchup"` (adicionado ao discriminador em `types.ts`); espera até 3s o Redis conectar.
5. **Status Redis** — `/api/status` expõe `redis.connected`; `App.tsx` alerta via toast quando Redis cai (todos os workers param).

**Validação**: `npm run lint` (tsc 0 erros), `npm run build` OK.

**Nota FASE 12→13 (auditoria):** `scrapeProductInfo` era o único uso de `gemini.ts` — **arquivo inteiro removido** (zero importers). `syncPriceHistory` virou **incremental** (ver FASE 13). Próximos naturais: revisão de segurança, dedup/mescla de estabelecimentos, WhatsApp real (sessão).

## 6.13 Status da FASE 13 (concluída) — Auditoria: histórico incremental + código morto

1. **`ProductRepository.syncPriceHistory` incremental** — antes: `DELETE` de todo o histórico + reinsert em **cada** `save()` (reescrevia todas as linhas a cada scan de centenas de produtos). Agora: insert **só dos pontos ausentes** (chave `price|date`), dentro de transação. Idempotente e mais barato; comportamento equivalente pois `priceHistory` só recebe append nos fluxos atuais.
2. **`src/lib/gemini.ts` removido** — o módulo inteiro era código morto (`scrapeProductInfo` não tinha mais importadores desde a FASE 12; a estratégia Gemini URL-context vive em `scraper.ts` via `AI_MODELS.URL_CONTEXT`).

**Validação (teste isolado em DB temporário, sem tocar no DB real):**
- ✅ save #1 (2 pontos) → `price_history` 2 linhas
- ✅ save #2 (+1 ponto) → 3 linhas (só delta inserido)
- ✅ save #3 com mesmo array → 3 linhas (**idempotente**, 0 duplicados por `price|date`)
- ✅ `npm run lint` (tsc 0 erros) e `npm run build` OK
- ✅ Produto de teste removido após o teste

### 6.13.2 Auditoria de segurança (exposição à rede)

**Problemas identificados:**
- `app.listen(PORT, "0.0.0.0")` — painel + API (sem autenticação) expostos à LAN; `/api/data` devolve **segredos em claro** (`gemini_api_key`, `gmail_pass`, `telegram_token`, `discord_webhook`) para qualquer página/processo com acesso à porta.
- Sem checagem de `Host` header → vulnerável a **DNS rebinding** (domínio externo resolvendo para 127.0.0.1 leria `/api/data`).
- Redis: `bind *` mas `protected-mode yes` (aceitável — loopback efetivo para hosts externos; documentado, não alterado pois é infra externa ao repo).

**Correções (`server.ts`):**
- `app.listen(PORT, BIND_HOST)` com `BIND_HOST = process.env.BIND_HOST || "127.0.0.1"` — exposição LAN desligada por padrão.
- Middleware de **Host allowlist** antes de todas as rotas: aceita `localhost`, `127.0.0.1`, `[::1]` (+ `BIND_HOST` explícito); qualquer outro Host → **403**.

**Decisão documentada:** manter os segredos em `GET /api/data` foi **intencional** — o frontend pré-preenche o form de settings com os valores completos e os botões de teste (Discord/Telegram/Gmail) precisam deles. Com bind localhost + Host-check, o surface de exposição fica restrito à própria máquina (mesma confiança de um gerenciador de senhas de desktop).

**.env.example** ganhou `BIND_HOST=127.0.0.1` documentado (use `0.0.0.0` deliberadamente para expor à LAN).

**Validação E2E (pm2, porta 3001):**
- ✅ `Host: localhost:3001` → 200, `redis: true`
- ✅ Host default `127.0.0.1:3001` → 200
- ✅ **DNS rebinding** (`Host: evil-ator.example.com`) → **403**
- ✅ IP da LAN (`192.168.1.195:3001`) → **sem resposta** (bind loopback)

### 6.13.3 Toggle Instagram em runtime (sem .env) + dedup/mescla de estabelecimentos

**Instagram — `user_settings.instagram_enabled` (precedência sobre `.env` legado):**
- Novo helper `src/lib/instagramEnabled.ts` (`isInstagramEnabled`): lê `user_settings.instagram_enabled`; se ausente, preserva comportamento legado (`INSTAGRAM_ENABLED=true`). Default continua **desligado**.
- Aplicado em: gate de boot do microserviço (`startInstagramService`), `health`, `login` e `scan` (todos respondem **403** quando desligado), e no worker `handleInstagramStoriesScan` (skip).
- Novo `GET/POST /api/social/instagram/toggle` (POST liga → inicia serviço; desliga → `stopInstagramService`).
- UI (SocialTab): botão **ATIVAR/DESATIVAR** no header do Instagram + status "● DESLIGADO"; botões LOGIN/SCAN desabilitados com o módulo off; corpo mostra aviso de desativado.

**Dedup/mescla de estabelecimentos:**
- `EstablishmentRepository.findDuplicatePairs()`: detecta pares por **nome normalizado** (lowercase + sem acentos + espaços colapsados), **OSM id** e **WhatsApp** (dígitos); match mais forte (osm > whatsapp > nome) vence por par.
- `EstablishmentRepository.merge(keepId, removeIds)`: transação que reponta `price_observations`, `promotions` e `route_stops` → sobrevivente, exclui duplicado(s) e **dedup limpeza pós-mescla** (promoções e observações exatamente iguais no alvo: `MIN(rowid)` por chave).
- Endpoints: `GET /api/establishments/duplicates` e `POST /api/establishments/merge`.
- UI (LocalTab): painel **DUPLICADOS SUSPEITOS (N)** com motivo + botão **MESCLAR** (confirma via `window.confirm`; toasts com contadores repontados/deduplicated).

**Validação E2E (server real, porta 3101, DB temporário):**
- ✅ 6 estabelecimentos seed → detecção de **3 pares** corretos (nome acentuado, OSM 123456, WhatsApp com símbolos `(55)11 99999-8888`)
- ✅ Merge `est-b → est-a`: repontou 2 obs + 2 promoções, excluiu o duplicado, dedup 1 promo + 1 obs (idênticas)
- ✅ Pós-merge: 5 estabelecimentos, `est-b` ausente, obs/promoções todas em `est-a`
- ✅ Toggle IG: GET default `false` → POST `true` → `true`; login/scan com toggle off → **403**; health off → `{enabled:false}`
- ✅ `npm run lint` (tsc 0 erros) e `npm run build` OK

### 6.13.4 WhatsApp real (sessão via whatsapp-web.js) — verificado, já completo

**Frentes C2 já implementadas e deixadas como estavam (não reescritas):**
- `src/social/whatsappSession.ts`: sessão com `LocalAuth` persistente + QR via `qrcode-terminal`; eventos `qr/authenticated/ready/auth_failure/disconnected`; listener `message_create` processa grupos (`@g.us`) e conversas diretas (`@c.us`), baixando mídia (flyers) via `downloadMedia`; `isWhatsappReady`.
- Endpoints: `GET/POST /api/social/whatsapp/toggle` (user_settings `whatsapp_enabled`), `GET /api/social/whatsapp/qr` (inicia sessão + QR), `GET /api/social/whatsapp/status`.
- **Monitoramento em tempo real** (sem scan manual): mensagens de grupo e diretas chegam via listener; imagens de flyer são enfileiradas em `social-capture` (channel whatsapp) e interpretadas por Gemini Vision.
- UI (SocialTab): toggle ATIVAR/DESATIVAR, status CONECTADO/DESCONECTADO, GERAR QR (renderiza imagem escaneável via lib `qrcode`).
- Deps `whatsapp-web.js` + `qrcode-terminal` + `qrcode` já no package.json. Riscos de banimento documentados no header do módulo e no aviso do rodapé da aba.

---

## 6.15 Instagram — dono único PM2 (#28)

**Problema (roadmap pendência):** dois donos da porta 8721 — app PM2 `sentinela-instagram-service` **e** `spawn(uvicorn)` dentro do `server.ts` → EADDRINUSE em produção; toggle da UI só matava o filho do API, não o processo PM2.

**Decisão (VPS):** **PM2-only**.

**Mudanças:**
- `server.ts`: removidos `instagramProcess`, `spawn` e exit-hooks (`SIGINT`/`SIGTERM`/`exit`) que derrubavam o serviço no shutdown da API.
  - `writeInstagramEnvFile()` → grava `python_instagram/.ig.env` (mode 0600, gitignored) a partir de `ig_username`/`ig_password`
  - `startInstagramService()` → `pm2 startOrReload ecosystem.config.cjs --only sentinela-instagram-service`
  - `stopInstagramService()` → `pm2 stop sentinela-instagram-service`
  - `syncInstagramWithPm2()` no boot: enabled+creds → start; senão → stop (espelha toggle)
  - login: checagem `!instagramProcess` → `isInstagramPm2Online()` (`pm2 jlist`)
- `ecosystem.config.cjs`: `loadInstagramEnv()` lê `.ig.env` no `env` do app.
- `.gitignore`: `python_instagram/.ig.env`
- Docs: pendência **Instagram × PM2** marcada RESOLVIDA em `roadmap.md`/`README.md`; `INSTRUCOES_LOCAL.md` corrigido `crimson-*` → `sentinela-*`.

**Fluxo painel:** salvar credenciais → `.ig.env` + `startOrReload`; toggle off → `pm2 stop`; toggle on → `startOrReload`; login offline → start + wait 3s.

**Não fazer:** API não deve matar o Instagram em SIGTERM — o dono é o PM2.

**Validação:** `npx tsc --noEmit` → 0 erros. Smoke: `pm2 status` (8 processos), toggle IG on/off muda status do app.

---

## 6.14 Status da Tarefa #27 (concluída) — Normalization util

Consolidação de regras de normalização que estavam **duplicadas** em 2+ lugares, no padrão FONTE ÚNICA já usado por `url.ts` / `units.ts` / `trustedDomains.ts`.

### Utils novos (`src/lib/`)

| Arquivo | Funções | Substituiu |
|---|---|---|
| `text.ts` | `normalizeText`, `splitCsv`, `slugify` | 5 cópias de `normalize()` (`socialParse`, `localInsights`, `routeOptimizer`, `establishmentRepository` + alias público) |
| `itemMatch.ts` | `promotionMatchesItem` | 2 cópias **byte-idênticas** em `localInsights` e `routeOptimizer` |
| `datetime.ts` | `sqlUtcToDate`, `formatLocalDateTime` | fix de fuso UTC SQLite → Date local (antes inline/inconsistente) |
| `price.ts` | `isValidPrice`, `sanitizePrice`, `isScientificNotation`, `parseBrazilianPrice` | movidos de `scraper.ts` + 2ª cópia de `parseBrazilianPrice` em `store-handlers.ts` |
| `url.ts` (estendido) | `ensureHttps`, `isSearchUrl` | bloco ad-hoc em `server.ts` + `scraper.ts` + regex inline em `App.tsx` |
| `cep.ts` (estendido) | `cleanCep`, `isValidCep` | `replace(/\D/g)` em 5 pontos (UI + MapPicker + lookup) |

### Consumidores atualizados

- **Text/match**: `socialParse.normalize` → alias de `normalizeText`; `establishmentRepository.normalizeName` → `normalizeText`; `localInsights`/`routeOptimizer` importam `promotionMatchesItem` de `itemMatch.ts`.
- **Datas**: `TriggersTab` (fire log **e** `lastFiredAt` — este último estava **sem** fix de fuso) + `NotificationsTab` usam `formatLocalDateTime`.
- **Preço**: `scraper.ts` e `store-handlers.ts` importam de `price.ts`; `scraper` re-exporta `isValidPrice`/`sanitizePrice`/`isScientificNotation` p/ consumidores legados (`localPriceScrape` migrou para `price.ts`).
- **URL**: `server.ts` (`POST /api/scrape`), `scraper.advancedScrape`, `App.tsx` (aviso de URL de busca) usam `ensureHttps`/`isSearchUrl`.
- **CEP**: `LocalTab`, `MercadoTab`, `MapPicker` usam `cleanCep`/`isValidCep`.
- **CSV**: `socialWorker` usa `splitCsv` para channels e keywords de trigger.

### Fora de escopo (deliberado)

- Cópias de `isValidPrice`/`parseBrazilianPrice` **dentro de strings `page.evaluate`** em `store-handlers.ts`/`scraper.ts` — contexto do browser não importa módulos; deixadas como estão (comentário de intencionalidade).
- `compare.normalize` mantido com regra própria (preserva `_` e trata `-`/`/` de forma distinta de `normalizeText`) — unificação mudaria fuzzy de produtos e-commerce.
- `fmtBRL`/`apiJson`/`newId` (cosmético de UI, não normalização de dados).
- CHECK de `unit` no `schema.sql` (minúsculo vs maiúsculo de `units.ts`) — investigar DB real à parte.

### Validação

- ✅ `npx tsc --noEmit` → **exit 0**
- Smoke: imports sem duplicação de módulo (`price`/`text`/`itemMatch`/`datetime` puros, sem estado)

---

## 6.16 Doc VPS + checklist E2E (#31 — FASE 16 bloco A)

**Problema (roadmap FASE 16, "Segundo plano / VPS"):** o produto deve rodar **headless em VPS** e a fase só fecha com **validação ponta a ponta em VPS** + **documentação de setup**. Até #30 a evidência de carga era local; não havia runbook único de bootstrap, health checks nem checklist E2E.

**Escopo de #31 (docs, sem mudança de runtime):**

| Arquivo | Change |
|---|---|
| `GUIA_VPS.md` | **novo** — arquitetura 8 processos, bootstrap Ubuntu/Debian, matriz `.env`, produção vs dev, `BIND_HOST`/túnel SSH, health checks, checklist E2E **Tier A/B/C**, stress na VPS, backup/rollback, troubleshooting |
| `README.md` | índice de documentos + ponte "Verificação" → GUIA_VPS; pendência #31 marcada RESOLVIDA |
| `roadmap.md` | pendência #31; FASE 16 "Segundo plano / VPS" aponta GUIA_VPS + §6.16; gate final = executar checklist **em VPS real** |
| `INSTRUCOES_LOCAL.md` | fix tabela PM2: `crimson-*` → **`sentinela-*`** (contradizia `ecosystem.config.cjs`; §6.15 alegava o fix mas o arquivo ainda estava errado) |
| `DIAGNOSTICO.md` | esta seção (§6.16) |

**Decisões documentadas (não novas de código):**
- Processos alvo: `sentinela-api` + `sentinela-scan-worker`×4 + `route` + `social` + `instagram-service` = **8**
- `USER_DATA_PATH=~/.config/crimson-sentinel` obrigatório (anti split-brain de `crimson.db`)
- `BIND_HOST=127.0.0.1` default; acesso remoto via **SSH tunnel**; aviso: `/api/data` expõe segredos — não expor sem auth
- `ecosystem` ainda `NODE_ENV=development` + `npm run dev` — produção (`npm run build` + serve `dist/`) documentado como opcional deliberado, **sem** alterar ecosystem neste commit
- Instagram PM2-only (#28); credenciais em `.ig.env`

**Checklist E2E (resumo — detalhe em GUIA_VPS §7):**
- **A (sem segredo):** Redis PONG · lint 0 · 8/8 pm2 · `/api/status` + 4 crons · IG health · social capture dedup · `stress-cluster-20` → APROVADO
- **B (rede, sem API key):** fake-market local-price-scan (`recorded:2` → dup → history) · discover Overpass · rota OSRM
- **C (segredos):** Gemini `method: gemini` (#29) · scrape vitrine · notificações · IG login · WhatsApp QR

**Gate FASE 16 (fora deste commit):** executar Tier A–C **na VPS real** e anexar evidência (saída pm2, `/api/status`, relatório stress da VPS).

**Validação #31:** `npx tsc --noEmit` → 0 erros; docs linkam `GUIA_VPS.md`; nomes de processo `sentinela-*` coerentes com `ecosystem.config.cjs`.

---

## 6.17 market-handlers + fallback sem price_url (#32 — FASE 16 bloco B)

**Problema (roadmap FASE 16, "Sites dos comércios"):** estabelecimentos **sem `establishments.price_url`** eram descartados em silêncio no `handleLocalPriceScan` (`filter(e => e.priceUrl)` no bulk + `if (!est.priceUrl) continue`) → toast "0 ERROS" enganoso. `chain` já existia no schema/OSM (`tags.brand`) mas não havia UI de edição nem registry por rede; `handleLocalPriceScan` **não passava** Serper/Tavily → SEARCH_VERIFY morto no caminho local.

**Escopo de #32 (cascade 3-tier, MVP search só com `establishmentId` explícito):**

| Tier | Condição | Resultado |
|---|---|---|
| **1 — Search** | handler resolve (chain/nome) **e** (Serper\|Tavily) **e** (NVIDIA\|Gemini) | query `«item» «rede» preço` → snippet → extrai preço → `price_observations` `source:"scraping"` (dedup/flash iguais) |
| **2 — Social** | handler/chain mas sem keys ou sem preço válido | `socialDependent: 1`, **sem** row, **não** conta em `errors` |
| **3 — Skip** | sem priceUrl, sem chain/handler | `socialDependent: 1` + reason (1 outcome por est., não por item) |

**Arquivos:**

| Arquivo | Change |
|---|---|
| `src/lib/market-handlers.ts` | **novo** — `MarketHandler`, seed (tatico, bretas, carrefour, pao-de-acucar, assai, atacadao), `resolveMarketHandler`, `buildMarketSearchQuery`, `searchMarketPrice` (Tavily→Serper + NVIDIA→Gemini) |
| `src/lib/localPriceScrape.ts` | cascade tiers 1–3; status `"social-dependent"`; counter `socialDependent` + `socialReason`; apiKeys `+ serper/tavily` |
| `src/workers/scanWorker.ts` | keys `serper/tavily` (profile \|\| `process.env`, padrão `/api/status`); remove `continue` em `!priceUrl` (cascade interna); return `+ socialDependent`; Overpass update: `brand` → `chain` se vazio |
| `src/queue/types.ts` | comentário: price_url **ou** market-handler |
| `MercadoTab.tsx` | campo **REDE / CHAIN** no form; toast `SOCIAL {n}` |
| `LocalTab.tsx` | toast `SOCIAL {n}` |
| `GUIA_VPS.md` | Tier B7: est. com chain sem price_url + keys → observação; sem keys → `socialDependent≥1` |
| `roadmap.md` / `README.md` | pendência #32 RESOLVIDA; Sites dos comércios aponta §6.17 |
| `DIAGNOSTICO.md` | esta seção (§6.17) |

**Decisões documentadas:**
- Bulk (`establishmentId` ausente) **não** roda search (custo por item×est); continua `filter(priceUrl)` + log
- Cron sem `profileId` → keys via `process.env.SERPER_API_KEY` / `TAVILY_API_KEY`
- `source` continua `"scraping"` + `notes=query` (sem union/schema novo)
- Tier 2/3 **não** inflam `errors` (evita toast enganoso "N ERROS")
- Seed mínimo de redes; expandir conforme OSM/UI

**Validação #32:** `npx tsc --noEmit` → 0 erros; regressão fake-market com `price_url` inalterada; est. com chain sem priceUrl + keys → grava observação; sem keys → `socialDependent≥1`, errors estáveis.

---

## 6.18 bulk/cron market-search (#33 — FASE 16 bloco B)

**Problema:** #32 deixou o **bulk** (`establishmentId` ausente, incl. cron `local-price-scan-cron`) só em `filter(e => e.priceUrl)` — redes sem URL nunca entravam no scan agendado; FASE 16 passo 2 ("sistema varre fontes") falhava em segundo plano. Decisão documentada em §6.17 ("bulk não roda search") estava correta para custo aberto; #33 reabre **só com keys + cap**.

**Escopo de #33:**

| Change | Detalhe |
|---|---|
| Bulk inclui só-chain | Se `(Serper\|Tavily)` **e** `(NVIDIA\|Gemini)`: est. **sem** `priceUrl` que `resolveMarketHandler(chain\|name)` entram nos `targets` |
| Cap de custo | **`MARKET_SEARCH_BULK_MAX = 8`** est. só-chain por run (slice do registry; evita N×items Serper no cron) |
| Sem keys | Bulk continua **só** `price_url` (comportamento #32 preservado) |
| Filtro raio | Aplica-se **depois** de montar `withUrl + chainOnly` (mesmo centro/raio) |

**Arquivos:**

| Arquivo | Change |
|---|---|
| `src/workers/scanWorker.ts` | import `resolveMarketHandler`; branch bulk com `canMarketSearch` + `MARKET_SEARCH_BULK_MAX` |
| `src/queue/types.ts` | comentário: bulk = price_url + até 8 só-chain se keys |
| `GUIA_VPS.md` | Tier **B8**: bulk com keys → est. chain entram; sem keys → só price_url |
| `roadmap.md` / `README.md` | pendência #33 RESOLVIDA |
| `DIAGNOSTICO.md` | esta seção (§6.18) |

**Decisões:**
- **Reversão parcial** de §6.17 "bulk não roda search": só com keys + cap 8 (não ilimitado)
- Cron sem `profileId` → keys via `process.env.SERPER_API_KEY`/`TAVILY_API_KEY` (já em #32)
- Seed de redes **não** expandido neste commit (6 do #32; expandir conforme OSM/UI)
- Proveniência continua `source:"scraping"` + `notes=query`

**Validação #33:** `npx tsc --noEmit` → 0; bulk **sem** keys → targets só com price_url; bulk **com** keys → log `+N est. só-chain (cap 8)`; raio ainda filtra.

---

## 6.19 bridge social → price_observations (#34 — FASE 16 bloco B)

**Problema (roadmap FASE 16, Stories/WhatsApp):** linhas da tabela dizem **"vira/→ observação local"**, mas os 3 caminhos do `socialWorker` só gravavam **`promotions`** — zero `PriceObservationRepository`. Insights, rota, histórico de preços e flash leem **`price_observations`** (com `shoppingListItemId`); promoções sociais ficavam “cegas” nesses consumidores.

**Escopo de #34 (dual-write):**

| Change | Detalhe |
|---|---|
| Dual-write | Grava Promotion **e** Observation (não substitui) |
| Bridge independente | Roda mesmo se `isDuplicatePromo` → true (dedup só na obs: Δ&lt;0,01 no par item+est) |
| Match de item | `promotionMatchesItem` (#27); 1 obs por item casado; **sem match → `no-item`** (linha sem item é invisível p/ insights/rota) |
| `source` | Canal (`whatsapp`/`instagram`/`telegram`); union + `"telegram"` |
| Flash | Paths A/C (capture/grupos) via `isFlashPrice` + `createFlashPromotion`; Stories (B) mantém `isFlash` hardcoded na promo, **sem** 2ª promo flash |
| `validUntil` | +24h (espelha scrape; consumidor atual não filtra) |
| Backfill | **não** — promoções antigas não migradas |

**Arquivos:**

| Arquivo | Change |
|---|---|
| `src/lib/socialToObservation.ts` | **novo** — `matchItemsForPromo`, `bridgePromoToObservations`, `BridgeCounters` |
| `src/lib/localPriceScrape.ts` | exportar `isDuplicateObservation` |
| `src/workers/socialWorker.ts` | bridge nos 3 `PromotionRepository.save` (A capture / B stories / C grupos); contadores `bridged`; flash só A/C |
| `src/types.ts` | union `PriceObservation.source` + `"telegram"` |
| `roadmap.md` / `README.md` | pendência #34; linhas Stories/WhatsApp → FEITO (#34) |
| `DIAGNOSTICO.md` | esta seção (§6.19) |

**Decisões documentadas:**
- Dual-write (promo **e** obs); `min(obs, promo)` em insights/rota é idempotente
- Sem item → skip (não cria obs órfã)
- Bridge **antes** do skip de `isDuplicatePromo` (backfill se promo já existia)
- Stories: bridge com `observedAt=st.taken_at`, sem `createFlashPromotion` extra
- Sem backfill de promoções legadas

**Validação #34:** `npx tsc --noEmit` → 0; WhatsApp com item da lista → promo + obs `(item, est, price, source:"whatsapp")`; re-colar → 0 obs novas; promo sem item → `noItem≥1`; Stories → obs 24h.

---

## 6.20 sendWhatsappMessage lista+rota → operador (#35 — FASE 16 bloco B)

**Problema (roadmap FASE 16, passo 4 / linha WhatsApp):** FASE 16 previa "envia uma **cópia da lista + roteiro no WhatsApp** (além de Discord/Telegram/email)". A sessão `whatsappSession.ts` era **read-only** (leitura de grupos/conversas/flyers); não havia `sendMessage`, nem chatId do operador, nem compositor, endpoint ou botão. `client.sendMessage` não existia em nenhum lugar do `src/`.

**Escopo de #35 (envio dedicado, só operador):**

| Change | Detalhe |
|---|---|
| `sendWhatsappMessage(chatId, content)` | Mesmo singleton `sessionInstance` (API process); guards: sessão + `getState()==="CONNECTED"`; **bloqueia** `@g.us` / `broadcast`; exige `…@c.us` |
| `sendMessage` no `d.ts` | `whatsapp-web.d.ts` — declara `sendMessage` no `Client` |
| `buildRouteWhatsappMessage` | compositor puro (`src/lib/routeMessage.ts`): lista única por `stop.items` + paradas ordenadas (est, chegada, custo, movimento, endereço) + custos (compra/desloc/total) + veículo |
| `splitWhatsappMessage` | chunks ≤4000 chars (quebra em `\n` quando possível) |
| Endpoint `POST /api/routes/:id/send-whatsapp` | Guards: 403 toggle off · 400 sem/inválido chatId · 409 sessão · 404 rota; dinamica import da sessão; **nunca** roda no `routeWorker` (evita 2ª sessão LocalAuth) |
| `GET/POST /api/social/whatsapp/operator` | `user_settings.whatsapp_operator_chat_id`; normaliza dígitos → `…@c.us` |
| UI | LocalTab: botão **Send** no card da rota; SocialTab: input chatId na seção WhatsApp |
| Trigger | **só botão** — sem auto-send no worker |

**Arquivos:**

| Arquivo | Change |
|---|---|
| `src/social/whatsapp-web.d.ts` | `sendMessage(chatId, content): Promise<any>` |
| `src/social/whatsappSession.ts` | `sendWhatsappMessage` (+ guards) |
| `src/lib/routeMessage.ts` | **novo** — `buildRouteWhatsappMessage`, `splitWhatsappMessage` |
| `server.ts` | `POST /api/routes/:id/send-whatsapp`; `GET/POST /api/social/whatsapp/operator` |
| `src/components/LocalTab.tsx` | state `sendingWaRouteId` + `sendRouteWhatsapp` + botão Send |
| `src/components/SocialTab.tsx` | state/handlers/input chatId operador |
| `src/database/schema.sql` | default `whatsapp_operator_chat_id` |
| `DIAGNOSTICO.md` | esta seção (§6.20) |
| `roadmap.md` / `README.md` | pendência #35; linha WhatsApp → FEITO (#35) |

**Decisões documentadas (aprovadas pelo usuário):**
1. **Só `@c.us`** — função e endpoint rejeitam `@g.us`/broadcast
2. Mesmo `sessionInstance` singleton **somente no processo da API**; **nunca** send no `routeWorker` (PM2 separado → 2ª sessão)
3. Setting `whatsapp_operator_chat_id` em `user_settings` (aceita dígitos → normaliza)
4. Trigger = **botão** no card da rota; **sem auto-send** no worker
5. Composer puro `buildRouteWhatsappMessage` (sem rede/sessão no módulo)
6. Guards HTTP: 403 disabled · 400 sem/inválido chatId · 409 sessão · 404 rota
7. Split se >~4000 chars (partes sequenciais na mesma sessão)

**Validação #35:** `npx tsc --noEmit` → 0; sessão ready + chatId `@c.us` → mensagem no operador; chatId `@g.us` → 400; toggle off → 403; sem QR → 409; mensagens `fromMe` **não** reaparecem no painel de leitura (`msg.fromMe` já filtrado).

---

## 6.21 múltiplas listas + export CSV/TXT com melhor preço (#36)

**Problema:** a lista de compras local era **uma única lista flat global** (`shopping_list_items` sem `list_id`) — não dava para ter "workstation" e "cozinha" separadas nem exportar "só a lista aberta". Export CSV/JSON existia mas **sem preço mais barato**, **sem TXT**, e o CSV não escapava vírgulas/aspas.

**Escopo de #36:**

| Change | Detalhe |
|---|---|
| Tabela `shopping_lists` | id, name; seed `list-geral` = "Geral" |
| Coluna `list_id` | `shopping_list_items.list_id` + migração `ensureColumn` + backfill NULL/'' → `list-geral` |
| Seletor de lista | MercadoTab: `<select>` + NOVA/EXCLUIR; ativa em `localStorage` `sentinela_active_shopping_list` |
| GET filter | `GET /api/shopping-list-items?listId=`; LocalTab e insights respeitam a lista aberta |
| CRUD listas | `GET/POST/DELETE /api/shopping-lists` (Geral não excluível; delete lista apaga itens) |
| Export | `GET …/export?format=csv\|txt\|json&listId=&prices=1` — default prices=1 para csv/txt |
| CSV com preços | colunas `bestPrice,bestStore,promotionApplied,withinTarget` + **escape RFC4180** |
| TXT | `item · qtd · melhor R$ X em loja (PROMO) · alvo` + total |
| Filename | nome da lista (slug) |
| Item novo | grava `listId` ativo |
| Insights | `GET /api/local-insights?listId=` |

**Arquivos:** `schema.sql`, `db.ts`, `types.ts`, `repositories/types.ts`, `shoppingListRepository.ts` (+ `ShoppingListsRepository`), `server.ts`, `MercadoTab.tsx`, `LocalTab.tsx`, docs.

**Decisões:**
- Lista ativa = `localStorage` (não settings) — UI-only, sem coupling com workers
- Export default **com preços** em csv/txt; json legado sem preços (`prices=0`)
- Delete lista = apaga itens da lista (confirm no client)
- Workers/rota/scan continuam `getAll()` global (rota pode misturar listas)

**Validação #36:** `npx tsc --noEmit` → 0; criar lista "cozinha" → só itens dela; trocar p/ "workstation" → outros itens; CSV/TXT traz melhor preço da lista aberta; nome com vírgula não quebra CSV.

---

## 6.22 Export da lista aberta na aba LISTS (#37)

**Problema:** a aba LISTS (Product Archives) não tinha export. O usuário esperava exportar **de dentro da lista clicada** (ex.: "workstation", "meu futuro pc") com **nome completo, link e valor mais baixo** — não da lista de compras do Mercado (#36).

**Escopo de #37 (client-side, sem endpoint novo):**

| Change | Detalhe |
|---|---|
| Botões no header | ao lado de COMPARAR TODOS / ADD LINK em `App.tsx` (lista aberta): **CSV**, **TXT**, **COPIAR** |
| Valor mais baixo | `min(currentPrice, comparisonResults[].price, priceHistory[].price)` |
| CSV | cabeçalho `nome,link,valor_mais_baixo,moeda` + escape RFC4180; download `<slug>.csv` |
| TXT | `LISTA`/`ITENS`/`TOTAL` + linhas `n. nome — R$ X.xx — url`; download `<slug>.txt` |
| COPIAR | mesmo texto do TXT → `navigator.clipboard.writeText` + toast + ícone Check 1,5s |
| Lista vazia | botões desabilitados + toast `LISTA VAZIA` |

**Arquivos:** apenas `src/App.tsx` (+ docs). Sem mudança de API/schema.

**Decisões:**
- Export **client-side** — produtos já vêm em `GET /api/data`; clipboard exige browser
- Domínio = **Product** (`product_lists`), **não** `ShoppingListItem` do Mercado
- Filename = slug do nome da lista (`replace(/[^\w\-]+/g,"_")`)

**Validação #37:** `npx tsc --noEmit` → 0; abrir lista → CSV/TXT só com itens dela (nome+link+menor preço); COPIAR → mesmo conteúdo no clipboard.

---

## 6.23 expandir seed de market-handlers (#38)

**Problema:** decisão aberta em §6.17/§6.18 — “seed de redes **não** expandido neste commit (6 do #32; expandir conforme OSM/UI)”. Com só 6 redes (tatico, bretas, carrefour, pao-de-acucar, assai, atacadao), a maioria dos `establishments` descobertos via OSM (`tags.brand` → `chain`) ou digitados na UI REDE caía no **Tier 3** (skip) e o Tier 1 search nunca rodava.

**Escopo de #38 (só registry + placeholder de UI):**

| Change | Detalhe |
|---|---|
| Seed `marketHandlers` | 6 → **31** entradas — nacionais (Extra, Ponto, Minasu, Mundial, Sam's Club, 7-Eleven…) e regionais (Zaffari/SC-RS, Bomboniere, Prezunic, Sendas/Fortaleza, Angeloni, Diana, Verdemar, Gbarbosa, Imperatriz, Bonanza, Parcela Amarela, Sonda…) |
| Matching | inalterado — `resolveMarketHandler` + `normalizeText` (aliases com ≥5 chars no includes bidirecional) |
| UI REDE | placeholder MercadoTab atualizado (lista de exemplos); hint `#32/#38` |
| Cascade/bulk | **sem mudança** — cap `MARKET_SEARCH_BULK_MAX = 8` continua (#33) |

**Arquivos:** `src/lib/market-handlers.ts`, `MercadoTab.tsx` (placeholder), docs.

**Decisões:**
- Redes escolhidas p/ cobertura OSM típica BR (GPA, Zaffari group, Sendas, Sul, Nordeste) — não é catálogo exaustivo; crescer via OSM/UI
- Sem alteração de custo: bulk continua cap 8/run; search explícito por `establishmentId` continua ilimitado (#32)
- `searchLabel` em pt para a query `«item» «rede» preço`

**Validação #38:** `npx tsc --noEmit` → 0; `resolveMarketHandler("Zaffari")` / `("Sendas")` / `("Extra")` → handler não-null; chains fora do seed → null (Tier 3).

---

## 6.24 boot crash list_id + open browser no listen (#39)

**Problema A (API não subia):** após `npm run build` + `pm2 restart`, `sentinela-api` entrava em crash-loop (`SqliteError: no such column: list_id` em `db.ts:44` → `server.ts:53`) e **nada escutava em :3001** — UI “não carregava”. Causa: `schema.sql` criava `CREATE INDEX ... shopping_list_items(list_id)` **antes** do `ensureColumn` migrar a coluna; em DB antigo, `CREATE TABLE IF NOT EXISTS` não altera a tabela existente → índice explode → processo morre antes do `app.listen`.

**Problema B (conveniência):** usuário quer o browser abrir sozinho quando o servidor fica online.

**Escopo de #39:**

| Change | Detalhe |
|---|---|
| Pré-migração em `getDb()` | Antes do `db.exec(schema)`: se tabela `shopping_list_items` existe → `ensureColumn product_id` + `list_id` + backfill `list-geral` |
| `ensureColumn` | Função movida para **antes** do schema (reuso); chamadas de list_id permanecem após (no-op seguro) |
| `openBrowserWhenReady(port)` | No callback `app.listen` (porta pronta): `xdg-open`/`open`/`start` → `http://localhost:PORT` |
| Guards open | `OPEN_BROWSER=false`/`0` desliga; Linux sem `DISPLAY`/`WAYLAND_DISPLAY` pula (headless/VPS); anti-spam **5 min** via marker `DATA_DIR/.last-open-browser` |
| ecosystem | `OPEN_BROWSER: "true"` no `sentinela-api` |

**Arquivos:** `src/database/db.ts`, `server.ts`, `ecosystem.config.cjs`, docs.

**Decisões:**
- Fix é **ordenação** no `getDb()` (não ALTER manual no shell) — API **e** workers (`scan-worker` etc.) usam o mesmo path
- Open browser só no **listen**, não no boot do módulo (evita abrir em crash)
- Anti-spam por mtime: PM2 restart em loop não abre 10 abas

**Validação #39:** `npx tsc --noEmit` → 0; `pm2 restart sentinela-api` → status online estável; `curl http://127.0.0.1:3001/` → 200; `GET /api/status` → 200; log `[open] navegador aberto` no desktop.

---

## 6.25 prioridade na lista de compras (#40)

**Problema:** a lista de compras (MERCADO) não tinha forma de destacar o que é urgente — tudo aparecia em ordem alfabética, sem hierarquia visual ou de exportação.

**Escopo de #40 (plano A+D aprovado):**

| Change | Detalhe |
|---|---|
| `schema.sql` | `priority TEXT CHECK (priority IN ('alta','media','baixa') OR priority IS NULL)` em `shopping_list_items`; **sem índice** (evita bug index-before-column do #39) |
| `db.ts` | `ensureColumn("shopping_list_items","priority","priority TEXT")` pós-schema (migra bancos antigos) |
| `types.ts` | `ShoppingListItem.priority?: "alta"\|"media"\|"baixa"\|null` |
| `repositories/types.ts` | Row + mapper com `priority` (normaliza para enum ou null) |
| `shoppingListRepository.ts` | Coluna no INSERT/UPDATE; `normalizePriority` (aliases high/medium/low/média); `ORDER BY CASE priority WHEN 'alta' THEN 0 WHEN 'media' THEN 1 WHEN 'baixa' THEN 2 ELSE 3 END, name` |
| `MercadoTab.tsx` | Select PRIORIDADE no form (—/ALTA/MÉDIA/BAIXA); badge colorido na linha (ALTA vermelho, MÉDIA âmbar, BAIXA azul); `priority` no payload do save |
| `LocalTab.tsx` | Indicador ▲/■/▼ nos chips de item da rota |
| `server.ts` | `normalizePriority` no POST `/api/shopping-list-items`; coluna `priority` no header e linhas do export CSV; ` \| pri {p}` no export TXT |
| Docs | §6.25 + hygiene: §6.7 FASE 7 → concluída; README "1–13" → "1–15"; pendência #40 em README/roadmap |

**Decisões:**
- Valores canônicos `alta`/`media`/`baixa` (pt-BR); `NULL` = sem prioridade (fim da lista)
- Ordem: alta → media → baixa → sem prioridade, desempate por `name`
- Sem `CREATE INDEX` em `priority` — coluna nova pós-schema, risco zero de crash do tipo #39
- Aliases de import aceitos (`high`/`medium`/`low`/`média`) via `normalizePriority`
- Prioridade é atributo do **item** (compartilhado entre listas que referenciem o mesmo id), não da lista

**Arquivos:** `schema.sql`, `db.ts`, `types.ts`, `repositories/types.ts`, `shoppingListRepository.ts`, `MercadoTab.tsx`, `LocalTab.tsx`, `server.ts`, docs.

**Validação #40:** `npx tsc --noEmit` → 0; criar item com `priority: alta` via POST → aparece 1º na lista; export CSV contém coluna `priority`; badge visível na UI MERCADO.

---

## 6.26 fix: timeout do TRACKING TARGETS + progresso real (não fake) (#41)

**Problema A — `ERRO: Job polling timed out`:** `addProduct` (modal ADD TRACKING TARGETS) usava `pollJob(..., 240_000)` — o menor timeout da fila scan. O job `scrape` pode legitimamente demorar 5–15+ min: cada estratégia tem timeout de 90s (`scraper.ts`), até ~9 estratégias em sequência, **3 tentativas** com backoff exponencial 30s/60s (`queues.ts`). Estado `delayed` (retry) era ignorado → frontend desistia aos 4 min com o worker ainda rodando.

**Problema B — barra travada em 99%:** o progresso do modal era **100% simulado no cliente** (elapsed / 75s de estimativa) com **cap duro em 99** (`Math.min(..., 99)`). Saturava em ~74s e ficava em 99% até o job acabar ou o timeout estourar. Worker (`handleScrape`) nunca chamava `job.updateProgress`.

**Escopo de #41:**

| Change | Arquivo | Detalhe |
|---|---|---|
| Timeout 600s | `App.tsx` (`addProduct`) | `pollJob(..., 2000, 600_000, "scan", onProgress)` — alinha com compare/Local/Mercado |
| `pollJob` onProgress | `App.tsx` | 6º parâmetro opcional; repassa `job.progress` a cada poll; timeout com hint de retry (`tentativa N/3, estado: delayed`) |
| Progresso real no worker | `scraper.ts` + `scanWorker.ts` | `ScrapeOptions.onProgress` → `job.updateProgress({ strategy, triedCount, totalStrategies, strategiesTried })` a cada estratégia |
| Remover simulação 99% | `App.tsx` | useEffect fake (estMs por estratégia + cap 99) **removido**; checklist dinâmico (9 estratégias mapeadas) |
| Barra de batch | `App.tsx` | `scrapeProgress.batchDone/batchTotal` (URLs concluídas no loop) + % da URL atual; label `N/M` + `% TOTAL` |
| Reset | `App.tsx` | Reset em `finally` e `cancelScrape` |

**Decisões:**
- Timeout **600s** (não 240s): mesmo budget dos demais fluxos scan; cobre 1 tentativa cheia + backoff
- Progresso **real** (worker), não timer fake — barra pode chegar a 100%
- Batch progress é contagem de URLs no loop do cliente (independente de worker)
- Com concorrência 2 URLs simultâneas, o % da URL atual é last-writer-wins (aceitável)
- Fora de escopo: mudar `attempts`/backoff BullMQ, timeout de AI insight (240s), cancelamento server-side

**Arquivos:** `src/App.tsx`, `src/lib/scraper.ts`, `src/workers/scanWorker.ts`, docs.

**Validação #41:** `npx tsc --noEmit` → 0; modal mostra `N/M` real + % de estratégias do worker; URL demorada não estoura toast em 4 min; timeout com retry exibe hint.

---

## 6.27 fix: orçamento de scrape + attempts 2 (timeout 600s ainda estourava) (#42)

**Problema (após #41):** usuário ainda viu `ERRO: Job polling timed out (retry, tentativa 2/3, estado: active)` + `2 TARGETS FAILED TO RESOLVE`, com espera longa e ~metade dos targets não salvos.

**Causa raiz:**
1. **1 tentativa do `advancedScrape` podia passar de 600s** — até 9 estratégias × 90s = **810s**, **sem orçamento total** no loop.
2. **BullMQ `attempts: 3`** (default da fila) + backoff 30s/60s → pior caso **~40 min** de vida do job.
3. Deadline do `pollJob` é **absoluto** (600s do início); `attemptsMade=2` + `active` = rodando a **3ª** tentativa; dica de UI mostrava `2/3` (off-by-one, `/3` hardcoded).
4. Timeout **não salva o produto** (o job pode completar depois — resultado órfão); batch **2 em 2 sequenciais** multiplica a espera.

**Escopo de #42:**

| Change | Arquivo | Detalhe |
|---|---|---|
| Orçamento **180s**/tentativa | `src/lib/scraper.ts` | `SCRAPE_BUDGET_MS=180_000`; quebra o cascade se estourar; estratégias caras puladas se restam &lt;45s (reserva p/ FETCH/GEMINI baratas); timeout por estratégia = `min(90s, restante)` |
| `attempts: 2` só scrape | `server.ts` (`POST /api/scrape`) | `queue.add(..., { attempts: 2 })` — pior caso `2×180+30 = 390s` **&lt; 600s** do poll |
| Poll de graça no timeout | `src/App.tsx` (`pollJob`) | 1 fetch extra após o deadline; se `completed`, **retorna o resultado** (evita órfão) |
| Dica de retry corrigida | `src/App.tsx` | `tentativa ${attemptsMade+1}/${maxAttempts}` (addProduct passa `maxAttempts=2`) |
| Docs | DIAGNOSTICO/README/roadmap | §6.27 |

**Decisões:**
- Budget **180s** (não subir timeout p/ 900s+): resolve a raiz sem o usuário esperar mais
- `attempts: 2` (não 1): ainda cobre 1 retry transitório; com budget, cabe no poll de 600s
- Reserva 45s para estratégias baratas no fim do cascade (FETCH/GEMINI costumam resolver HTML simples)
- Sites anti-bot (Shopee etc.) podem **ainda** falhar — toast será `Failed to scrape…` (falso real), não timeout eterno
- Fora de escopo: concorrência do batch (2→4), cancelamento server-side, mudar backoff global

**Arquivos:** `src/lib/scraper.ts`, `server.ts`, `src/App.tsx`, docs.

**Validação #42:** `npx tsc --noEmit` → 0; job difícil termina &lt; ~200s (failed ou completed); timeout (se ocorrer) exibe `tentativa N/2`; poll de graça captura completed tardio.

---

## 6.28 fix: Shopee/ML falhavam — NVIDIA 410 + Gemini 429 + SEARCH cedo (#43)

**Problema (após #42):** timeout sumiu, mas usuário ainda via `Failed to scrape product data from all strategies` + `2 TARGETS FAILED TO RESOLVE` em **Shopee/ML**. Kabum OK.

**Causa raiz (logs):**
1. **`deepseek-ai/deepseek-v4-flash-0731` → HTTP 410 Gone** — modelo morto; retries + `z-ai/glm-5.3-flash` **travava até o timeout de 90s** da estratégia → comia quase todo o budget de 180s.
2. **Gemini free tier 429** (limite **20 req/dia**) — `GEMINI_VISION` e `GEMINI_FALLBACK` retornavam null a cada job.
3. **Shopee/ML anti-bot** — body ~525 chars de placeholder; handler `name="" price=0`; genérico só `og:title` do site → NVIDIA/Vision não tinham o que extrair.
4. **`SEARCH_VERIFY` rodava por último** — budget já estourado (NVIDIA comeu 90s); sem `nameHint` caía no Gemini (429).

**Escopo de #43:**

| Change | Arquivo | Detalhe |
|---|---|---|
| NVIDIA fail-fast | `scraper.ts`, `market-handlers.ts`, `scanWorker.ts` | modelos sondados 2026-09-24: `z-ai/glm-5.3`, `openai/gpt-oss-20b`, `nvidia/nemotron-3-super-120b-a12b`; **410/404/timeout 30s → pula modelo** sem retry (`-0731`/`v4-flash` EOL desde ago/2026) |
| Gemini circuit 1h | `scraper.ts` | `noteGeminiQuotaBlock()` após 429; pula `GEMINI_VISION`/`GEMINI_FALLBACK`/grounding até 1h |
| Nome do slug da URL | `scraper.ts` | `extractNameFromUrl` — Shopee `-i.shop.item`, ML `/up/MLB…` → hint p/ busca |
| SEARCH_VERIFY **antes** de Vision/FETCH | `scraper.ts` | ordem: Playwright → **SEARCH** → NVIDIA → Vision → FETCH → Gemini; hint = DOM ∪ slug; 2ª busca `preço reais` se snippet sem `R$`; **NVIDIA (glm-5.3) primeiro**, regex fallback (1º resultado, descarta parcelas &lt;30% do máx, exige ≥R$20); nome do 1º título só se **overlap ≥2 com o hint** (senão usa o hint — evita artigo "Melhor X…") |
| Bot-wall no NVIDIA | `scraper.ts` | body &lt; 200 chars → aborta sem chamar LLM |
| Docs | DIAGNOSTICO/README/roadmap | §6.28 |

**Resultado smoke final (jobs 488 Shopee + 489 ML, cache limpo):** ambos `completed` 1ª tentativa via `SEARCH_VERIFY` + **NVIDIA `z-ai/glm-5.3`** — Shopee R$ 3.500 / ML R$ 222,73 (nome do 1º resultado); ~35-55s cada. (Jobs 482/486 anteriores já provaram regex fallback: 599 em ~27s.)

**Decisões:**
- Sem API pública Shopee/ML (testado: `90309999` / `403`) — busca web é o fallback realista
- Quota Gemini **não é bug nosso** (free tier 20/dia); circuito só evita desperdiçar budget
- `SEARCH_VERIFY` antes de LLM caro: se Serper/Tavily achar preço, nem tenta NVIDIA/Vision
- Fora de escopo: upgrade de plano Gemini, cookies de sessão Shopee, mudança de start command

**Arquivos:** `src/lib/scraper.ts`, `src/lib/market-handlers.ts`, `src/workers/scanWorker.ts`, docs.

**Validação #43:** `npx tsc --noEmit` → 0; Shopee/ML → completed via SEARCH ou falha rápida &lt;90s com motivo claro; NVIDIA não gasta 90s em modelo 410; Gemini 429 pula em &lt;1s.

---

## 6.29 fix: alerta falso no Telegram (preço de frete/parcela ≤ alvo) (#44)

**Problema:** Telegram: "Pasta Térmica GD900 atingiu o preço-alvo! R$ 7,18 ≤ R$ 20" — página real R$ 26,79. Mesmo caso "Kit 3 Fans R$ 9,62".

**Causa raiz (3 camadas):**
1. Prompt do NVIDIA no `SEARCH_VERIFY` pedia *"MENOR preço"* → extraía frete/parcela/preço-por-unidade do snippet (ex.: R$ 7,18).
2. O merge **detectava** o lixo (`⚠️ Merged price ... unrealistic` — `isPriceRealistic` exige ≥R$ 15 p/ pasta térmica) mas o **fallback final (`scraper.ts`) só validava o nome** e devolve+cachava o preço irreal mesmo assim.
3. `scanWorker` comparava `currentPrice <= targetPrice` **sem nenhuma validação** → alerta.

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| `isPriceRealistic` exportado | `scraper.ts` | passa a ser FONTE ÚNICA também p/ o worker |
| Fallback do scraper rejeita preço irreal | `scraper.ts` | se `!isPriceRealistic` → `return null`, **sem cache** (em vez de devolver lixo) |
| Gate no worker (2 call sites) | `scanWorker.ts` | `handleScrape` + `handleScanAll`: preço irreal → **não persiste**, não empurra histórico, **não alerta**, não dispara flash; log `preço irreal descartado` |
| Prompt NVIDIA | `scraper.ts` | "preço à vista do produto — ignore frete, parcelas, preço por unidade/grama" + `isPriceRealistic` na aceitação |
| Reparo de dados | DB | `o8k1d3` → `current_price=26.79`; entrada 7.18 apagada do `price_history` |
| Higiene | `.gitignore` | `.last-open-browser` (artefato de runtime) removido do repo |

**Validação #44:** `tsc` → 0; re-scrape da URL da pasta (job 500, cache limpo) → **nenhum alerta**, DB manteve R$ 26,79, `price_history` sem 7,18 (ML segue em bot-wall → scrape falha com motivo claro em vez de preço falso — comportamento desejada).

**Arquivos:** `src/lib/scraper.ts`, `src/workers/scanWorker.ts`, `.gitignore`, docs.

---


## 6.30 feature: ordenação dos produtos na aba LIST — preço, A–Z, ordem manual ↑↓ (#45)

**Pedido:** ordenar os itens das **listas da aba LIST** (não a aba Mercado): menor→maior preço, vice-versa, alfabética e **ordem de compra manual**.

**Histórico:** a primeira implementação (`c2eb014`) foi feita na aba Mercado por engano → **revertida** (`dee1860`) e refeita no lugar certo.

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| Coluna `sort_order INTEGER` em **products** | `schema.sql`, `db.ts` (`ensureColumn`), `productRepository.ts` (INSERT + SET — sem isso não grava) | posição manual |
| Ordenação client-side | `App.tsx` (`sortedListProducts` useMemo) | 6 modos: `padrao` / `preco_asc` / `preco_desc` (preço ≤0 → fim) / `az` / `za` / `manual` (`sortOrder` ASC, NULL → fim); aplicada no render **e** no export (`listExportProducts`) |
| Seletor | `App.tsx` header da lista (ao lado de MATRIX VIEW) | persiste em `localStorage` (`sentinela_products_sort`) |
| Botões ↑↓ | `App.tsx` wrapper do `ProductRow` | só no modo manual; swap + reatribui índices + `saveData()` (POST `/api/data`, caminho já usado pela UI) |
| 1ª ativação do manual | `changeProductSort` | semeia `sortOrder` = índice da ordem visível |
| Tipo | `types.ts`, `repositories/types.ts` | `Product.sortOrder?: number` |

**Validação #45:** `npm run lint` → 0; select troca a ordem; ↑↓ persistem após reload (`sort_order` no banco); export usa a mesma ordem.

**Arquivos:** `src/database/schema.sql`, `src/database/db.ts`, `src/repositories/productRepository.ts`, `src/repositories/types.ts`, `src/types.ts`, `src/App.tsx`, docs.

## 6.31 fix: comparação retorna URLs DIRETAS de produto (nunca catálogo/busca) (#46)

**Problema:** a comparação aceitava qualquer URL em domínio confiável — Gemini/NVIDIA/IA devolviam páginas de catálogo, busca ou home (`aliexpress.com/`, `amazon.com.br/s?k=`, `lista.mercadolivre.com.br/...`), quebrando "abrir preço" e, no AliExpress, scraping de home (extraía preço errado).

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| `isProductUrl` path-aware | `compare.ts:219` | rejeita `q=`, `search=`, `k=`, `s=`; rejeita paths `/busca/ /search/ /categoria/ /collections/ /ofertas/ /store/ /wholesale/ /lista/...`; **AliExpress exige `/item/`/`/i/`/`/p/`**, **Amazon exige `/dp/`/`/gp/product/`**, **Shopee exige `-i.<seller>.<item>` ou `/product/<id>`**, **ML exige `MLB-<n>` (ou `/p/`)**; home (`/`) rejeitada |
| Filtros aplicados | `scanWorker.ts` | Gemini (filtro + `geminiUrls`), NVIDIA e LM Studio (agora filtram — antes não filtravam host nenhum); Tavily/Serper já usavam `isProductUrl` e herdaram a regra nova; fallback síncrono do `server.ts` (Gemini + NVIDIA) idem |
| `title` no schema Gemini | `scanWorker.ts` responseSchema | `title` (opcional) + instrução no prompt → `filterAndDedupe` finalmente consegue aplicar `sameProduct` no caminho Gemini (antes `title` undefined = sem checagem) |
| Prompts "URL direta" | `scanWorker.ts` (Gemini/NVIDIA/LM), `server.ts` (NVIDIA) | "AliExpress precisa conter /item/; Amazon /dp/ ou /gp/product/; Shopee -i.s.item; MLB-<n> — NUNCA catálogo/busca/loja" |
| Guard do handler AliExpress | `store-handlers.ts` | `page.url()` sem `/item/` → descarta (`available:false`) em vez de extrair preço da home/catálogo |

**Validação #46:** `npm run lint` → 0; teste unitário 28/28 URLs (item/home/busca/dp/s/MLB/lista/shopee-i/kabum-produto...) via `tsx`.

**Arquivos:** `src/lib/compare.ts`, `src/workers/scanWorker.ts`, `src/lib/store-handlers.ts`, `server.ts`, docs.

**Smoke #46 (end-to-end):** job 519 "Mouse Gamer Logitech G502" → `https://www.kabum.com.br/produto/388055/mouse-gamer-logitech-g502-x-rgb-25600-dpi-...` (URL direta); job 518 MACHINIST X99 → Tavily 20 brutos, 19 rejeitados (busca/loja) + 1 legítimo ML admitido (correção `03ec76a` de `MLB` sem hífen em `/slug/p/MLB...`); scrape ML estourou timeout 30s → sem resultado (comportamento esperado, sem URL catálogo). **Side findings:** Gemini 429 (cota) e Serper 403 (chave) neste dia — pré-existentes, fora do escopo do #46.

## 6.32 fix: telemetria de preços — ressurreição de deletados + gráficos errados (#47)

**Problemas:**
1. **Produto deletado voltava**: `compareProduct`/`compareAll` gravavam um snapshot `data` de render antigo (poll de até 590s!) via `saveData`; `handleScanAll` fazia `save()` (upsert) de snapshot do início do scan (5s/produto). 2. **Gráficos errados**: datas brutas (labels duplicados por dia), eixo incluía órfãos (`listId=""`), série por `list.name` (colisão de nomes), último ponto não era o preço atual, "ATIVIDADE RECENTE" em ordem de inserção, aba HISTÓRICO não refazia fetch.

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| `dataRef` + `mutateData(updater)` | `App.tsx` | updater roda no estado **mais recente** (produto deletado não existe → não ressuscita); POST + **rollback** se falhar (guard: só se ninguém sobrescreveu) |
| Escritores migrados | `App.tsx` | `compareProduct`, `compareAllProducts`, `deleteProduct`, seed/move do #45 → `mutateData`; `saveData` rastreia `dataRef` + rollback; `saveDataSilent` sincroniza espelho |
| Worker scan-all | `scanWorker.ts` `handleScanAll` | `getById` **antes de cada iteração** → deletado = pula (log); campos alterados no meio não são sobrescritos; `catch` usa snapshot |
| `handleScrape` | `scanWorker.ts` | já seguro (getById pós-scrape) — sem mudança |
| Agregação dos gráficos | `App.tsx` `listHistoryData`/`selectedListHistoryData` | `dayKey()` 1 ponto/dia (dia local, cutoff `T23:59:59.999`), eixo só de produtos em listas reais (exclui órfãos), último ponto/today = **soma de `currentPrice`**, série por **`list.id`** (`name={list.name}` no tooltip/legenda) |
| Modal do produto | `App.tsx` `chartData` | agrupado por dia + ponto de hoje = `currentPrice` |
| ATIVIDADE RECENTE | `App.tsx` | `recentProducts` = `lastUpdated` desc (top 5) |
| Aba HISTÓRICO | `PriceHistoryTab.tsx` | prop `refreshKey` (fingerprint `length:max(lastUpdated)`) no deps do fetch + agrupamento 1 ponto/dia |
| Helpers | `lib/priceHistory.ts` | `dayKey(iso)`, `dayLabel(day)` exportados |

**Validação #47:** `npm run lint` → 0.

**Arquivos:** `src/App.tsx`, `src/workers/scanWorker.ts`, `src/components/PriceHistoryTab.tsx`, `src/lib/priceHistory.ts`, docs.

**Smoke #47 (end-to-end):** job 523 `scrape` com `productId` de produto **deletado** → scrape OK (R$ 369,99) e produto NÃO ressuscitou (API + DB count 0); teste de mecanismo no DB real (`tsx`): save → delete → `getById` guard = SKIP, e save cego = **RESSUSCITOU** (prova do bug antigo); stack reiniciada com o código final (api + 4 workers online); `GET /api/data` 200.

## 6.33 fix: colar link "já conhecido" — sem busca fresca + produto sumia + oferta de outro vendedor (#48)

**Sintomas (logs 09-23/24):** mesmo link do AliExpress colado 3× → `Product added` **4×** (o card sumia entre adds); job 529 `Cache hit (434s old)` = "nem faz a busca"; branch exists só escrevia `console.log` = "tratado como já conhecido" sem nenhum feedback.

**Causas:**
1. **Cache de 30min** do `advancedScrape` (chave = hash da URL completa) devolvia dado velho no ADD manual.
2. **`ProductRepository.saveAll`** apagava do banco todo id ausente do snapshot do `POST /api/data` — qualquer `saveData`/`saveDataSilent`/`mutateData` de snapshot **anterior** ao add (janela fetch↔escrita, comparação longa, timer de debounce) deletava o produto recém-criado → loop de "re-add".
3. **Dedup por forma canônica do path** (`normalizeProductUrl` descarta a query inteira) fundia links de **outro vendedor/oferta** no item existente, e o branch exists não atualizava `url`/imagem/`lastUpdated`.

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| `skipCache` | `lib/scraper.ts` | opção em `ScrapeOptions` → ignora o cache de 30min (gravação do cache continua) |
| `force` no fluxo | `queue/types.ts`, `server.ts` `POST /api/scrape`, `scanWorker.handleScrape`, `App.tsx` `addProduct` | payload `force` → `skipCache: force`; ADD manual sempre `force: true` (queue e fallback direto) |
| Watermark anti-wipe | `server.ts` `GET/POST /api/data`, `App.tsx`, `appDataRepository.ts`, `productRepository.ts` | GET devolve header **`X-Loaded-At`** (relógio do servidor); frontend guarda em `loadedAtRef` (par atômico com `dataRef` só em `fetchData`) e envia `loadedAt` em `saveData`/`saveDataSilent`/`mutateData`; `saveAll` só apaga linhas com `created_at <= loadedAt` (UTC s) — snapshot desatualizado **nunca** apaga produto criado após o load; `loadedAt` ausente = comportamento antigo (compat). `profiles`/`product_lists` mantêm o loop antigo (nota: mesma classe, não relatada) |
| Dedup por OFERTA | `lib/url.ts`, `server.ts` `POST /api/products` | novo `canonicalOfferUrl()` = forma canônica + **query limpa e ordenada** (TRACKING_PARAMS + `spm`/`scm`); existe ⇔ mesma lista + mesma offerKey; **outra oferta do mesmo path = item separado** (escolha do usuário) com id estável `${baseId}~${hash}` (`hashOfferSuffix`, com contador anti-colisão); `generateProductId` inalterado (compat com ids existentes) |
| Refresh + feedback | `server.ts`, `App.tsx` | exists: atualiza `url` (a colada), imagem, nome (só se vazio/`UNKNOWN PRODUCT`), disponibilidade, preço + ponto no `priceHistory` + `lastUpdated`; toasts **"ITEM JÁ ESTAVA NA LISTA — busca fresca aplicada"** / **"PREÇO ATUALIZADO: R$ x → R$ y"** (antes: só `console.log`) |
| Nome corrompido | `server.ts` | passou a **renomear in place** — antes `ProductRepository.delete`+reinsere perdia todo o `price_history` (FK `ON DELETE CASCADE`); guarda contra renomear para "UNKNOWN PRODUCT" |

**Escolha do usuário (#48):** link com a mesma página de produto porém query diferente (outro vendedor/oferta) → **item separado** na lista (não mesclar).

**Validação #48:** `npm run lint` → 0; unitário 11/11 (`/tmp/opencode/test48.ts`: offerKey ignora tracking, distingue oferta, ordem de params irrelevante, suffix estável, baseId inalterado, watermark preserva linha nova/apaga antiga, sem `loadedAt` = comportamento antigo).

**Smoke #48 (end-to-end):** `X-Loaded-At` no GET /api/data; produto novo (id `7j3kbs`) **sobreviveu** a `POST /api/data` de snapshot antigo sem ele (com `loadedAt` anterior ao `created_at`) e foi **apagado** por snapshot novo (`loadedAt` atual) → deletes legítimos seguem funcionando; dedup: mesma URL → `exists` (sem nova linha) / preço menor → `updated` + histórico; mesma URL + `sellerId` → **novo item** `8m0t7r~oh1cwv` (`added`), repaste da mesma oferta → `exists` (sem 3º); jobs 533/534: sem force → scrape normal, **com force → `[Scraper] Cache bypassed (skipCache=true)`** (API log: `job 534 ... (force)`); limpeza restaurou 20 produtos e preço/histórico originais.

**Arquivos:** `src/lib/scraper.ts`, `src/lib/url.ts`, `src/queue/types.ts`, `server.ts`, `src/workers/scanWorker.ts`, `src/repositories/appDataRepository.ts`, `src/repositories/productRepository.ts`, `src/App.tsx`, docs.

## 6.34 feature: COMPRADO — item comprado sai da lista ativa, histórico preservado (#49)

**Peça do usuário:** botão de COMPRADO ao lado dos existentes (buscar/apagar); janela perguntando o **preço total pago**; data/hora da compra; sai da lista; mantém todo o histórico; seção de comprados **no fim da página** da aba LISTS.

**Escolhas do usuário (#49):** scan pós-compra = **parar** (preço congela no momento da compra); preço pago = **obrigatório** (> 0).

**Mudanças:**

| Change | Arquivo | Detalhe |
|---|---|---|
| Colunas | `schema.sql`, `db.ts` | `bought_at TEXT`, `bought_price REAL` + `ensureColumn` (migração no boot) |
| Tipos/repo | `repositories/types.ts`, `types.ts`, `productRepository.ts` | `ProductRow.bought_at/bought_price`, `rowToObj` → `boughtAt/boughtPrice`, `Product.boughtAt?/boughtPrice?`, upsert do `save()` |
| Botão + modal | `App.tsx` `ProductRow` | 3º botão (`ShoppingBag`) entre comparar e apagar → `Modal "MARCAR COMO COMPRADO"` com input **obrigatório** (`> 0`, botão desabilitado + aviso), mostra último preço rastreado; confirma via `mutateData` (não toca em `priceHistory`) + toast |
| Seção BOUGHT ARCHIVE | `App.tsx` | **no fim da página da aba LISTS** (profile-wide, com tag da lista): nome, comprado em (data/hora pt-BR), PAGO vs último rastreado, clique → modal de detalhes, botão **DESFAZER** (volta à lista ativa) |
| Badge | `App.tsx` `ProductDetailModal` | "COMPRADO {data} — PAGO R$ {x}" no cabeçalho (histórico completo segue visível) |
| Exclusões dos comprados | `App.tsx` | `activeProducts` = não-comprados em: conteúdo da lista (`sortedListProducts`), export, contagem `X ITEMS`, budget %/barra, gate `>= 2` (comparar), `ComparisonMatrix`, `compareAllProducts`, `recentProducts`, `productsFingerprint` (mudou → PriceHistoryTab refaz fetch e **mantém** o comprado), NODOS, StatCards TOTAL/QUEDAS |
| Mantém comprados | `App.tsx` | `listHistoryData`/`selectedListHistoryData` (gráfico histórico: preço congelado = verdade); `PriceHistoryTab` (servidor retorna todos) |
| Worker | `scanWorker.ts` `handleScanAll` | pula produto com `boughtAt` (log `item comprado, pulando`) → preço congela |

**Validação #49:** `npm run lint` → 0.

**Smoke #49 (end-to-end):** após restart: `PRAGMA table_info(products)` → `bought_at`/`bought_price` presentes; roundtrip via `POST /api/data` (mesmo caminho do `mutateData` da UI): marcar `830434` → `2026-09-25T03:30:00.000Z|123.45` no DB e no `GET /api/data`; desfazer → `NULL|NULL`, total de produtos intacto (20); `GET /` 200 (tela) e 7 processos PM2 online.

**Arquivos:** `src/database/schema.sql`, `src/database/db.ts`, `src/repositories/types.ts`, `src/repositories/productRepository.ts`, `src/types.ts`, `src/App.tsx`, `src/workers/scanWorker.ts`, docs.

## 6.35 bug+feature: "800 Robux" em link do AliExpress — busca sem hint validado (#50)

**Sintoma:** link colado `https://pt.aliexpress.com/item/1005007300070052.html?...pdp_npi=...BRL+665.99...` virou produto **"800 Robux" R$ 50,00** (card ALVO_IDENTIFICADO/VALOR_ATUAL do modal de detalhes), nenhum aviso na aba ALERTAS, e a seção de comprados estava invisível (nenhum item marcado).

**Causa raiz (jobs 542/543):** (1) a página deu o **nome certo** (`MACHINIST X99 MD8...`) mas `price=0` (preço não renderizou) e o wrapper Playwright **descartava o resultado inteiro**; (2) sem partials, o hint da `SEARCH_VERIFY` virou o **número cru do item** (`1005007300070052` — slug numérico passava pelo `extractNameFromUrl`); (3) busca Tavily por esse ID → snippets aleatórios → LLM respondeu `"800 Robux" R$ 50` **sem validação de nome contra o hint**; (4) SUCCESS → `NVIDIA_NIM`/`GEMINI_VISION` (página real) nunca rodaram; (5) `isPriceRealistic(50, "800 Robux")` passa (com o nome da placa-mãe o gate ≥R$200 rejeitaria). O preço real (R$ 665,99) estava no próprio parâmetro `pdp_npi` do link.

**Mudanças:**

| # | Mudança | Arquivo | Detalhe |
|---|---|---|---|
| A | Slug numérico não é nome | `scraper.ts` `extractNameFromUrl` | `isIdLike` = `^[A-Z]{2,4}\d{6,}` **ou** `^\d{6,}$` → sem slug descritivo → `""` (vira "sem hint" no SEARCH_VERIFY → grounding/null) |
| B | Nome da página sobrevive sem preço | `scraper.ts` wrapper Playwright + loop + `mergeResults` | handler/genérico mantêm o nome com preço 0 (`partial` name-only); `mergeResults` escolhe nome de **todos** os partials (e foto), preço continua exigindo `isValidPrice`; novo `bestPartialName` alimenta o hint da SEARCH_VERIFY |
| C | Nome do LLM validado | `scraper.ts` `titleMatchesHint` (agora export, escopo de módulo) | saída NVIDIA da SEARCH_VERIFY exige overlap com o hint (≥2 palavras comuns ou razão ≥0.34): `"800 Robux"` ≠ `"MACHINIST X99..."` → `null` → cascata continua; hint só-dígitos tratado como ausente |
| D | Preço do link AliExpress | `scraper.ts` `extractAliExpressPdpPrice` + estratégia `URL_PRICE_FALLBACK` | parser do `pdp_npi` (host só AliExpress, `BRL x` distintos → promo = 2º) → partial de preço baixa qualidade (`priceConfirmed=false`, q−1) entre PLAYWRIGHT e SEARCH |
| E | Alerta de sucesso não confirmado | `scanWorker.ts` `handleScrape` | `!priceConfirmed && method ~ /SEARCH/` → `recordInAppAlert("scrape", url, "⚠️ SCRAPE NÃO CONFIRMADO PELA PÁGINA", ...)` (dedup 1h) na aba ALERTAS |
| F | Comprados sempre visíveis | `App.tsx` | BOUGHT ARCHIVE sem o gate `boughtProducts.length > 0`; estado vazio `NENHUM ITEM COMPRADO AINDA — MARQUE PRODUTOS COM O ÍCONE DO CARRINHO NA LISTA` |

**Validação #50:** `npm run lint` → 0; unitário 11/11 (`/tmp/opencode/test50.ts`: id AliExpress/ML puro → `""`, slug descritivo via walk-up preservado, `pdp_npi` → 665.99/unico/sem-param/domínio alheio → null, `titleMatchesHint` rejeita "800 Robux"/aceita sinônimo).

**Smoke #50 (job 547, force):** mesma URL → **`name="MACHINIST X99 MD8 Placa-mãe LGA 2011-3 Suporte Dual Xeon..."`, `price=665.99`**, method `MERGED_PLAYWRIGHT_BASIC+OG`, strategies `PLAYWRIGHT_STEALTH → PLAYWRIGHT_BASIC → URL_PRICE_FALLBACK → ...` (**SEARCH_VERIFY não precisou rodar**); **sem** log `URL name hint: 1005007300070052` (A) e zero caches com "800 Robux" (o cache desta URL, `d6p9bq.json`, agora guarda o resultado correto); 19 produtos intactos, nenhum alerta indevido; resultado sem `SEARCH` no method → E corretamente não disparou.

**Arquivos:** `src/lib/scraper.ts`, `src/workers/scanWorker.ts`, `src/App.tsx`, docs.

## 6.36 bug: "Batch comparison timed out" + lista toda sem resultados no ESCANEAR MERCADO (#51)

**Sintoma:** ao clicar ESCANEAR MERCADO na lista WORKSTATION4 (10 itens), o frontend abortava com `Batch comparison timed out` após 10 min e **jogava fora o resultado** — mesmo o job terminando depois (worker registrava `4/10 produtos com dados`). Além disso 6/10 produtos ficavam sem nenhum preço de mercado.

**Causa raiz (jobs 556/564):** (1) `App.tsx` usava deadline **fixo de 600s** no poll — o lote real leva ~11-30 min (search + NVIDIA + scrape por item) e, ao estourar, o `throw` descartava o `returnvalue` já completo; (2) `runComparison` fazia **scrape de 5 URLs ANTES do NVIDIA** com timeout de 30s — Playwright/AliExpress não renderizava preço em 30s e as rejeições eram **silenciosas** (log "0/5 sem dados" escondia timeouts); (3) com Gemini em 429, quem sobrava era NVIDIA — que rodava DEPOIS do scrape — e LM Studio; (4) `buildSearchQuery` ordenava as palavras por **tamanho** → sopa ("Térmica Console Pasta Cinza Cpu Gd900").

**Mudanças:**

| # | Mudança | Arquivo | Detalhe |
|---|---|---|---|
| A | Poll sem deadline fixo | `App.tsx` `compareAllProducts` | detecção de travamento: **8 min sem progresso novo** → erro com a posição (`travado em 7/10 — ...`; pior caso de 1 item = search 40s + NVIDIA 120s + scrape 90s + LM 120s), cap absoluto **45 min**, `returnvalue` salvo ao concluir (nada é descartado) |
| B | NVIDIA antes do scrape + confirmação 90s | `scanWorker.ts` `runComparison` | nova ordem: Gemini → busca → **NVIDIA nos snippets (~10s)** → `confirmByScrape` top 3 (**90s**, paralelo): confirmou = preço da página; não confirmou = aceita NVIDIA já filtrado (`isProductUrl`+`sameProduct`+`filterAndDedupe`) → fallback scrape top 5 (só se NVIDIA vazio) → LM Studio; `COMPARE_CONFIRM_TIMEOUT_MS=90_000` (era 30s) também no confirm do Gemini (era 15s); **timeout NVIDIA não repete** (API lenta: 4×30s = 2 min perdidos) |
| C | Busca na ordem natural | `compare.ts` `buildSearchQuery` | remove stopwords **mantendo a ordem do nome**; SKUs/códigos que caem fora do corte de 7 palavras entram no fim (até 10 tokens); fim da sopa por tamanho de palavra |
| D | Dedup de oferta AliExpress | `scanWorker.ts` `confirmByScrape` | chave `aliexpress:<id>` (colapsa `/i/` vs `/item/` e host pt/www/m) + `normalizeProductUrl`; log ganhou contador **`timeout/erro`** (rejeições silenciosas agora visíveis) |
| E | Log do passo NVIDIA | `scanWorker.ts` | `parsed=N url+preço=M após dedupe=K`, respostas sem array JSON, erros por modelo, `NVIDIA: 0 resultados → indo para scrape` |

**Validação #51:** `npm run lint` → 0; unitário **10/10** (`/tmp/opencode/test51.ts`: ordem natural preservada, SKU final `1000G` e `SNV3S` mantidos, stopwords removidas, ≤120 chars).

**Smoke #51 (jobs 556/564, profile `3g5znt9hm`, 10 itens WORKSTATION4):**
- **job 556** (primeira versão, ainda sem skip-retry/dedup): completou em **29 min SEM timeout** — antes o front abortava em 600s e mostrava erro; 4/10 entregues.
- **job 564** (versão final): **19 min, 4/10 com dados**, caminho novo funcionando — item 1 (SSD) `NVIDIA parsed=1 → confirm 1/1` em **25s**; dedup removeu 4 entradas duplicadas do cooler AliExpress (`/i/` + `/item/` + pt/www → 1).
- contagem: 4 com dados (SSD, Gabinete, Cooler, Monitor), 6 vazios por causas **externas**: **Gemini 429 pulou em todos**, **NVIDIA NIM com TIMEOUT 30s/resposta vazia na maioria das chamadas**, Tavily+Serper retornaram **0** no Xeon e na MACHINIST, páginas que estouraram os 90s de scrape (contador `timeout/erro`: 3+2+4).

**Limitações / próximos passos:** renovar a quota do **Gemini** (chave em 429 — é a maior alavanca: com quota, o caminho Gemini+confirm é o melhor); NVIDIA NIM lento hoje (o caminho novo já aproveita quando responde rápido); retry com query reduzida quando Tavily+Serper retornam 0 seria o próximo passo.

**Arquivos:** `src/App.tsx`, `src/workers/scanWorker.ts`, `src/lib/compare.ts`, docs.

## 6.37 UX: SCAN PREÇOS da aba MERCADO invisível (só spinner, sem resultado, sem alerta) + limpar ALERTAS (#52)

**Sintoma:** clicar SCAN PREÇOS no SUPERMERCADO TATICO (price_url = página de ofertas) → "só gira a bolinha"; o scan terminou (~3 min) sem mostrar o que fez, quantos achou, % ou erros; nada foi parar na Central de Alertas; e a aba ALERTAS não tinha como limpar a fila.

**Causa raiz (job 571, `recorded: 2`):** (1) `handleLocalPriceScan` **nunca emitia `job.updateProgress`** e `scanEstablishmentPrices` não tinha callback por item → o `pollJob` do MercadoTab (que sequer passava `onProgress`) só via `state`; (2) feedback final = só toast efêmero, sem painel persistente com o resultado por item; (3) o fluxo local só criava alerta para *flash promotion* — **resumo/erros do scan nunca chamavam `recordInAppAlert`**; (4) `NotificationsTab` só tinha ATUALIZAR LOG (repository sem `clearAll`, API sem `DELETE`).

**Mudanças:**

| # | Mudança | Arquivo | Detalhe |
|---|---|---|---|
| A | Progresso por item/estratégia | `localPriceScrape.ts` | tipo `LocalScanProgress`; `scanEstablishmentPrices` ganha `onItemProgress` (emite antes/depois de cada item com contagem viva); `scrapeViaPriceUrl` repassa `advancedScrape({ onProgress })` → estratégia atual da cascata |
| B | `updateProgress` global | `scanWorker.ts` `handleLocalPriceScan` | `totalSteps` = Σ itens por est. com priceUrl (sem url = 1); payload `{current, total, establishmentName, label, itemIndex/Total, strategy/Tried/Total, recorded, duplicates, errors, socialDependent}` em `iniciando` → por item/estratégia → `concluído:` |
| C | Resumo em ALERTAS | `scanWorker.ts` | scan **manual sempre** (cooldown 0): `🛒 SCAN DE PREÇOS — <EST>` (ou `⚠️ ... COM ERROS` se `errors>0`) com `Registrados/Duplicados/Erros/Social` + até 12 linhas `• item: ✅ R$ x (método)/⏭️ duplicado/❌ erro` + URL; **cron/bulk só se `errors>0`** (entityId `cron`, cooldown 1h) |
| D | Limpar ALERTAS | `notificationRepository.ts`, `server.ts` | `clearAll()` (DELETE FROM notification_log → changes) + `DELETE /api/notifications` → `{deleted}` |
| E | Painel no card + ÚLTIMO SCAN | `MercadoTab.tsx` | `pollJob(..., onProgress)`; card do est **expande durante o scan**: botão `SCANEANDO %`, barra de %, `label` (item/estratégia), contadores vivos `✅/DUP/⚠`, `ETAPA n/total` + `ESTRATÉGIA x/y`; após concluir, card **ÚLTIMO SCAN** persistente (timestamp, totais, 1 linha por item com status colorido/preço/método/URL ↗); toast vira erro quando `errors>0` |
| F | Botão LIMPAR TUDO | `NotificationsTab.tsx` | ícone/label `SCAN LOCAL` (`Radar`, azul) p/ `entityType local-scan`; botão em 2 cliques (`LIMPAR TUDO` → `CONFIRMAR LIMPEZA?` em 3s) → DELETE → toast `N alertas removidos` |

**Validação #52:** `npm run lint` → 0.

**Smoke #52 (est `est-1789755442377-ys5tqt`, profile 3g5znt9hm):**
- **job 575** (cache quente): payload final correto `current:2/total:2, label "concluído: SUPERMERCADO TATICO", duplicates:2` (dedup do preço idêntico de 16h) → alerta **#127** `🛒 SCAN DE PREÇOS — SUPERMERCADO TATICO` com `Registrados: 0 • Duplicados: 2` + linhas `⏭️ duplicado (R$ 750)`;
- **job 577** (cache limpo, caminho completo): progresso intermediário real a cada 1,2s — `Feijão dona de • PLAYWRIGHT_STEALTH 0/7 → PLAYWRIGHT_BASIC 1/7 → SEARCH_VERIFY 2/7 → NVIDIA_NIM 3/7` → `arroz 5KG` com contadores vivos (`errors:1` já visível entre itens) → `concluído` com **erros: 2** → alerta **#132** `⚠️ SCAN DE PREÇOS COM ERROS` com `❌ Failed to scrape... (tried: ...)` + URL por item;
- `DELETE /api/notifications` → `{"deleted":105}` e `GET` → `[]`; Vite/PM2 sem erros de compilação (7 processos online, API 200).

**Arquivos:** `src/lib/localPriceScrape.ts`, `src/workers/scanWorker.ts`, `src/repositories/notificationRepository.ts`, `server.ts`, `src/components/MercadoTab.tsx`, `src/components/NotificationsTab.tsx`, docs.

## 6.38 UX: links que o ADD não encontrou não voltavam para copiar e tentar depois (#53)

**Sintoma:** operador colou **14 links** no modal ADD TRACKING TARGETS da lista COMPRAS CASA → só **7 entraram** (DB confirmou: exatamente 7 produtos criados no lote 19:28–19:41). As 7 falhas apareciam só em toast que some, no SCRAPE LOG escondido do topo (estado de sessão — apagado pelo restart de 19:48) e em entradas soltas `✗ SCRAPE FALHOU` no ALERTAS (uma por URL, URL dentro do texto). **Nenhum lugar devolvia um bloco copiável** para re-colar e tentar depois.

**Causa raiz:** `addProduct()` fechava o modal sempre no fim (`setIsAddingProduct(false)`), descartava `batchResults` do campo de visão (dropdown pequeno, sessão only) e nunca registrava falha em estado persistente. Cancelamento no meio do lote nem era contado (`return null` sem registro).

**Mudanças (só fronte — Vite HMR, sem restart):**

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Cache local das falhas | `App.tsx` | tipo `FailedTarget {url, error, at}` + `load/saveFailedTargets` (`localStorage` `sentinela.failedTargets.v1`, dedupe por URL, cap 50) |
| B | `finishFailures()` no fim do lote | `addProduct()` | **falha = toda URL da tentativa que NÃO virou produto** (scrape falhou/timeout, ou cancelada — antes canceladas nem eram registradas); merge com falhas anteriores removendo as que agora succeed; roda também no `catch` de falha total |
| C | Modal fica aberto com falhas | `addProduct()` | só fecha se `failed === 0 && !abortado`; banner `X ENCONTRADOS • Y FALHARAM`; toast novo `... — bloco de falhas aberto no modal` |
| D | **BLOCO DE FALHAS** no modal | `App.tsx` | `⚠ LINKS NÃO ENCONTRADOS (n) — COPIE E TENTE DEPOIS` com cada URL + erro (truncado com tooltip); botões **COPIAR** (URLs puras, 1 por linha — pronto para colar em TARGET URLS), **RECOLHER NOS CAMPOS** (preenche os inputs → retry = BEGIN TRACKING), **LIMPAR**; reaparece ao reabrir o modal/reload (cache local) |
| E | COPIAR FALHOS no SCRAPE LOG | dropdown do topo | botão ao lado de CLEAR: copia as URLs falhas da sessão (1 por linha) |

**Validação #53:** `npm run lint` → 0. Smoke Playwright real (chromium headless, `localhost:3001`, lista COMPRAS CASA):

- **A — cancelamento (determinístico):** 2 URLs inválidas → BEGIN → ABORT em 3s → **A1** bloco `(2)` → **A2** banner `2 FALHARAM` → **A3** localStorage `["...alpha | Cancelado pelo operador", "...bravo | Cancelado pelo operador"]` → **A4** modal aberto → **A5** clipboard = 2 URLs puras (`\n`) → **A6** reload → bloco **persistiu** → **A7** LIMPAR zera bloco + localStorage;
- **B — falha real do worker:** 2 URLs `127.0.0.1:9/zqxb53*` → lote terminou em **93s** com `1 ENCONTRADOS 1 FALHARAM` (o SEARCH_VERIFY acha conteúdo para gibberish — pré-existente) → **B1** bloco `(1)` com erro real `Failed to scrape product data from all strategies (tried: PLAYWRIGHT_STEALTH, PLAYWRIGHT_BASIC, SEARCH_VERIFY, NVIDIA_NIM, FETCH_FALLBACK)` → **B4** modal aberto → **B5** limpeza;
- Poluição de teste removida: produtos `ihkt7k`/`iww3vb` + `price_history` + alertas #135–137 (0 restos).

**Arquivos:** `src/App.tsx` (estado/helpers, `finishFailures`, bloco no modal, COPIAR FALHOS no SCRAPE LOG), docs. Sem mudança de API/worker.

## 6.39 feature: cadeia de IA única DeepSeek → Gemini → NVIDIA → LM Studio (#54)

**Contexto:** quota Gemini 429 crônica + NVIDIA lenta gargalhavam compare/scan/scrape/social. Novo provedor PRINCIPAL: **DeepSeek** (API OpenAI-compatible; modelos `deepseek-v4-flash` texto e `deepseek-v4-flash-vision-exp` imagem, trocáveis via env). A ordem pedida pelo operador — **DeepSeek → Gemini → NVIDIA → LM Studio** — vale para **tudo**, inclusive social (flyers/stories).

**Decisão de arquitetura:** a ferramenta `googleSearch` do Gemini é **BUSCA**, não interpretação — os passos com `googleSearch` (busca do compare, grounding) continuam como fonte de dados; a **interpretação** (snippets, HTML, screenshot, análise, flyers) tenta DeepSeek primeiro e cai na cadeia antiga se falhar. Sem chave DeepSeek = comportamento idêntico ao anterior (passo simplesmente ignorado).

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Chave DeepSeek | `profiles.deepseek_api_key` (schema + `ensureColumn` no boot), tipo `Profile`, `profileRowToProfile`, `saveAll` | migração automática, 1 coluna |
| B | UI/status | `App.tsx`: campo `DEEPSEEK API KEY (PRINCIPAL)` em AI CORE PARAMETERS **antes** do Gemini, indicador `DEEPSEEK` no header APIS; `server.ts /api/status` → `deepseek.available`; `.env.example` | autosave 1s igual os demais |
| C | `src/lib/aiProviders.ts` (novo) | núcleo da cadeia | `deepseekText`/`deepseekVision` (cliente OpenAI, `baseURL https://api.deepseek.com`, timeout 30s/`DEEPSEEK_TIMEOUT_MS`, `maxRetries 1`), `resolveDeepSeekKey` (perfil → env), `extractJsonObject`, log `[aiChain] provider OK/falhou` |
| D | Cascata do scraper | `scraper.ts` | estratégia nova `DEEPSEEK_VISION` (screenshot + texto da página na **mesma** janela: vision → texto), `GEMINI_VISION` **antes** da `NVIDIA_NIM`, `PLAYWRIGHT_LM_STUDIO_*` movido para o **fim** (depois de FETCH/GEMINI_FALLBACK); `SEARCH_VERIFY` interno: DeepSeek → regex → Gemini → NVIDIA; gate do SEARCH_VERIFY aceita só-DeepSeek |
| E | Workers | `scanWorker.ts` | `runComparison` ganha passo **DeepSeek** (snippets → array JSON → `isProductUrl` → dedupe → confirm top 3 90s) antes do NVIDIA; `handleAnalyze` reordenado DeepSeek → Gemini → NVIDIA → LM; `local-insight` DeepSeek → Gemini → determinístico; `deepseekApiKey` nos 4 `advancedScrape` + `apiKeys` do scan local |
| F | Preço por item | `market-handlers.ts`, `localPriceScrape.ts` | `searchMarketPrice`: **DeepSeek → Gemini → NVIDIA**; gates `canSearch`/`canMarketSearch` aceitam só-DeepSeek |
| G | Rotas Express | `server.ts` | `/api/scrape` repassa a chave; `/api/compare` (sem Redis): busca Gemini → **DeepSeek** → NVIDIA; `/api/analyze` (sem Redis): DeepSeek → Gemini → NVIDIA → local; guard 400 atualizado |
| H | Social | `socialWorker.ts`, `socialParse.ts` | encarte e stories: `deepseekVision` primeiro, Gemini Vision só como fallback; `parsePromosFromTextWithAI(text, apiKey, hint, deepseekApiKey)` → DeepSeek → Gemini → determinístico; `download` da story liga com qualquer chave de visão |

**Validação #54:** `npm run lint` → 0. Teste offline da cadeia (`/tmp/opencode/test54.mjs`, mock HTTP OpenAI-compatible): **18/18** — modelos corretos (`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`), `temperature: 0`, system+user, data-URL da imagem, 500 → `null` (fallback), sem chave → `null`, helpers (`resolveDeepSeekKey`, `extractJsonObject` com fence/ao redor). Smoke Playwright: **8/8** — header `DEEPSEEK`, campo nas settings, roundtrip salvar → reload → `available: true` → limpar → `false`, estado do DB restaurado (`NULL`). Restart PM2 (7 processos online), coluna `deepseek_api_key` criada, `/api/status` devolve `deepseek.available`.

**Para ativar:** SETTINGS → `DEEPSEEK API KEY (PRINCIPAL)` (platform.deepseek.com) ou `DEEPSEEK_API_KEY` no `.env`. LM Studio segue offline — para o último elo (imagem local) carregar `Qwen2.5-VL-3B-Instruct` (GGUF Q4_K_M + mmproj; **3B, não 7B** — a máquina tem GTX 960 de 2GB VRAM, §6.42).

**Arquivos:** `src/lib/aiProviders.ts` (novo), `src/lib/scraper.ts`, `src/workers/scanWorker.ts`, `src/workers/socialWorker.ts`, `src/lib/market-handlers.ts`, `src/lib/localPriceScrape.ts`, `src/lib/socialParse.ts`, `server.ts`, `src/App.tsx`, `src/types.ts`, `src/database/schema.sql`, `src/database/db.ts`, `src/repositories/types.ts`, `src/repositories/profileRepository.ts`, `.env.example`.

## 6.40 feature: varredura da página de ofertas + promo-cache na lista (#55)

**Contexto:** só 1 estabelecimento tem `price_url` (Tático → `.../gyn/ofertas/`, página de ofertas SEM `{term}`) — `buildSearchUrl` appendava `?q=<item>` e a IA devolvia preço errado (ex.: R$750). Operador pediu: **varrer a página de ofertas** (salvando promoções com **prazo de validade** — reuso sem re-busca durante a vigência) + **busca item-a-item de TODOS**, e ao **adicionar um produto na lista** o sistema **diz onde está mais barato na hora** (histórico com validade evita busca repetida).

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Matcher promoção↔item | `src/lib/promoMatch.ts` (novo, puro) | `promoTokens` (normalizeText + stopwords + len>2) e `promoMatchesItem`: todos os tokens do item ⊆ tokens da promo **ou** vice-versa |
| B | Varredura de ofertas | `src/lib/offerSweep.ts` (novo) | `isOffersPageUrl` (priceUrl sem `{term}`), `renderOffersPage` (Playwright 1×, scroll p/ lazy-load, screenshot + `innerText` 12k), cadeia **DeepSeek vision → DeepSeek text → Gemini vision → Gemini text** (`AI_MODELS`, JSON array máx. 150), `sanitizeOffers` (nome≥4, preço válido tolerando `"12,90"`/`"R$ …"`, dedupe por normalização menor preço, cap 200) |
| C | Promoção com validade | `saveSweptOffers` | id determinístico `sweep-{est}\|hash(nome)` upsert em `promotions` (`source="sweep"`, `expiresAt` = now+`SWEEP_TTL_HOURS`, padrão 24h env); página é fonte da verdade → sweep anterior que sumiu da página fica **inativo** |
| D | Promo-cache no scan | `localPriceScrape.ts` `scrapeItemPrice` | topo: `findActivePromo` (vigente + `promoMatchesItem`; **nome exato vence variante**, menor preço) → `recordObservation(..., "promocao-vigente")` e retorna method `promo-vigente(aaaa-mm-dd)` **sem re-buscar**; outcome ganha `swept`/`promoHits` |
| E | Passo de varredura | `scanWorker.handleLocalPriceScan` | por est alvo com ofertas-page: step extra "varrendo ofertas" antes do loop (+1 em `stepsOf`), total agregado no alerta (`• Varredura: n promoções • Promo-cache: n itens`) e no `return` do job |
| F | UI MERCADO | `MercadoTab.tsx` | resumo + card ÚLTIMO SCAN com `PROMOÇÕES n` / `PROMO-CACHE n` |
| G | Pull na hora do ADD | `App.tsx addProduct` | após lote com sucesso: `GET /api/promotions?onlyActiveOrFlash=true` + `/api/establishments`, casamento via `promoMatchesItem` nos nomes adquiridos → toast `EM PROMOÇÃO — mais barato agora` (loja, preço, validade; máx 3), **sem nova busca** |
| H | — | `aiProviders.ts`, `.env.example` | `extractJsonArray` (fence-tolerant, arrays); `SWEEP_TTL_HOURS=24` |

**Validação #55:** `npm run lint` → 0. Teste offline (`/tmp/opencode/test55.mjs`, DB temporário): **8/8** — matcher (subset/bidirecional/stopwords), `extractJsonArray`, `sanitizeOffers` (dedupe/filtro/pt-BR), `isOffersPageUrl`, `saveSweptOffers` (upsert determinístico + inativação), `findActivePromo` (expirada/inativa/sem validade fora; exato > variante; sem falso positivo). Smoke (`/tmp/opencode/smoke55.mjs`): **4/4** — API de pé, **render real da página do Tático (10s, graceful `null` sem chave)**, save → cache → revarredura inativa → limpeza, endpoints do add-time hook. PM2 restart (scanWorker novo).

**Efeito no fluxo:** SCAN PREÇOS no Tático = 1 render da página de ofertas → promoções salvas com validade → itens da lista batem com a promo (sem re-busca) e registram histórico `promocao-vigente`; ADD de produto em promoção mostra na hora a loja mais barata. Com Gemini 429 e DeepSeek sem chave a varredura degrada para `null` sem quebrar o scan (itens seguem pelo caminho normal).

**Arquivos:** `src/lib/promoMatch.ts` (novo), `src/lib/offerSweep.ts` (novo), `src/lib/aiProviders.ts`, `src/lib/localPriceScrape.ts`, `src/workers/scanWorker.ts`, `src/components/MercadoTab.tsx`, `src/App.tsx`, `.env.example`.

## 6.41 fix: scan do Tático → "ERROS 2" (varredura vazia + cascata `?q=` inútil) (#56)

**Contexto:** scan manual do Tático (2 itens) falhou com `ERROS 2 • Registrados 0` — tudo cascata `?q=<item>` queimando 7 strategies (~90s/item). Log do worker mostrou a varredura #55 rodando mas extraindo **0 promoções**: DeepSeek sem chave (skip), Gemini vision **503** e Gemini **429** (bloqueado 1h).

**Causas encadeadas:**
1. **Varredura dependia de 1 screenshot + IA disponível** — sem chave/IA, promo-cache ficava vazio.
2. **Sem promo, `scrapeViaPriceUrl` montava `.../ofertas/?q=<item>` — e a página IGNORA o parâmetro** (sempre mostra o encarte inteiro). Inspeção do DOM: **o encarte do Tático é 100% IMAGEM** (cartazes "Cuidar Bem" válidos 17–30/09/2026; `document.body.innerText` = só menu/footer; **zero** `R$` no HTML de 68KB). Item ausente do encarte + IA fora = falha total com erro genérico.

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Render multi-captura | `offerSweep.ts renderOffersPage` | N capturas de viewport (até **6**, 900px por passo, durante o scroll de lazy-load) — cobre encartes longos; retorna `{captures[], text}` |
| B | Cadeia IA → det | `offerSweep.ts` | **DeepSeek vision (todas capturas, merge) → Gemini vision → DeepSeek text → Gemini text → `extractDetOffers`** (decisão do operador). Provider que quebra numa captura → passa pro próximo provedor; merge/dedupe via `sanitizeOffers`; prompt de "captura de encarte (ofertas podem estar em imagens de cartaz)" |
| C | Parser determinístico | `extractDetOffers` (export) | linha `R$ X,XX` → nome = até 2 linhas alfabéticas acima → `sanitizeOffers`. **Não serve p/ o Tático** (sem texto) — é o último recurso de páginas textuais |
| D | Branch offers-page | `localPriceScrape.ts scrapeItemPrice` | opt `offersPage {swept}`: promo-cache primeiro; senão `swept>0` → status **`notFound`** "fora das ofertas de hoje" (não conta erro, **0 strategies**); `swept=0` → **error curto** "varredura não extraiu promoções — sem chave de IA ou IA indisponível" (conta erro → alerta honesto). **Nunca monta `?q=` em ofertas-page** |
| E | Encadeamento + UI | `scanWorker.ts`, `MercadoTab.tsx` | `handleLocalPriceScan` repassa `{swept}` só p/ est de ofertas; `statusLabel` do alerta `🚫 fora das ofertas de hoje`; `localStatusMeta` → `FORA DAS OFERTAS` (zinc, não-erro → alerta vira `CONCLUÍDO` quando só há notFound) |

**Validação #56:** `npm run lint` → 0. Teste offline (`/tmp/opencode/test56.mjs`): **8/8** — det (nome acima, pt-BR, descarta inválido/sem nome, 2 linhas na ordem), branch `notFound`/`varredura-vazia` (sem `?q=`), promo-cache vence o branch, cascata normal preservada sem a flag, `scanEstablishmentPrices` repassa + notFound não conta erro; regressão do #55 **8/8**. Smoke (`/tmp/opencode/smoke56.mjs`): **4/4** — Tático real: **6 capturas em 10.5s** → `null` graceful sem chave; caminho degradado do item **0.0s** sem strategies; det=0 no innerText do Tático. PM2 restart.

**Limitação:** com Gemini 503/429 e DeepSeek sem chave, a varredura do Tático continua salvando **0** (o encarte é imagem — exige visão); o scan agora **não gera mais cascata inútil**, mas extrai promoções de fato só com alguma chave de visão ativa (DeepSeek em AI CORE PARAMETERS quando disponível). O parser det cobre páginas com texto de preço.

**Arquivos:** `src/lib/offerSweep.ts`, `src/lib/localPriceScrape.ts`, `src/workers/scanWorker.ts`, `src/components/MercadoTab.tsx`.

## 6.42 feature: NVIDIA vision + LM Studio na varredura de ofertas (#57)

**Contexto:** com #56 a varredura rodava mas, sem DeepSeek e com Gemini na cota de **20 req/dia** (free tier `gemini-3.6-flash`), só restava fallback frágil; NVIDIA e LM Studio — presentes na cadeia global (#54) — **não eram consultados** pelo `sweepEstablishmentOffers`. Smoke com NVIDIA colado (chave ativa) devolveu **0 promoções em 507s** sem nenhum erro visível.

**Diagnóstico:**
1. **Truncagem silenciosa** — `finish_reason=length` em 2000 tokens: o JSON do encarte inteiro não fechava → `extractJsonArray` → `null` → provider era pulado como "sem resposta". Corrigido com `max_tokens: 3000` + **repair de truncagem**.
2. **Preço com vírgula** — `llama-3.2-11b-vision` gera `"price": 22,78` (decimal **sem aspas** → JSON inválido em TODOS os itens). Medido via curl: 92s/chamada, resposta real com `22,78`/`0,99`.
3. **Gemini sem timeout** — SDK `@google/genai` pendurou **6min sem log** (o 429 mascarava antes; com quota liberada a chamada travou). Adicionado `AbortSignal.timeout(45s)`.
4. **Catálogo NVIDIA** (82 modelos sondados com a chave do operador): `meta/llama-3.2-11b-vision-instruct` ✓ (extraiu preços reais do encarte), `microsoft/phi-3-vision-128k-instruct` → 404 "Not found for account", `meta/llama-3.2-90b-vision-instruct` → timeout 180s. Lista final = env `NVIDIA_VISION_MODEL` + 11b.

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Cadeia da varredura | `offerSweep.ts` | ordem final: **1 DeepSeek vision → 2 Gemini vision → 3 NVIDIA vision → 4 DeepSeek text → 5 Gemini text → 6 LM Studio vision → 7 det**; prompt "máximo 40 itens" |
| B | `nvidiaVision` | `offerSweep.ts` | OpenAI-compat `https://integrate.api.nvidia.com/v1`, `max_tokens 3000`, `temperature 0`, timeout **300s** (`NVIDIA_SWEEP_TIMEOUT_MS`; medido ~92s, pico estourou 150s no smoke) — timeout **aborta o provider** (senão 6×300s = 30min de pior caso) |
| C | `lmStudioVision` | `offerSweep.ts` | **último da varredura** (decisão do operador): gate `${lmUrl}/models` 2.5s, modelo = `data[0].id`, **protegido**: 2 capturas, `max_tokens 1500`, timeout 90s |
| D | Robustez do parse | `aiProviders.ts extractJsonArray` | **repair de truncagem** (slice `[`→último `}` + `]`) e **normalização de preço com vírgula** `("price"\s*:\s*)(\d+),(\d+)` → `"22.78"` (sanitizeOffers tolera string) — nos dois parse |
| E | Gates + wire-up | `offerSweep.ts`, `scanWorker.ts` | Gemini `abortSignal: AbortSignal.timeout(45s)` (`GEMINI_SWEEP_TIMEOUT_MS`); `SweepKeys` + `nvidiaApiKey`/`lmStudioUrl`; `handleLocalPriceScan` repassa ambas |

**Validação #57:** `npm run lint` → 0. Teste offline (`/tmp/opencode/test57.mjs`): **7/7** — sem chave → det, porta morta do LM não trava, repair de truncagem (2 itens fechados), preço com vírgula (parse + sanitize); regressões **#55 8/8** e **#56 8/8**. Smoke REAL (`/tmp/opencode/smoke57.mjs`, Tático): **3/3** — **80 promoções** extraídas pela NVIDIA vision em **6 capturas/587.7s**, 80 salvas com `expires_at` +24h (`source=sweep`), `findActivePromo` achou probe. Curl isolado: 92s/chamada, `finish_reason=length` + `22,78` (motivo das correções D). PM2 restart (7 online).

**Limitações:** Gemini free tier = **20 req/dia** (hoje estourado → Gemini cai fora naturalmente); NVIDIA free tier leva ~10min para as 6 capturas; sem nenhuma chave de visão a varredura do Tático continua 0 (encarte 100% imagem) com a mensagem honesta do #56.

**Para ativar:** NVIDIA/Gemini já nas chaves do perfil. **LM Studio** (último da varredura): baixar **`Qwen2.5-VL-3B-Instruct`** GGUF **Q4_K_M** + `mmproj` (~2GB — a máquina tem GTX 960 **2GB VRAM**; o 7B não cabe; correção da sugestão antiga `qwen2.5-vl-7b-instruct`), carregar no LM Studio e salvar a URL em `LM STUDIO URL` em AI CORE PARAMETERS (coluna `lm_studio_url` hoje `NULL`). Env opcional: `NVIDIA_VISION_MODEL`, `NVIDIA_SWEEP_TIMEOUT_MS`, `GEMINI_SWEEP_TIMEOUT_MS`.

**Arquivos:** `src/lib/offerSweep.ts`, `src/lib/aiProviders.ts`, `src/workers/scanWorker.ts`.

## 6.44 feature: botão ADD LISTA nos cards de promoção (#59)

**Contexto:** a seção PROMOÇÕES do MercadoTab mostrava preço/validade e só tinha lixeira — para levar um item em promoção à lista de compras era preciso abrir o formulário do item e redigitar nome e preço à mão.

| # | Mudança | Onde | Detalhe |
|---|---|---|---|
| A | Botão por card | `MercadoTab.tsx` (card de promoção) | ícone `ShoppingCart` ao lado da lixeira, `title="ADICIONAR ESTE ITEM À LISTA DE COMPRAS"` |
| B | Add em 1 clique | `addPromotionToList` | `POST /api/shopping-list-items` com `listId` = **lista ativa** (`activeListId`), `quantity 1`, `unit UN`, `targetPrice` = preço promocional; **duplicado** (mesmo nome normalizado via `normalizeText` de `lib/text.ts`) → só toast `JÁ ESTÁ NA LISTA` sem POST; sucesso → `playSound` + toast `ADICIONADO À LISTA <nome-da-lista>` + `loadAll()` |

**Validação #59:** `npm run lint` → 0 (front puro — sem backend novo, usa a rota existente de `shopping-list-items`).

**Arquivos:** `src/components/MercadoTab.tsx`.
