# 🗺️ Roadmap — Crimson Sentinel

> Estado atual consolidado: **v1.0.0** (tag `1.0.0`). Próximas fases (FASES 14-16) detalhadas abaixo, com ferramentas e plano de execução.

---

## 📦 Versões (resumo por fase)

| Fase | O que entregou |
|---|---|
| **FASE 1** | SQLite + repositórios (`src/repositories/`, `schema.sql`) — fim do `data.json` direto |
| **FASE 2** | Filas **BullMQ + Redis** e workers isolados (PM2) — fim das chamadas síncronas no Express (`/api/scrape`, `/api/compare`, `/api/analyze` viram jobs) |
| **FASE 3** | Hardening do scraper: circuit breaker, cache por `DATA_DIR`, normalização centralizada de URL/preço |
| **FASE 4** | Frontend migrado para o contrato assíncrono (polling de jobs `{jobId}` + AbortSignal) |
| **FASE 5** | Módulo local: estabelecimentos, lista de compras, promoções, roteirização **TSP/OSRM** por veículo |
| **FASE 6** | Alertas **Discord/Telegram/email** + `notification_log` (dedup anti-spam + cooldown) |
| **FASE 7** | Insights locais: análise determinística imediata + narrativa **Gemini** (assíncrona, fallback determinístico) |
| **FASE 8** | Monitoramento social C2/C3: WhatsApp (texto colado) e Instagram (captions + Gemini Vision) |
| **FASE 9** | Agendador recorrente do scan social (repeatable job BullMQ, 6h default) |
| **FASE 10** | Painel de histórico de preços (series e-commerce + local unificadas) |
| **FASE 11** | Scan de preços locais assíncrono (`price_url`, `{term}`) + migração de ambiente (porta **3001**, cluster 4×, venv Instagram) |
| **FASE 12** | Agendador do scan de preços locais (repeatable job, intervalo configurável na UI) + auditoria |
| **FASE 13** | Auditoria: `syncPriceHistory` incremental, `gemini.ts` removido, **segurança** (bind 127.0.0.1 + Host allowlist), **toggle Instagram runtime**, **dedup/mescla de estabelecimentos**, WhatsApp (sessão) verificado |
| **FASE 14** | ✅ **Concluída** — Rastreio 100%: extrator genérico v2, merge entre estratégias, `SEARCH_VERIFY`, `GEMINI_VISION`, validação 8/8 |
| **FASE 15** | ✅ **Concluída** — Toast de erro 45s, erros de scrape na Central de Alertas, aba **MERCADO**, reordenamento do menu, backup no perfil |
| **FASE 16** | *(planejada)* Local/Mercado inteligente: lista de compras → melhor preço/localização → rota de casa → envio no WhatsApp |

---

## 🧩 Resumo por área (o que já está pronto)

- **E-commerce**: scraper multi-estratégia (Playwright + fallbacks), busca/compare via Serper/Tavily, análise com cascata **LM Studio → NVIDIA → Gemini**, histórico de preços e cache.
- **Arquitetura**: filas **BullMQ** (scan / route / social) + Redis (docker-compose), **PM2** (api + scan-worker 4×cluster + route + social + instagram-service), **SQLite** via repositórios.
- **Módulo Local**: descoberta de mercados via Overpass/OSM (dedup por `osm_id`), scan de preços por `price_url`, roteirização TSP/OSRM (carro/moto/ônibus/bike/a pé + Popular Times), insights locais (melhor preço por item, estratégias multi-parada × tudo-em-um × economia).
- **Social (C2/C3)**: captura manual de texto, `whatsapp-web.js` (Status de contatos, QR no painel), Stories do Instagram via instagrapi + **Gemini Vision**, throttles configuráveis por contato/handle, dedup de promoções.
- **Notificações**: Discord/Telegram/email, dedup anti-spam, cooldown, alerta prioritário de **RELÂMPAGO** no Telegram.
- **UI (HUD)**: abas CONFIG / E-COMMERCE / LOCAL / HISTÓRICO / SOCIAL / NOTIFICAÇÕES, badgetes flash, painel de insights, scheduler local, export/import JSON, toasts.
- **Segurança/Auditoria**: bind `127.0.0.1` + Host allowlist (anti DNS rebinding), chaves via UI (perfil, sem `.env` obrigatório), `BIND_HOST` explícito, histórico de preços incremental (idempotente), código morto removido, `trustedDomains`/`aiModels` centralizados.
- **Infra**: porta dedicada **3001**, `docker-compose` Redis, bootstrap do cluster via `scan-worker-cluster.mjs`, `INSTAGRAM_ENABLED` virou fallback legado (toggle na UI), testes de estresse 24h.

---

## ⚠️ Pendências abertas

- **FASE 7** — validar o caminho **Gemini real** dos insights locais (a `GEMINI_API_KEY` já foi configurada no perfil; falta validar o fluxo de narrativa + habilitar `GEMINI_FALLBACK` no scrape).
- **Instagram × PM2** — o microserviço Python é gerenciado pelo PM2 **e** o `server.ts` também tenta spawná-lo na porta 8721 (EADDRINUSE em produção); o toggle da UI não derruba o processo do PM2. A decidir: reter apenas um dos dois donos.
- **Cluster 4×** — validar o `crimson-scan-worker` em cluster (até 20 jobs simultâneos) num scan real com muitos produtos.
- **Vitrine de validação (8 links)** — ✅ **8/8** com nome, preço e foto (detalhe na FASE 14): 3× AliExpress, 1× Kabum, 1× Pichau, 1× Amazon, 2× Mercado Livre.

---

## 🚧 Próximas fases

### FASE 14 — Rastreio 100% (nome, preço e foto)

**Objetivo**: todo link de produto rastreado com **nome completo**, **preço correto (menor à vista)** e **foto do produto — 8/8** nos links de validação.

**Estratégia (camadas em cascata, de barata a cara):**
1. **Extrator genérico v2** — reescrever a extração "genérica" p/ resolver os 3 campos com múltiplas âncoras:
   - **Nome**: `og:title` → JSON-LD (`Product.name`) → `<h1>` (removendo sufixo do site, ex. " | KaBuM!"); rejeitar máscara de filtro/ordenação.
   - **Foto**: `og:image` → JSON-LD (`image`) → 1ª `<img>` grande do bloco do produto; resolver `meta itemprop=image`.
   - **Preço**: provar os `class*=price`/jsons (`itemprop=price`, `data-price`, JSON-LD `offers.price`) e, no fallback de texto, **proximidade do nome do produto** (região ao redor do `h1` — evita pegar preço de menu/lateral/parcela); preferir "Por" > mais frequente > menor.
   - **Confirmação dupla**: um preço só é aceito se uma **2ª fonte independente** na mesma página concordar (ex.: JSON-LD + DOM, ou 2 seletores). Elimina os "valores errados".
2. **Merge entre estratégias** — hoje uma estratégia que devolve preço bom mas nome vazio é descartada inteira. Passar a **compor** o melhor resultado: `bestName` + `bestPrice` + `bestImage` vindos de estratégias diferentes (ex.: FETCH traz `og:image`/`<title>` baratos; Playwright traz preço do DOM).
3. **`SEARCH_VERIFY` (novo fallback pós-Gemini)** — se todas as estratégias de página falharem, usar **Serper/Tavily + NVIDIA/Gemini (grounding)** — APIs já ativas — para buscar o `og:title`/nome do produto e extrair preço canônico da loja.
4. **`GEMINI_VISION`** — com a key ativa, screenshot via Playwright + **definir Unity Gemini Vision** (`gemini-2.0-flash`) p/ extrair nome/preço quando o HTML for ilegível (paywall/bot).
5. **Cache 30min** p/ resultado validado; inválido quando faltar preço/nome/foto.

**Ajustes de store-handlers** específicos p/ os alvos de teste: AliExpress (3×), Kabum (SSD Kingston), Pichau (fonte XPG — OK), Amazon (gabinete Kalkan), Mercado Livre (kit fans + pasta térmica).

**Validação**: script que roda os 8 links e exige nome válido + preço plausible + foto HTTP — executa na FASE e permite regressão a cada mudança. (Detalhes no DIAGNOSTICO.)

---

### FASE 15 — UI, Alertas e a nova aba MERCADO

**15a. Notificação (toast) de erro mais durável**: erro `15s → 45s` (a duração vive em `src/App.tsx` — `ToastWithTimer` + auto-remove; uma constante central).

**15b. Erros de scrape na Central de Alertas (sino)**:
- Novo `POST /api/notifications` que grava `notification_log` **in-app** (sem Discord/Telegram), com **dedup por URL em 1h** (anti-spam).
- Grava em 3 pontos: catch do `/api/scrape` (path direto), `worker.on('failed')` p/ jobs `scrape`, e erro por produto no `handleScanAll`.
- `NotificationsTab` ganha a entidade `SCRAPE` (ícone próprio) e o **badge do sino** recarrega ao fim de cada lote.

**15c. Nova aba MERCADO + reorganização do menu lateral**:
- Novo menu: **DASHBOARD → LISTS → MERCADO → LOCAL → SOCIAL → ALERTAS → HISTÓRICO → CONFIG** (`src/App.tsx`).
- **Aba MERCADO nova** (`src/components/MercadoTab.tsx`) recebendo os blocos do LocalTab: **Lista de Compras, Estabelecimentos (+ Duplicados), Promoções e Sites de Promoções**.
- **BACKUP e RESTAURAÇÃO** sai do LocalTab e vai para **CONFIG (perfil)**.
- LocalTab passa a focar só em: endereço/descoberta de mercados **+ scan de preços + roteirização + insights**.

**15d. (bônus enxuto)** — ajustes cosméticos de HUD conforme combinado.

---

### FASE 16 — Aba Local/Mercado Inteligente 100% (a grande entrega)

**Objetivo**: **funcionando de ponta a ponta** e **em VPS (segundo plano)** — com IA (texto + visão), reconhecimento de imagem, agendadores e envio automático no WhatsApp.

**Fluxo do operador:**
1. Cadastro do **endereço de casa** (já existe) e **lista de compras livre** (ex.: "arroz tio jorge 5kg", "televisão panasonic 42\"", com qtd/categoria/prioridade).
2. O sistema **varre fontes** e devolve por item: **nome, preço mais barato e localização** (comércio onde comprar).
3. Monta a **rota** a partir da casa (onde comprar cada item e **quanto gastar**).
4. Envia uma **cópia da lista + roteiro no WhatsApp** (além de Discord/Telegram/email).

**Fontes de dados → ferramentas:**
| Fonte | Ferramenta atual | Ações |
|---|---|---|
| **Sites dos comércios** (Tatico, Bretas, etc.) | `store-handlers` + novo registry **`market-handlers`** por rede + **Serper/Tavily** na busca "«item» «rede» preço" | Extração estruturada via **Gemini/NVIDIA**; sem catálogo web → marcado como dependente de social |
| **Stories dos mercados** (Instagram) | venv `instagrapi` (:8721) + **Gemini Vision** | Reconhecimento de **preço na imagem** do story → vira observação local |
| **Grupos de promoções no WhatsApp** | `whatsapp-web.js` (`message_create` filtrando grupos) | Parse via regex → **Gemini** → "produto — R$ — supermercado" → observação local |
| **Status de contatos de mercado** | já implementado | continua |

**Roteirização**: infra pronta (OSRM/TSP + veículo + Popular Times + melhor cesta). Adaptar para: menor preço por item + **agrupar por loja** quando a economia superar o custo de deslocamento; ponto de partida = endereço cadastrado.

**WhatsApp**: sessão já implementada (`whatsappSession.ts`); adicionar `client.sendMessage(chatId, lista+roteiro)` para o chat do operador (configurável). **Envio separado do "ler promoções"** (mesma sessão, dedicada).

**Segundo plano / VPS**:
- Tudo nos workers BullMQ existentes (scan/social) com **repeatable jobs** (social 6h + local-price-scan) e catch-up no boot.
- Produto roda **headless no VPS** (sem Electron): api (Node/PM2) + venv Instagram + Redis (docker ou nativo) + `BIND_HOST` + SQLite; WhatsApp linkado via QR à distância (uma vez); contas **secundárias dedicadas** (ToS).
- **Validação ponta a ponta em VPS** antes de dar como FASE concluída; documentação de setup no `DIAGNOSTICO`.

**Riscos assumidos** (registrados no roadmap): redes locais podem **não ter catálogo online** (vira coleta social/manual); web scraping e automação de WhatsApp/Instagram **violam ToS** — uso de conta secundária; qualidade depende das fontes publicadas.

---

📄 Detalhamento técnico e decisões em [`DIAGNOSTICO.md`](DIAGNOSTICO.md) · Guia de uso em [`README.md`](README.md).