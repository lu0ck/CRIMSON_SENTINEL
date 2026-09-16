# 🗺️ Roadmap — Crimson Sentinel

> Estado atual consolidado: **v1.0.0** (tag `1.0.0`). Próximas fases serão adicionadas neste documento conforme definidas pelo operador.

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

- **FASE 7** — validar o caminho **Gemini real** dos insights locais (precisa `GEMINI_API_KEY` no perfil; hoje só o fallback determinístico foi exercitado).
- **Instagram × PM2** — o microserviço Python é gerenciado pelo PM2 **e** o `server.ts` também tenta spawná-lo na porta 8721 (EADDRINUSE em produção); o toggle da UI não derruba o processo do PM2. A decidir: reter apenas um dos dois donos.
- **Cluster 4×** — validar o `crimson-scan-worker` em cluster (até 20 jobs simultâneos) num scan real com muitos produtos.

---

## 🚧 Próximas fases

*(a definir — serão adicionadas aqui pelo operador)*

---

📄 Detalhamento técnico e decisões em [`DIAGNOSTICO.md`](DIAGNOSTICO.md) · Guia de uso em [`README.md`](README.md).