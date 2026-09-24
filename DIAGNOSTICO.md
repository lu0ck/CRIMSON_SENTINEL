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

## 6.7 Status da FASE 7 (em andamento) — Insights locais com IA

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

