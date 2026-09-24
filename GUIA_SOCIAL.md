# Guia Completo — Aba SOCIAL do Crimson Sentinel

## Visão Geral

A aba **SOCIAL** permite monitorar promoções publicadas em canais de WhatsApp e Instagram automaticamente. O sistema detecta ofertas, extrai preços e cria promoções automaticamente no banco de dados do Crimson Sentinel.

O monitoramento social possui 4 módulos:

| Módulo | Sigla | O que faz |
|--------|-------|-----------|
| Captura manual de texto | — | Você cola uma mensagem de promoção e o sistema extrai os preços |
| WhatsApp Status (C2) | C2 | Escaneia Status de contatos comerciais automaticamente |
| Instagram Stories (C3) | C3 | Escaneia Stories de perfis comerciais com extração de preços via IA |
| Scan agendado | — | Executa os módulos acima automaticamente em intervalos configuráveis |

---

## Pré-requisitos

### 1. Redis (obrigatório)

O Redis é necessário para todas as filas de processamento assíncrono.

**Opção A — Docker:**
```bash
docker compose up -d
```

**Opção B — Redis compilado manualmente:**
```bash
cd /tmp
curl -fsSL https://download.redis.io/redis-stable.tar.gz -o redis.tar.gz
tar xzf redis.tar.gz && cd redis-stable
make -j$(nproc)
src/redis-server --daemonize yes --port 6379
```

**Verificar se está rodando:**
```bash
redis-cli ping
# Deve retornar: PONG
```

### 2. Variáveis de ambiente (.env)

Crie ou edite o arquivo `.env` na raiz do projeto:

```env
# Habilita o módulo de monitoramento social
SOCIAL_MONITORING_ENABLED=true

# Habilita monitoramento de conversas do WhatsApp (flyers)
# (ative no painel aba SOCIAL — WHATSAPP_ENABLED não é lido pelo código)

# Habilita escaneamento de Instagram Stories (C3)
INSTAGRAM_ENABLED=true

# Chave da API Gemini (usada para extração de preços por IA e visão)
# Obtenha em: https://aistudio.google.com/apikey
GEMINI_API_KEY=sua-chave-aqui

# Microserviço Instagram (para C3) — dono único: PM2 (#28)
INSTAGRAM_SERVICE_PORT=8721
INSTAGRAM_SERVICE_URL=http://127.0.0.1:8721

# Conta secundária do Instagram (para C3)
# Prefira salvar no painel SOCIAL: o API grava python_instagram/.ig.env
# (gitignored) e faz pm2 startOrReload sentinela-instagram-service.
IG_USERNAME=seu_usuario_secundario
IG_PASSWORD=sua_senha
```

### 3. Microserviço Instagram (necessário apenas para C3)

**Dono único: PM2** (`sentinela-instagram-service`). O `server.ts` **não** faz mais spawn na porta 8721 (evita EADDRINUSE).

```bash
# Setup do venv (uma vez)
bash scripts/setup-instagram.sh

# Subir stack (inclui instagram-service)
pm2 start ecosystem.config.cjs

# Controle via painel SOCIAL (toggle/credenciais) ou manualmente:
pm2 startOrReload ecosystem.config.cjs --only sentinela-instagram-service
pm2 stop sentinela-instagram-service
pm2 status sentinela-instagram-service
```

> Credenciais ficam em `python_instagram/.ig.env` (gravado ao salvar no painel, chmod 600, gitignored). O serviço roda em 127.0.0.1:8721.

### 4. Iniciar o worker social (já incluído no pm2)

Se usar pm2:
```bash
pm2 start ecosystem.config.cjs
```

Se rodar manualmente:
```bash
npm run worker:social
```

---

## Passo a Passo: Usando a Aba SOCIAL

### Passo 1 — Acessar a aba

1. Clique no ícone **SOCIAL** na barra lateral esquerda do Crimson Sentinel
2. Você verá a seção "MONITORAMENTO SOCIAL" com o contador de fontes e o timer de próximo scan

---

### Passo 2 — Cadastrar uma Fonte de Monitoramento

Clique em **"ADICIONAR FONTE"** para cadastrar um canal que você deseja monitorar.

**Campos do formulário:**

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| **CANAL** | Sim | Selecione `WhatsApp` ou `Instagram` |
| **NOME** | Sim | Nome descritivo da fonte. Ex: "Grupo Promoções do Bairro" |
| **URL INSTAGRAM** | Não | URL do perfil do Instagram (apenas para Instagram). Ex: `https://instagram.com/mercadolivre` |
| **ESTABELECIMENTO** | Não | Dica de nome do estabelecimento para matching automático. Ex: "Mercado Bom Preço" |

**Dicas:**
- Para **WhatsApp**: cadastre cada grupo ou contato que envia promoções como uma fonte separada
- Para **Instagram**: a URL deve ser o link do perfil público. Ex: `https://instagram.com/supermercadox`
- O campo **ESTABELECIMENTO** ajuda o sistema a associar a promoção ao estabelecimento correto. Se o nome do mercado aparecer no texto da promoção, o sistema detecta automaticamente. Caso contrário, usa essa dica.

Clique em **"SALVAR FONTE"**.

---

### Passo 3 — Captura Manual de Promoções (WhatsApp)

Na seção **"CAPTURA MANUAL — COLE A MENSAGEM"**:

1. Copie o texto de uma promoção que você recebeu no WhatsApp
2. Cole no campo de texto
3. Clique em **"EXTRAIR PROMOÇÕES"**

**Formato esperado da mensagem:**

O sistema entende diversos formatos, incluindo:

```
Café 500g de R$ 24,90 por R$ 17,90
```

```
OFERTA RELÂMPAGO!
Arroz Tipo 1 5kg - de R$29,90 por R$21,90
Feijão Carioca 1kg - de R$12,90 por R$8,90
```

```
Promoção Carrefour
Leite integral 1L: R$4,99 (era R$6,49)
```

**O que o sistema faz:**
1. Analisa o texto com regex determinístico + IA Gemini (se disponível)
2. Extrai: nome do produto, preço regular, preço promocional
3. Tenta identificar o estabelecimento (pelo nome no texto ou pela dica cadastrada)
4. Calcula o percentual de desconto
5. Verifica se não é promoção duplicada (mesmo produto + mesmo estabelecimento)
6. Salva a promoção no banco de dados
7. Dispara notificações (Discord/Telegram/Gmail) se configuradas

---

### Passo 4 — WhatsApp Real / Status (C2)

> **ATENÇÃO:** Este módulo usa uma **conta secundária** do WhatsApp. Use uma conta que não seja a principal, pois existe risco de ban.

#### 4.1 — Autenticar o WhatsApp

1. Clique em **"GERAR QR"**
2. Um QR code aparecerá no terminal/console
3. Abra o WhatsApp na conta secundária → **Aparelhos conectados** → Escaneie o QR
4. O status deve mudar para "CONECTADO"

#### 4.2 — Configurar estabelecimentos (opcional)

Para atribuir promoções detectadas em conversas diretas ao estabelecimento correto, preencha o campo `whatsapp_number`:

1. Na aba **LOCAL**, edite ou crie um estabelecimento
2. Preencha o campo de número de WhatsApp com o DDD + número. Ex: `11999887766`

#### 4.3 — Monitoramento automático

Após conectar a sessão (QR), o sistema monitora **em tempo real**:

- **Mensagens de grupo** — texto é processado e promoções são extraídas com IA
- **Conversas diretas** — texto processado + **imagens de flyer são baixadas automaticamente** e interpretadas via Gemini Vision
- Todas as promoções detectadas salvas com `source: "whatsapp"` e disparam alertas

Não há scan manual de Status — o monitoramento é contínuo via listener.

#### 4.4 — Enviar lista + rota no WhatsApp do operador (#35)

Mesma sessão do leitor (processo da API), **envio dedicado** para o chat do operador — **somente `@c.us`** (grupos/broadcast bloqueados). **Sem auto-send**: só botão.

1. No painel **SOCIAL → WHATSAPP**, preencha **CHATID DO OPERADOR** (`5511999999999` ou `5511999999999@c.us`) e clique **SALVAR**
2. Sessão precisa estar **CONECTADA** (toggle ATIVAR + QR)
3. Na aba **LOCAL**, no card da rota, clique no ícone **Send** (verde)

`POST /api/routes/:id/send-whatsapp` — guards: 403 toggle off · 400 chatId inválido/grupo · 409 sessão · 404 rota. Mensagem: lista única + paradas + custos (split se &gt;4000 chars). Setting: `whatsapp_operator_chat_id` (`user_settings`). DIAGNOSTICO §6.20.

---

### Passo 5 — Instagram Stories (C3)

> **ATENÇÃO:** Este módulo requer uma **conta secundária** do Instagram. Risco de ban se usado excessivamente.

#### 5.1 — Iniciar o microserviço (PM2 — dono único #28)

```bash
bash scripts/setup-instagram.sh   # venv uma vez
pm2 startOrReload ecosystem.config.cjs --only sentinela-instagram-service
pm2 status sentinela-instagram-service
```

> O toggle **ATIVAR/DESATIVAR** no painel e o salvamento de credenciais já disparam `pm2 startOrReload` / `pm2 stop` automaticamente. Credenciais ficam em `python_instagram/.ig.env` (não no `.env`).

#### 5.2 — Autenticar

1. Configure usuário/senha no painel SOCIAL (Instagram → credenciais) — grava `.ig.env`
2. Clique em **"LOGIN"** no Instagram da aba Social
3. O sistema autentica via instagrapi e salva a sessão

#### 5.3 — Configurar handles

1. Na aba **LOCAL**, edite um estabelecimento
2. Preencha o campo `Instagram Handle` com o nome de usuário (sem @). Ex: `mercadolivre`

#### 5.4 — Executar o scan

1. Clique em **"SCAN STORIES"**
2. O sistema:
   - Para cada estabelecimento com handle cadastrado
   - Baixa os stories ativos
   - Se tiver Gemini API Key: analisa as imagens com **Gemini Vision** para extrair preços de fotos
   - Extrai preços dos captions de texto
   - Cria promoções como "RELÂMPAGO" (24h)

**Throttle:** **45 minutos** entre verificações do mesmo handle.

**Modo sem IA (sem Gemini):** Apenas captions de texto são analisados. Imagens são ignoradas.

---

### Passo 6 — Configurar Scan Automático Agendado

Na seção superior da aba SOCIAL, você encontra:

| Configuração | Opções | Padrão |
|-------------|--------|--------|
| **Frequência** | 1h / 6h / 12h / 24h | 6h |

Ao alterar a frequência, o sistema reagenda automaticamente o scan periódico.

**O que o scan automático faz:**
1. Para cada fonte **habilitada** e com canal ativo
2. Executa a captura (texto do WhatsApp ou URL do Instagram)
3. Processa e salva as promoções encontradas

---

### Passo 7 — Ativar/Desativar uma Fonte

Na lista de fontes cadastradas:
- Fontes desativadas mostram o badge **"OFF"**
- O scan automático pula fontes desativadas
- A captura manual funciona independentemente do estado enabled/disabled

---

### Passo 8 — Deletar uma Fonte

Clique no ícone de **lixeira** ao lado da fonte para removê-la permanentemente.

---

## Endpoints da API Social (para desenvolvedores)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/social/sources` | Lista todas as fontes |
| `POST` | `/api/social/sources` | Cria/atualiza uma fonte |
| `DELETE` | `/api/social/sources/:id` | Deleta uma fonte |
| `POST` | `/api/social/capture` | Captura manual: `{ channel, text }` |
| `POST` | `/api/social/scan-all` | Enfileira scan de todas as fontes |
| `GET` | `/api/social/whatsapp/qr` | Gera QR code do WhatsApp |
| `GET` | `/api/social/whatsapp/status` | Status da conexão WhatsApp |
| `POST` | `/api/social/whatsapp/toggle` | Ativa/desativa o monitoramento |
| `GET` | `/api/social/instagram/health` | Health check do microserviço |
| `POST` | `/api/social/instagram/login` | Login no Instagram |
| `POST` | `/api/social/instagram/scan` | Enfileira scan de Stories |
| `GET` | `/api/social/settings` | Obtém configurações de scan |
| `PUT` | `/api/social/settings` | Atualiza intervalo `{ intervalMs }` |

---

## Tabela de Notificações

Quando uma promoção é detectada, o sistema pode notificar via:

| Canal | Configuração | Requisitos |
|-------|-------------|------------|
| **Discord** | `discord_webhook` no perfil | URL do webhook do Discord |
| **Telegram** | `telegram_token` + `telegram_chat_id` no perfil | Bot token + chat ID |
| **Email** | `gmail_user` + `gmail_pass` no perfil | Conta Google com App Password |

**Tipos de alerta:**
- **Promoção normal**: Detectada via texto ou captura manual
- **Relâmpago (FLASH)**: Detectada via WhatsApp Status ou Instagram Stories (expira em 24h)
- **Deduplicação**: O mesmo produto + estabelecimento não gera notificação repetida dentro de 24h (ou 1h para flash)

---

## Dicas e Boas Práticas

1. **Contas secundárias**: Use contas descartáveis para WhatsApp e Instagram. O uso automatizado pode levar ao ban.

2. **Grupo de WhatsApp**: Adicione o número do Crimson Sentinel (via WhatsApp Web.js) em grupos de promoções para maximizar a captura.

3. **Gemini API Key**: Configure para obter extração de preços muito mais precisa, incluindo análise de imagens via Gemini Vision.

4. **Estabelecimentos**: Cadastre os estabelecimentos primeiro (aba LOCAL) antes de cadastrar fontes sociais. Isso melhora o matching automático.

5. **Frequência**: Comece com scan a cada 6h. Se receber muitas promoções, diminua para 1h. Se pouco conteúdo, aumente para 12h ou 24h.

6. **Monitorar**: Acompanhe as promoções detectadas na seção "PROMOÇÕES" da aba LOCAL para ver o resultado do monitoramento.

---

## Solução de Problemas

| Problema | Causa | Solução |
|----------|-------|---------|
| "DESLIGADO" no WhatsApp | Toggle `whatsapp_enabled` desligado | Clique em ATIVAR no painel social |
| "NAO AUTENTICADO" no WhatsApp | Sessão expirada | Clique em "GERAR QR" e escaneie novamente |
| "SERVICO OFF" no Instagram | Microserviço PM2 parado/out | `pm2 status sentinela-instagram-service` e `pm2 startOrReload ecosystem.config.cjs --only sentinela-instagram-service` |
| "SEM SESSAO" no Instagram | Credenciais não configuradas | Configure `IG_USERNAME` e `IG_PASSWORD` no .env |
| Nenhuma promoção detectada | Fontes desabilitadas ou sem conteúdo | Verifique se as fontes estão habilitadas e se há promoções recentes nos canais |
| Redis error (ECONNREFUSED) | Redis não está rodando | Execute `docker compose up -d` ou inicie o Redis manualmente |
| Scan demora muito | Muitos estabelecimentos/contatos | Aumente o throttle ou reduza o número de fontes |
