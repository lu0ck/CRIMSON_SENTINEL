# 🛡️ Sentinela — Monitor de Preços e Promoções Locais

**Sentinela** é um monitor de preços inspirado no HUD do Homem de Ferro. Ele monitora produtos online e lojas físicas locais, detecta promoções-relâmpago e notifica via Discord/Telegram — tudo processado por uma arquitetura de **fila de jobs assíncrona** (BullMQ + Redis) com workers isolados em PM2.

---

## 🏗️ Arquitetura

```
┌────────────┐   HTTP (UI)   ┌─────────────┐      BullMQ/Redis      ┌─────────────────────────┐
│ React+Vite │ ────────────► │ Express API │ ─────────────────────► │ sentinela-scan-worker   │ 4× cluster
│ (HUD)      │               │  server.ts  │                        │   scrape, scan-all,     │ concurrency 5
└────────────┘               └─────────────┘                        │   compare, analyze,     │ = até 20 jobs
                                     │  SQLite (better-sqlite3)      │   local-price-scan,    │
                                     │  crimson.db (USER_DATA_PATH)  │   discover, insight    │
                                    ▼                               └─────────────────────────┘
                          ┌────────────────────┐                    ┌─────────────────────────┐
                          │ Filas (3):         │                    │ sentinela-route-worker  │
                          │  scan-queue        │◄───────────────────│   roteirização TSP      │
                          │  route-queue       │                    │   (OSRM + veículo)      │
                          │  social-monitor-   │                    └─────────────────────────┘
                          │    queue           │                    ┌─────────────────────────┐
                          └────────────────────┘                    │ sentinela-social-worker │
                                                                    │   instagrapi client     │
                                                                    └─────────────────────────┘
                                                                     ┌─────────────────────────┐
                                                                     │ sentinela-instagram-    │
                                                                     │   service (Python)      │
                                                                     │   FastAPI:8721          │
                                                                     └─────────────────────────┘
```

- **Fila única de scan** com 4 instâncias PM2 em cluster (`concurrency: 5` cada) → até **20 jobs simultâneos** sem OOM.
- **Lock anti-travamento**: `lockDuration: 120s`, `stalledInterval: 60s`, `maxStalledCount: 1` (cobre timeout de 90s por estratégia de scrape — #30).
- **Toda IA roda em worker** (nunca no handler HTTP): DeepSeek → Gemini → NVIDIA → LM Studio, em cascata (#54).
- **Persistência** em SQLite (`crimson.db` na raiz do projeto; `USER_DATA_PATH` sobrescreve o caminho em produção), acessada via repositórios em `src/repositories/`.

---

## ⚡ Início rápido

### 1. Pré-requisitos
- Node.js ≥ 18 e npm
- PM2 (`npm i -g pm2`); sem instalação global, use `npx pm2 ...` nos comandos abaixo
- Docker (para o Redis) ou um Redis em `127.0.0.1:6379`
- Python 3.10+ **apenas se** for usar o módulo Instagram (C3)

### 2. Suba o Redis
```bash
docker compose up -d        # redis:7-alpine na porta 6379 (persistente)
```

### 3. Instale e configure
```bash
npm install
cp .env.example .env        # preencha DEEPSEEK_API_KEY (principal), GEMINI_API_KEY e canais de notificação
```

### 4. Suba tudo com PM2
```bash
npm run pm2:start           # 5 apps · 8 processos (scan-worker em 4×cluster) + instagram-service
npm run pm2:logs            # acompanhe os logs
```

A UI fica em **http://localhost:3001**.

> Sem PM2: `npm run dev` (API) + `npm run worker:scan`, `worker:route`, `worker:social` em terminais separados.

---

## 📦 Módulos

### Módulo Local (geolocalizado)
- **Localização**: `POST /api/location` (endereço via Nominatim **ou** lat/lng + raio). Fica em `user_settings`.
- **Descoberta de mercados**: `POST /api/establishments/discover` → enfileira job no scan-queue → Overpass (OpenStreetMap) busca supermercados no raio e faz *upsert* (dedup por `osmId`).
- **Scan de preços locais**: `POST /api/local-price-scan` — usa a `price_url` dos estabelecimentos (`{term}` = nome do item) e respeita o raio da localização.
- **Varredura de ofertas + promo-cache (#55)**: estabelecimento com `price_url` de página de ofertas (sem `{term}`, ex.: Tático) tem a página renderizada 1× por scan → array de promoções salvo em `promotions` com validade (`SWEEP_TTL_HOURS`, padrão 24h, `source=sweep`); durante a vigência os itens batem com a promo **sem re-busca** (`promo-vigente`), e ao ADD um produto o sistema avisa **EM PROMOÇÃO — mais barato agora** (loja + preço + validade). Casamento promo↔item em `src/lib/promoMatch.ts` (tokens sem acento, nome exato vence variante).
- **Roteirização** (`POST /api/route`): otimiza **menor preço por item** (observação + promoção ativa), poda para `route_max_stops`, **agrupa lojas** quando a economia não supera o custo extra de deslocamento e resolve o TSP (+ 2-opt) com **volta para a Casa** (`roundTrip`, default `true`). Calcula distâncias/durations via OSRM com fallback haversine e aceita:
  - `vehicle`: `car`/`motorcycle` (consumo km/L + preço do combustível), `public` (tarifa), `bike`, `foot`;
  - `startTime`: ISO específico **ou** `"suggest"` (heurística Popular Times escolhe janela de menor movimento 7h–20h);
  - `roundTrip`: `boolean` (default `true` — fecha o ciclo na Casa);
  - retorna `suggestedDepartureAt`, `arrivalTimeEstimate` e `quietScore` por parada (+15min de compra por parada no `totalTimeMin`).

### Promoções-relâmpago (flash)
- Detecção automática (média dos últimos N dias × threshold **ou** abaixo do menor preço histórico × 0.99) ao registrar preços — `src/lib/flashDetect.ts`.
- Expiração em 24h (`expires_at`), badge `RELÂMPAGO` na UI e alerta prioritário no Telegram (`flash_telegram_priority`).

### Monitoramento Social
- **WhatsApp** — `whatsapp-web.js` monitora **conversas em tempo real**: mensagens de grupo e diretas; **imagens de flyer são baixadas automaticamente** e interpretadas via Gemini Vision.
  - `GET /api/social/whatsapp/qr` (QR para o celular), `GET /api/social/whatsapp/status`, `POST /api/social/whatsapp/toggle`.
  - Listener `message_create` no boot do server — sem scan manual.
- **Instagram Stories (C3)** — microserviço **Python (instagrapi)** baixa Stories dos handles cadastrados, e o **Gemini Vision** (`gemini-3.6-flash`) extrai preços da imagem.
  - `GET /api/social/instagram/health`, `POST /api/social/instagram/login`, `POST /api/social/instagram/scan`.
  - Throttle: `user_settings.instagram_scan_per_handle_min` (default 45min).
- **Captura manual**: `POST /api/social/capture` (texto colado, imagem de encarte ou URL de perfil público).
- **Toggles**: WhatsApp e Instagram são ligados/desligados **no painel (aba SOCIAL)** — sem `.env`. O toggle do Instagram também sobe/derruba o microserviço Python. Padrão: ambos **desligados**.
- **⚠️ Aviso**: os módulos C2/C3 usam APIs **não oficiais** e violam os ToS. Use SEMPRE conta secundária dedicada.

### Análise com IA
- `POST /api/analyze` e `POST /api/local-insights/analyze` **enfileiram** jobs e respondem `{ jobId }`; a UI faz *poll* via `GET /api/jobs/:queue/:id`.
- Cadeia de provedores: **DeepSeek → Gemini → NVIDIA → LM Studio** (#54; DeepSeek é o principal — texto e imagem —, chave em AI CORE PARAMETERS ou `DEEPSEEK_API_KEY`; sem chave a cascata antiga continua igual).

---

## 🧪 Verificação (validação de cada fase)

```bash
npm run lint               # typecheck (tsc --noEmit)
docker compose ps          # Redis saudável
pm2 ls                     # 5 processos online, scan-worker 4/4
curl -s localhost:3001/api/status
curl -s "localhost:3001/api/jobs/scan-queue/<JOB_ID>"
```

Teste de estresse de 24h: `bash scripts/stress-test-24h.sh` (gera `RELATORIO_TESTE_24H.md`).

Em **VPS** (stack completa headless): ver [`GUIA_VPS.md`](GUIA_VPS.md) — bootstrap, 8 processos, checklist E2E tiers A/B/C e `bash scripts/stress-cluster-20.sh`.

---

## 🔑 Variáveis de ambiente

Ver `.env.example`. Destaques: `PORT=3001` (a 3000 pertence a outro serviço), `BIND_HOST=127.0.0.1` (restrito a localhost; use `0.0.0.0` deliberadamente para expor à LAN), `DEEPSEEK_API_KEY` (principal da cadeia de IA — texto/imagem), `GEMINI_API_KEY`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `REDIS_URL`, `SERPAPI_KEY` (Popular Times best-effort), `SOCIAL_MONITORING_ENABLED`, `INSTAGRAM_SERVICE_PORT=8721`. `INSTAGRAM_ENABLED` é apenas **fallback legado** do toggle do Instagram (hoje controlado pela UI).

---

## 📚 Documentos

- `DIAGNOSTICO.md` — histórico completo de fases (1–15), auditorias e decisões técnicas
- `INSTRUCOES_LOCAL.md` — guia do módulo local/ROTA (preços, roteirização, insights)
- `GUIA_SOCIAL.md` — configuração dos módulos WhatsApp/Instagram (C2/C3)
- `GUIA_VPS.md` — **deploy headless em VPS**, health checks e checklist E2E (#31)

---

## 🛣️ Estado & Roadmap

Fases **1–15 concluídas**: filas BullMQ + workers PM2, SQLite, monitoramento social (WhatsApp/Instagram), insights locais, scan recorrente de preços locais, auditorias de segurança (bind/Host), dedup/mescla de estabelecimentos. Roadmap detalhado, histórico e decisões em `DIAGNOSTICO.md`.

**Pendências abertas:**
- ~~**FASE 7** — validar o caminho **Gemini real** dos insights locais~~ — **RESOLVIDO (#29)**: `LocalTab` agora envia `profileId`; badge diferencia GEMINI / fallback.
- ~~**Instagram × PM2**~~ — **RESOLVIDO (#28)**: dono único PM2; spawn do `server.ts` removido; toggle usa `pm2 startOrReload`/`pm2 stop`; credenciais em `python_instagram/.ig.env` (gitignored).
- ~~**Cluster 4×**~~ — **RESOLVIDO (#30)**: lock 120s/60s + `scripts/stress-cluster-20.sh`. Execução local 20 jobs → **APROVADO** em `RELATORIO_TESTE_CLUSTER.md` (pico 17 concurrent, 4 workers, 0 stalled). VPS: `bash scripts/stress-cluster-20.sh`.
- ~~**Doc VPS + E2E**~~ — **RESOLVIDO (#31)**: runbook em [`GUIA_VPS.md`](GUIA_VPS.md) (bootstrap, health checks, checklist E2E A/B/C, carga, backup) + DIAGNOSTICO §6.16. Gate final FASE 16: executar Tier A–C **na VPS real**.
- ~~**market-handlers + fallback sem price_url**~~ — **RESOLVIDO (#32)**: registry por rede + cascade search/social; campo REDE na UI; toast `SOCIAL {n}`. DIAGNOSTICO §6.17.
- ~~**bulk/cron market-search**~~ — **RESOLVIDO (#33)**: cron/bulk inclui só-chain com keys (cap 8); sem keys = só price_url. DIAGNOSTICO §6.18.
- ~~**bridge social → price_observations**~~ — **RESOLVIDO (#34)**: Stories/WhatsApp/Telegram gravam promo **e** observação local (match de item, flash A/C). DIAGNOSTICO §6.19.
- ~~**sendWhatsappMessage lista+rota → operador**~~ — **RESOLVIDO (#35)**: `sendWhatsappMessage` só `@c.us` + composer + `POST /api/routes/:id/send-whatsapp` + botão LocalTab + setting `whatsapp_operator_chat_id`. DIAGNOSTICO §6.20.
- ~~**múltiplas listas + export CSV/TXT com melhor preço**~~ — **RESOLVIDO (#36)**: `shopping_lists` + `list_id`, seletor no Mercado, export só a lista aberta com `bestPrice`/loja (CSV/TXT). DIAGNOSTICO §6.21.
- ~~**export lista LISTS (Product Archives)**~~ — **RESOLVIDO (#37)**: CSV/TXT/COPIAR no header da lista aberta (nome, link, menor preço; client-side). DIAGNOSTICO §6.22.
- ~~**expandir seed de market-handlers**~~ — **RESOLVIDO (#38)**: `market-handlers.ts` 6 → 31 redes; placeholder REDE na UI; §6.23.
- ~~**boot crash `list_id` + open browser**~~ — **RESOLVIDO (#39)**: pré-migração antes do `CREATE INDEX`; abre `http://localhost:3001` no listen. §6.24.
- ~~**prioridade na lista de compras**~~ — **RESOLVIDO (#40)**: coluna `priority` (alta/media/baixa), ordenação alta→media→baixa, badge + form no Mercado, coluna CSV. §6.25.
- ~~**timeout tracking + progresso 99%**~~ — **RESOLVIDO (#41)**: pollJob 600s + onProgress real do worker; barra batch N/M (sem simulação/cap 99). §6.26.
- ~~**timeout 600s ainda estourava / metade dos targets**~~ — **RESOLVIDO (#42)**: orçamento 180s/tentativa no scraper, scrape `attempts:2`, poll de graça, dica retry N/2. §6.27.
- ~~**Shopee/ML: todas estratégias falham (NVIDIA 410 + Gemini 429)**~~ — **RESOLVIDO (#43)**: NVIDIA fail-fast + timeout 30s/modelo, Gemini circuit 1h, hint do slug da URL, SEARCH_VERIFY antes de LLM caro (NVIDIA → regex → Gemini). §6.28.
- ~~**Alerta falso no Telegram (R$ 7,18 ≤ alvo R$ 20 — frete/parcela)**~~ — **RESOLVIDO (#44)**: `isPriceRealistic` trava fallback do scraper, persistência e alerta no worker; prompt NVIDIA ignora frete/parcela. §6.29.
- ~~**Ordenação dos produtos na aba LIST**~~ — **RESOLVIDO (#45)**: seletor Padrão / Menor preço / Maior preço / A–Z / Z–A / **Ordem de compra** (botões ↑↓, `products.sort_order`, persiste no localStorage); export acompanha a ordem. §6.30.
- ~~**Comparação retornava catálogo/busca em vez de página do produto**~~ — **RESOLVIDO (#46)**: `isProductUrl` path-aware (AliExpress exige `/item/`, Amazon `/dp/`, Shopee `-i.<s>.<i>`, ML `MLB-<n>`); filtro em Gemini/NVIDIA/LM/Tavily/Serper + fallback do server; guard do handler AliExpress; `title` no schema Gemini habilita `sameProduct`. §6.31.
- ~~**Telemetria: deletados ressuscitavam + gráficos errados**~~ — **RESOLVIDO (#47)**: `mutateData`/`dataRef` com rollback (comparações longas e deletes não re-inserem), worker scan-all re-lê do banco antes de cada save, gráficos 1 ponto/dia sem órfãos + último ponto = `currentPrice` + série por `list.id`, ATIVIDADE RECENTE por `lastUpdated`, aba HISTÓRICO refetcha quando os produtos mudam. §6.32.
- ~~**Colar link tratado como já conhecido / sem busca + produto sumia da lista**~~ — **RESOLVIDO (#48)**: ADD manual `force` ignora o cache de 30min (`skipCache`); watermark `X-Loaded-At` no `POST /api/data` impede `saveAll` apagar produto criado após o load do cliente; dedup por **oferta** (`canonicalOfferUrl` = path + query limpa ordenada; outro vendedor = item separado `baseId~hash`) com refresh de url/imagem/preço+histórico e toasts no exists. §6.33.
- ~~**Marcar item como COMPRADO**~~ — **RESOLVIDO (#49)**: botão `ShoppingBag` ao lado de comparar/apagar, modal com **preço total pago obrigatório** (> 0), `bought_at`/`bought_price`; sai da lista ativa (conteúdo/export/budget/compare/recent/NODOS/scan-all), seção **BOUGHT ARCHIVE no fim da aba LISTS** com desfazer + badge no detalhe; histórico preservado (gráficos mantêm o preço congelado, PriceHistoryTab mantém o item). §6.34.
- ~~**Link do AliExpress virando produto errado ("800 Robux") / alertas sem aviso**~~ — **RESOLVIDO (#50)**: slug numérico não vira hint de busca, nome da página sobrevive sem preço e alimenta o hint, `titleMatchesHint` valida o nome do LLM da busca, preço de fallback pelo `pdp_npi` do link, alerta "⚠️ SCRAPE NÃO CONFIRMADO" na aba ALERTAS quando o dado vem só de busca; BOUGHT ARCHIVE agora sempre visível (estado vazio). §6.35.
- ~~**ESCANEAR MERCADO em lote: "Batch comparison timed out" e lista toda sem resultados**~~ — **RESOLVIDO (#51)**: poll do `compare-all` sem deadline fixo (detecção de travamento 8 min + cap 45 min, resultado nunca é descartado), `runComparison` com **NVIDIA antes do scrape** + confirmação por página top 3 a **90s** (sem confirmação = aceita NVIDIA filtrado), `buildSearchQuery` na ordem natural do nome (fim da sopa por tamanho), dedup de oferta AliExpress (`/i/` vs `/item/`, pt/www) e logs com contador `timeout/erro`. §6.36.
- ~~**SCAN PREÇOS da aba MERCADO invisível (só spinner, sem resultado, sem alerta) / ALERTAS sem limpar**~~ — **RESOLVIDO (#52)**: progresso real no job (`updateProgress` por item e por estratégia) com painel **dentro do card do estabelecimento** (barra %, item/estratégia, contadores vivos ✅/DUP/⚠, etapa n/total), card **ÚLTIMO SCAN** persistente com status por item (preço/método/URL), resumo do scan em ALERTAS (`🛒`/`⚠️ SCAN DE PREÇOS`, manual sempre, cron só com erros) + ícone `SCAN LOCAL`, e botão **LIMPAR TUDO** na Central de Alertas (`DELETE /api/notifications`). §6.37.
- ~~**Links que o ADD não encontrou se perdiam (14 colados, 7 entraram, sem retorno para copiar)**~~ — **RESOLVIDO (#53)**: ao terminar o lote o modal **fica aberto** com banner `X ENCONTRADOS • Y FALHARAM` e **BLOCO `LINKS NÃO ENCONTRADOS (n)`** com URL+erro por linha e botões **COPIAR** (só as URLs, 1 por linha), **RECOLHER NOS CAMPOS** (retry em 1 clique) e **LIMPAR**; falhas persistem no `localStorage` (reaparecem ao reabrir o modal/reload, inclui cancelamentos), mais **COPIAR FALHOS** no SCRAPE LOG. §6.38.
- ~~**IA sem provedor principal (Gemini 429 + NVIDIA lenta travando compare/scan/social)**~~ — **RESOLVIDO (#54)**: cadeia única **DeepSeek → Gemini → NVIDIA → LM Studio** para TUDO (texto, visão e social): chave `DEEPSEEK API KEY (PRINCIPAL)` nas settings (coluna `deepseek_api_key`, `deepseek.available` no `/api/status`, indicador no header), `src/lib/aiProviders.ts` (`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`, timeout 30s, log `[aiChain]`), estratégia `DEEPSEEK_VISION` primeira na cascata do scraper e LM Studio por último, compare/analyze/market-search/social todos com DeepSeek primeiro; sem chave = comportamento anterior intacto. §6.39.
- ~~**Tático: página de ofertas com preço errado (R$750) e promoções não aproveitadas**~~ — **RESOLVIDO (#55)**: **varredura** da `price_url` sem `{term}` 1× por scan (Playwright → DeepSeek vision/text → Gemini) salva promoções **com validade** (`source=sweep`, `SWEEP_TTL_HOURS=24`, upsert determinístico, inativação do que sumiu); **promo-cache** no scan usa a promo vigente **sem re-busca** (`promo-vigente`, histórico `promocao-vigente`); ADD em promoção → toast **EM PROMOÇÃO — mais barato agora**; resumo/UI com `PROMOÇÕES`/`PROMO-CACHE`. §6.40.
- ~~**Tático: scan do Tático → "ERROS 2" (varredura vazia + cascata `?q=` queimando 7 strategies)**~~ — **RESOLVIDO (#56)**: encarte do Tático é **100% imagem** (zero `R$` no DOM) → render da varredura agora tira **até 6 capturas** de viewport com cadeia **DeepSeek vision → Gemini vision → texto → parser det** (`extractDetOffers`, p/ páginas textuais); item sem promo em página de ofertas vira status **`FORA DAS OFERTAS`** (não conta erro, 0 strategies) ou error curto quando a varredura vira 0 — **nunca mais `?q=`** em ofertas-page. §6.41.
- ~~**Varredura só com Gemini (quota 20/dia) — NVIDIA/LM órfãos + JSON truncado → 0 promoções**~~ — **RESOLVIDO (#57)**: cadeia da varredura agora **DeepSeek vision → Gemini vision → NVIDIA vision → texto → LM Studio → det** (NVIDIA = `meta/llama-3.2-11b-vision-instruct`, 3000 tokens, timeout 300s; LM **último**, protegido: 2 capturas/1500 tokens/90s); `extractJsonArray` com **repair de truncagem** (`finish_reason=length`) e preço com vírgula (`"price": 22,78` → `"22.78"`); Gemini com `abortSignal` 45s. Smoke real: **80 promoções** do encarte salvas com validade 24h. LM Studio: `Qwen2.5-VL-3B-Instruct` Q4_K_M (3B — GTX 960 2GB VRAM). §6.42.
- ~~**Varredura errando nomes/preços ("Condominio Tresseme" por Condicionador TRESemmé)**~~ — **RESOLVIDO (#58)**: `SWEEP_PROMPT` com **transcrição literal** (descartar ilegível > inventar, dígito a dígito) + capturas em `deviceScaleFactor: 2`; smoke real: 60 promoções sem palavra inventada (ex.: `Biscoito Club Social (450g)`). §6.43.
- ~~**Promoções não levavam o item à lista de compras (redigitar à mão)**~~ — **RESOLVIDO (#59)**: botão **`ShoppingCart`** em cada card de promoção → item vai direto para a **lista ativa** com preço alvo = preço da promo; nome repetido (normalizado) só avisa `JÁ ESTÁ NA LISTA` sem duplicar. §6.44.
- ~~**Scan a cada X horas (AUTO-REFRESH/intervalos por frente)**~~ — **RESOLVIDO (#60)**: **horário único diário** `HH:MM` (`scan_daily_time`) — usuário escolhe o horário e e-commerce + mercado + social/instagram rodam **1× por dia**; inputs `<input type="time">` nas 3 telas (label DIÁRIO ÀS), scheduler de intervalo legado removido, catchup 24h; `PRÓXIMO SCAN` continua. DIAGNOSTICO §6.45.

---

*[SISTEMA SENTINELA ATIVO]*
