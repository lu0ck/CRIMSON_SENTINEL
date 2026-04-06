# 🛡️ Crimson Sentinel — Iron Man HUD Price Tracker

**Crimson Sentinel** é um rastreador de preços avançado inspirado na interface (HUD) do Homem de Ferro. Ele utiliza Inteligência Artificial de ponta para monitorar, analisar e notificar variações de preços em tempo real no mercado brasileiro.

---

## 🚀 Funcionalidades Principais

- **Monitoramento Inteligente:** Rastreia produtos em grandes varejistas (Amazon, Mercado Livre, Magalu, Kabum, etc.).
- **Análise de Mercado com IA:** O núcleo **SENTINEL** (baseado no Gemini 3 Flash) fornece análises concisas sobre tendências de preço, recomendações de compra e avaliação de risco.
- **Automação de Varredura:** O sistema realiza escaneamentos automáticos de mercado 2 vezes por dia (a cada 12 horas) para todos os produtos rastreados.
- **Notificações Multi-Plataforma:** Receba alertas instantâneos via **Discord**, **Telegram** ou **Email (Gmail)** quando um preço atingir seu alvo.
- **Interface HUD Imersiva:** Design futurista com animações de scanlines, partículas e grade tecnológica, totalmente responsivo e em Português.
- **Histórico de Telemetria:** Gráficos detalhados de variação de preço ao longo do tempo para cada item.

---

## 🛠️ Tecnologias Utilizadas

- **Frontend:** React 18, Vite, Tailwind CSS, Framer Motion (animações), Recharts (gráficos), Lucide React (ícones).
- **Backend:** Node.js, Express (API e automação).
- **IA & Dados:** 
  - **Google Gemini API:** Extração de dados de URLs e análise de mercado.
  - **Serper.dev / Tavily:** Motores de busca para comparação de preços em tempo real.
  - **NVIDIA API (Opcional):** Suporte para modelos Llama-3 para extração de alta precisão.
- **Notificações:** Nodemailer (Email), Webhooks (Discord/Telegram).

---

## 💻 Como Usar em Outros PCs

Para rodar o Crimson Sentinel em outra máquina, siga os passos abaixo:

### 1. Pré-requisitos
- **Node.js** (v18 ou superior) instalado.
- Uma chave de API do **Google Gemini** (obtenha em [ai.google.dev](https://ai.google.com/dev)).

### 2. Instalação
1. Clone ou baixe os arquivos do projeto.
2. Abra o terminal na pasta do projeto e instale as dependências:
   ```bash
   npm install
   ```

### 3. Configuração de Variáveis de Ambiente
Crie um arquivo `.env` na raiz do projeto (ou use o menu de configurações do app) com as seguintes chaves:
```env
GEMINI_API_KEY=sua_chave_aqui
# Opcionais para busca avançada:
SERPER_API_KEY=sua_chave_serper
TAVILY_API_KEY=sua_chave_tavily
```

### 4. Executando o Aplicativo
Para iniciar o servidor de desenvolvimento e a interface:
```bash
npm run dev
```
O aplicativo estará disponível em `http://localhost:3000`.

---

## 📡 Funcionamento Técnico

1. **Extração (Scraping):** Quando você adiciona uma URL, o backend utiliza o Gemini com `urlContext` para ler o site e extrair Nome, Preço (à vista/Pix), Imagem e Disponibilidade.
2. **Comparação (Market Scan):** O sistema usa motores de busca para encontrar o mesmo produto em outras lojas e a IA filtra os resultados para encontrar o menor preço real em estoque.
3. **Análise (AI Insight):** O **SENTINEL** processa o histórico de preços e gera um relatório estratégico em português com tom de HUD militar.
4. **Persistência:** Os dados são salvos localmente em um arquivo `data.json`, permitindo que suas listas e perfis sejam mantidos entre sessões.

---

## ⚠️ Notas de Segurança
- **API Keys:** Nunca compartilhe seu arquivo `.env` ou `data.json` que contenha chaves privadas.
- **Imagens:** O sistema possui um mecanismo de fallback (Picsum) caso a imagem original do lojista esteja protegida ou inacessível.

---
*Desenvolvido para ser o seu sentinela definitivo no mercado digital.* 
**[SISTEMA SENTINEL ATIVO]**
