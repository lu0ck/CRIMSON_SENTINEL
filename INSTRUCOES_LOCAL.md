# Crimson Sentinel — Guia de Instalação Local

Guia prático para rodar o Crimson Sentinel no seu PC (CachyOS/Arch) com a arquitetura de **fila de jobs (BullMQ + Redis)**.

---

## 1. Pré-requisitos

```bash
sudo pacman -S nodejs npm docker python python-pip
sudo systemctl enable --now docker          # Redis sobe via docker compose
sudo usermod -aG docker $USER               # reabra o terminal depois
```

## 2. Suba o Redis

```bash
docker compose up -d
docker compose ps                           # crimson-redis deve estar "healthy"
```

## 3. Instale as dependências

```bash
npm install
# apenas se for usar o módulo Instagram (C3):
cd python_instagram && pip install -r requirements.txt && cd ..
```

## 4. Configure o ambiente

```bash
cp .env.example .env
nano .env
```

Mínimo funcional: `GEMINI_API_KEY`. Opcionais recomendados: webhooks de notificação
(`DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`).

Módulos sociais ficam **desligados por padrão**:
```env
SOCIAL_MONITORING_ENABLED=false
WHATSAPP_ENABLED=false
INSTAGRAM_ENABLED=false
```
Ligue-os apenas quando tiver uma conta secundária dedicada (ver `python_instagram/README.md`).

## 5. Rode com PM2 (recomendado)

```bash
npm run pm2:start
pm2 ls
```

Deverá ver 5 processos:
| Processo | Função |
|---|---|
| `crimson-api` | API Express (porta 3000) |
| `crimson-scan-worker` (×4, cluster) | scraping, scan-all, compare, analyze, local-price-scan, discover |
| `crimson-route-worker` | roteirização (TSP/OSRM) |
| `crimson-social-worker` | captura/scan WhatsApp e Instagram |
| `crimson-instagram-service` | microserviço Python instagrapi (porta 8721) |

Acesse **http://localhost:3000**.

### Sem PM2 (desenvolvimento)
```bash
npm run dev                 # terminal 1: API + UI
npm run worker:scan         # terminal 2
npm run worker:route        # terminal 3
npm run worker:social       # terminal 4
```

## 6. Testando

```bash
npm run lint                # typecheck (tsc --noEmit)
curl -s localhost:3000/api/status
bash scripts/stress-test-24h.sh   # teste de estabilidade de 24h
```

## 7. App Desktop (Electron, opcional)

```bash
npm run electron:dev        # modo dev
npm run electron:build      # gera instalador em release/
```

---

## Dicas de segurança
- Nunca suba o `.env` com chaves reais para o GitHub (o `.gitignore` já bloqueia).
- O WhatsApp/Instagram real exige número/conta secundária — banimento é risco real.
- Chaves de IA podem ser definidas pela UI (aba CONFIG), sem tocar em arquivos.

---

## Solução de problemas

| Sintoma | Ação |
|---|---|
| Jobs nunca executam | `docker compose ps` — Redis deve estar UP; veja `pm2 logs` |
| `analyze` sempre falha | Configure `GEMINI_API_KEY` (ou LM Studio/NVIDIA) no perfil da UI |
| Scan social retorna "skipped" | `pm2 env 0 | grep WHATSAPP_ENABLED`; confira flags e sessão (QR/login) |
| `crimson-instagram-service` em erro | `pip install -r python_instagram/requirements.txt` e reinicie `pm2 restart crimson-instagram-service` |
