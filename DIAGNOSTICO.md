# DIAGNÓSTICO — Crimson Sentinel (estado pré-reconstrução)

**Branch analisada**: `rebuild-v2` (commit `0c62073`, igual a `main`/`legacy-ecommerce`)
**Data**: 2026-08-07
**Objetivo**: catalogar, antes de qualquer alteração, todos os pontos do código atual onde (a) chamadas de rede externas acontecem de forma síncrona dentro de handlers Express, (b) agendamentos via `setInterval`/`setTimeout`, e (c) leitura/escrita direta em `data.json`. Nada foi corrigido — este documento é a baseline para a Fase 2 em diante.

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

**Conclusão**: o diagnóstico confirma os três motivos pelos quais o sistema atual trava e não é robusto. A reconstrução começa pela Fase 1 (camada de banco + repositórios) para eliminar o problema estrutural de I/O, depois Fase 2 (BullMQ + pm2) para eliminar o problema de agendamento e bloqueio, depois Fase 3 para mover o scraping pesado para fora da thread HTTP.
