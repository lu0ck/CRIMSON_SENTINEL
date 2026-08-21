import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn, exec } from "child_process";
import {
  sendDiscordNotification,
  sendTelegramNotification,
  sendEmailNotification
} from "./src/lib/notifications.ts";
import { getDb } from "./src/database/db";
import { AppDataRepository } from "./src/repositories/appDataRepository.ts";
import { ProductRepository } from "./src/repositories/productRepository.ts";
import { ProfileRepository } from "./src/repositories/profileRepository.ts";
import { SettingsRepository } from "./src/repositories/settingsRepository.ts";
import { safeLog } from "./src/lib/safeLog.ts";
import { normalizeProductUrl, generateProductId } from "./src/lib/url.ts";
import { getScanQueue, getRouteQueue, getSocialQueue } from "./src/queue/queues.ts";
import { registerSchedulers, registerSocialScheduler, unregisterSocialScheduler, listSocialScheduledJob } from "./src/queue/schedulers.ts";
import { haversineKm, geocodeAddress, geocodeFromCep } from "./src/lib/geo.ts";
import { lookupCep } from "./src/lib/cep.ts";
import { EstablishmentRepository } from "./src/repositories/establishmentRepository.ts";
import { ShoppingListRepository } from "./src/repositories/shoppingListRepository.ts";
import { PriceObservationRepository } from "./src/repositories/priceObservationRepository.ts";
import { PromotionRepository } from "./src/repositories/promotionRepository.ts";
import { RouteRepository } from "./src/repositories/routeRepository.ts";
import { NotificationRepository } from "./src/repositories/notificationRepository.ts";
import { SocialSourceRepository } from "./src/repositories/socialSourceRepository.ts";
import { PromotionSiteRepository } from "./src/repositories/promotionSiteRepository.ts";
import {
  alertShoppingItemTargetReached,
  alertActivePromotion,
} from "./src/lib/notify.ts";
import { buildLocalInsights, summarizeInsights } from "./src/lib/localInsights.ts";
import {
  buildEcommerceEntities,
  buildLocalEntities,
  filterByRange,
  type PriceHistoryEntity,
} from "./src/lib/priceHistory.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use USER_DATA_PATH for Electron production, or current dir for dev
// SQLite database replaces data.json (FASE 1)
getDb();

async function startServer() {
  console.log("=".repeat(80));
  console.log("CRIMSON SENTINEL SERVER STARTING...");
  console.log("Time:", new Date().toISOString());
  console.log("Node Env:", process.env.NODE_ENV);
  console.log("=".repeat(80));
  
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/data", (req, res) => {
    safeLog('GET /api/data requested');
    try {
      const data = AppDataRepository.getAll();
      safeLog('Data read success, profiles: ' + data.profiles.length + ', products: ' + data.products.length);
      res.json(data);
    } catch (error) {
      safeLog("Error reading database: " + error);
      res.status(500).json({ error: "Failed to read database" });
    }
  });

  app.post("/api/data", (req, res) => {
    try {
      AppDataRepository.saveAll(req.body);
      res.json({ status: "ok" });
    } catch (error) {
      safeLog("Error saving data: " + error);
      res.status(500).json({ error: "Failed to save data" });
    }
  });

  app.post("/api/products", (req, res) => {
    try {
      const product = req.body;
      const data = AppDataRepository.getAll();

if (!data.products) data.products = [];

// Prevent duplicates by normalized URL and listId
    const normalizedUrl = normalizeProductUrl(product.url);
    const normalizedId = generateProductId(product.url);

    safeLog("[Product] Checking: url=" + normalizedUrl + ", id=" + normalizedId);

    const exists = data.products.some((p: any) => {
      const normalizedExisting = normalizeProductUrl(p.url);
      const urlMatch = normalizedExisting === normalizedUrl;
      const idMatch = p.id === normalizedId;
      safeLog("[Product] Compare with existing: " + p.id + " vs " + normalizedId + " (idMatch=" + idMatch + ")");
      return (urlMatch || idMatch) && p.listId === product.listId;
    });

    // Se existe, verificar se o nome está correto
    if (exists) {
      const existingProduct = data.products.find((p: any) =>
        (normalizeProductUrl(p.url) === normalizedUrl || p.id === normalizedId) && p.listId === product.listId
      );

      // Se o produto existente tem nome muito diferente do novo, pode ser dado corrompido
      if (existingProduct && product.name && existingProduct.name) {
        const existingNameLower = existingProduct.name.toLowerCase();
        const newNameLower = product.name.toLowerCase();

        // Verificar se os nomes têm palavras em comum
        const existingWords = existingNameLower.split(/\s+/);
        const newWords = newNameLower.split(/\s+/);
        const commonWords = existingWords.filter(w => w.length > 3 && newWords.includes(w));

        if (commonWords.length === 0) {
          // Nomes completamente diferentes - dados corrompidos
          safeLog("[Product] WARNING: Existing product has completely different name!");
          safeLog("[Product] Existing: " + existingProduct.name);
          safeLog("[Product] New: " + product.name);
          safeLog("[Product] Deleting corrupted product and adding new one...");

          // Deletar produto corrompido
          ProductRepository.delete(existingProduct.id);

          // Adicionar novo produto
          if (!product.id || product.id.length < 8) {
            product.id = normalizedId;
          }
          ProductRepository.save(product);
          safeLog("Product added (replaced corrupted): " + product.name + " to list " + product.listId + " (ID: " + product.id + ")");
          res.json({ status: "ok", action: "replaced", product: product });
          return;
        }
      }
    }

    if (!exists) {
      // Use normalized ID if not given
      if (!product.id || product.id.length < 8) {
        product.id = normalizedId;
      }
      ProductRepository.save(product);
      safeLog("Product added: " + product.name + " to list " + product.listId + " (ID: " + product.id + ")");
      res.json({ status: "ok", action: "added", product: product });
    } else {
      safeLog("Product already exists: " + normalizedUrl + " in list " + product.listId);
      // Atualizar preço se encontrou versão mais recente
      const existingProduct = data.products.find((p: any) =>
        (normalizeProductUrl(p.url) === normalizedUrl || p.id === normalizedId) && p.listId === product.listId
      );
      if (existingProduct && product.currentPrice && product.currentPrice !== existingProduct.currentPrice) {
        existingProduct.previousPrice = existingProduct.currentPrice;
        existingProduct.currentPrice = product.currentPrice;
        existingProduct.lastUpdated = new Date().toISOString();
        existingProduct.priceHistory = existingProduct.priceHistory || [];
        existingProduct.priceHistory.push({
          date: new Date().toISOString(),
          price: product.currentPrice
        });
        ProductRepository.save(existingProduct);
        safeLog("Product price updated: " + existingProduct.name + " from R$ " + existingProduct.previousPrice + " to R$ " + existingProduct.currentPrice);
        res.json({ status: "ok", action: "updated", product: existingProduct });
      } else {
      res.json({ status: "ok", action: "exists", product: existingProduct });
      }
    }
  } catch (error) {
    safeLog("Error adding product: " + error);
    res.status(500).json({ error: "Failed to add product" });
  }
});

  app.post("/api/test-discord", async (req, res) => {
    const { webhookUrl } = req.body;
    try {
      await sendDiscordNotification(webhookUrl, "🚀 Crimson Sentinel: Teste de Conexão Discord bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-telegram", async (req, res) => {
    const { botToken, chatId } = req.body;
    try {
      await sendTelegramNotification(botToken, chatId, "🚀 Crimson Sentinel: Teste de Conexão Telegram bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-email", async (req, res) => {
    const { user, pass, to } = req.body;
    try {
      await sendEmailNotification(user, pass, to, "Crimson Sentinel: Teste de Conexão", "🚀 Crimson Sentinel: Teste de Conexão Gmail bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

app.post("/api/scrape", async (req, res) => {
  let { url, productId, profileId } = req.body;
  // Normalizar URL: adicionar https:// se ausente
  if (url && !/^https?:\/\//i.test(String(url).trim())) {
    url = "https://" + String(url).trim();
  }
  try {
    const { isRedisAvailable } = await import("./src/queue/connection.ts");

    if (isRedisAvailable()) {
      // Caminho normal: enfileira via BullMQ
      const queue = getScanQueue();
      const job = await queue.add("scrape", {
        type: "scrape",
        url,
        productId,
        profileId,
      });
      safeLog(`[scrape] enfileirado job ${job.id} para ${url}`);
      return res.json({ jobId: job.id, status: "queued" });
    }

    // Fallback: scraping direto sem Redis
    safeLog(`[scrape] Redis offline, executando scraping direto para ${url}`);
    const { advancedScrape } = await import("./src/lib/scraper.ts");
    const { ProfileRepository } = await import("./src/repositories/profileRepository.ts");
    const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
    const result = await advancedScrape(url, {
      lmStudioUrl: profile?.lmStudioUrl,
      nvidiaApiKey: profile?.nvidiaApiKey,
      geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
    });
    safeLog(`[scrape] scraping direto OK via ${result.method} para ${url}`);
    updateLastScanTimestamp();
    res.json({ jobId: null, status: "direct", result });
  } catch (error: any) {
    safeLog("[scrape] erro: " + error.message);
    res.status(500).json({ error: error.message || "Failed to scrape" });
  }
});

// Throttle de comparações removido: BullMQ controla concorrência por job (FASE 2).
// O user_settings ainda guarda scan_timeout_ms para os workers.

app.post("/api/compare", async (req, res) => {
  const { productName, profileId } = req.body;
  try {
    const { isRedisAvailable } = await import("./src/queue/connection.ts");

    if (isRedisAvailable()) {
      const queue = getScanQueue();
      const jobKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job = await queue.add("compare", {
        type: "compare",
        productName,
        profileId,
        jobKey,
      });
      safeLog(`[compare] enfileirado job ${job.id} para "${productName}"`);
      res.json({ jobId: job.id, jobKey, status: "queued" });
      return;
    }

    // Fallback: comparação direta via Gemini Search (sem Redis)
    safeLog(`[compare] Redis offline, executando comparação direta para "${productName}"`);
    const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
    const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
    const nvidiaApiKey = profile?.nvidiaApiKey;
    const jobKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 1. Try Gemini first
    let results: any[] = [];
    let geminiFailed = false;
    if (finalApiKey) {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: "gemini-3.6-flash",
            contents: `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras confiáveis.`,
            config: {
              systemInstruction: `Você é o SENTINEL, um agente de inteligência de mercado de elite.
              FONTES CONFIÁVEIS: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau e Kabum.
              PROIBIDO: Shopee, AliExpress, sites de cupons, fóruns ou anúncios de usados.
              PREÇO À VISTA: Extraia o MENOR PREÇO PARA PAGAMENTO IMEDIATO (Pix ou Boleto).
              Retorne um array JSON de objetos: {"site": string, "price": number, "url": string}.`,
              tools: [{ googleSearch: {} }],
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    site: { type: Type.STRING },
                    price: { type: Type.NUMBER },
                    url: { type: Type.STRING },
                  },
                  required: ["site", "price", "url"],
                },
              },
            },
          });
          const text = response.text || "[]";
          results = JSON.parse(text);
          break;
        } catch (geminiErr: any) {
          const isRetryable = geminiErr?.status === 429 || geminiErr?.status === 503 || geminiErr?.code === 429 || geminiErr?.code === 503 || String(geminiErr?.message || "").includes("429") || String(geminiErr?.message || "").includes("RESOURCE_EXHAUSTED") || String(geminiErr?.message || "").includes("503") || String(geminiErr?.message || "").includes("UNAVAILABLE");
          if (isRetryable && attempt < 2) {
            safeLog(`[compare] ⚠️ Gemini indisponível — retrying in 3s (attempt ${attempt}/2)...`);
            await new Promise(r => setTimeout(r, 3000));
          } else if (isRetryable) {
            safeLog("[compare] ⚠️ Gemini indisponível — trying NVIDIA fallback...");
            geminiFailed = true;
          } else {
            throw geminiErr;
          }
        }
      }
    }

    // 2. NVIDIA fallback when Gemini unavailable or 429
    if (geminiFailed && nvidiaApiKey && results.length === 0) {
      try {
        safeLog("[compare] Trying NVIDIA NIM fallback...");
        const OpenAI = (await import("openai")).default;
        const client = new OpenAI({
          baseURL: "https://integrate.api.nvidia.com/v1",
          apiKey: nvidiaApiKey,
        });
        const response = await client.chat.completions.create({
          model: "meta/llama-3.1-8b-instruct",
          messages: [
            { role: "system", content: "Você é o SENTINEL, um agente de inteligência de mercado. FONTES: Mercado Livre, Amazon.com.br, Magalu, Terabyteshop, Pichau, Kabum. PREÇO À VISTA (Pix/Boleto). Retorne APENAS JSON válido, sem markdown. Array de objetos: [{\"site\":\"string\",\"price\":0,\"url\":\"string\"}]" },
            { role: "user", content: `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras. JSON:` },
          ],
          max_tokens: 800,
          temperature: 0,
        });
        const rawText = response.choices[0]?.message?.content || "[]";
        const text = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          results = JSON.parse(jsonMatch[0]);
          safeLog(`[compare] NVIDIA fallback OK: ${results.length} resultados`);
        }
      } catch (nvidiaErr: any) {
        safeLog(`[compare] NVIDIA fallback falhou: ${nvidiaErr.message}`);
      }
    }

    // 3. Final: if nothing worked, return 429
    if (results.length === 0 && geminiFailed) {
      return res.status(429).json({ error: "APIs de comparação indisponíveis (Gemini quota + NVIDIA). Tente novamente mais tarde." });
    }
    if (!finalApiKey && !nvidiaApiKey) {
      return res.status(400).json({ error: "Configure a API key do Gemini ou NVIDIA nas configurações do perfil para usar comparação de mercado." });
    }

    safeLog(`[compare] comparação direta OK: ${results.length} resultados para "${productName}"`);
    res.json({ jobId: null, jobKey, status: "direct", returnvalue: { jobKey, results } });
  } catch (error: any) {
    safeLog("[compare] erro: " + error.message);
    res.status(500).json({ error: error.message || "Failed to compare" });
  }
});

  // System Status Endpoint

app.get("/api/status", async (req, res) => {
  const profileId = req.query.profileId as string;
  const profile = ProfileRepository.getById(profileId);

  const status = {
    lmStudio: { connected: false, model: null as string | null },
    gemini: { available: false },
    serper: { available: false },
    nvidia: { available: false },
    nextScanMinutes: 0,
    nextSocialScanMinutes: 0 as number | null
  };

  // Test LM Studio connection
  if (profile?.lmStudioUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${profile.lmStudioUrl.replace(/\/v1$/, '')}/v1/models`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const models = await response.json();
        status.lmStudio.connected = true;
        status.lmStudio.model = models.data?.[0]?.id || "unknown";
      }
    } catch (e) {
      safeLog(`LM Studio status check failed: ${e}`);
    }
  }

  // Check API keys
  status.gemini.available = !!(profile?.geminiApiKey || process.env.GEMINI_API_KEY);
  status.serper.available = !!(profile?.serperApiKey || process.env.SERPER_API_KEY);
  status.nvidia.available = !!profile?.nvidiaApiKey;

  // Próximo scan: derivado dos schedulers do BullMQ
  try {
    const daily = await getScanQueue().getJobScheduler("scan-daily-cron");
    if (daily?.next) {
      status.nextScanMinutes = Math.max(0, Math.round((daily.next - Date.now()) / 60000));
    }
  } catch {
    // bullmq indisponível — retorna 0
  }

  // FASE 9: próximo scan social
  try {
    const social = await getSocialQueue().getJobScheduler("social-scan-cron");
    if (social?.next) {
      status.nextSocialScanMinutes = Math.max(0, Math.round((social.next - Date.now()) / 60000));
    } else {
      status.nextSocialScanMinutes = null;
    }
  } catch {
    status.nextSocialScanMinutes = null;
  }

  res.json(status);
});

  // A2 — Análise assíncrona: enfileira job no scan-queue (mesma fila do scrape/compare)
  // e responde imediatamente com {jobId, status:"queued"}. Antes a rota chamava
  // Gemini/NVIDIA/LM Studio de forma síncrona, bloqueando o handler Express.
  app.post("/api/analyze", async (req, res) => {
    const { productName, currentPrice, currency, profileId, lowestPrice, lowestPriceDate } = req.body;
    if (!productName || typeof currentPrice !== "number") {
      return res.status(400).json({ error: "productName e currentPrice são obrigatórios" });
    }
    try {
      const { isRedisAvailable } = await import("./src/queue/connection.ts");
      if (isRedisAvailable()) {
        const queue = getScanQueue();
        const job = await queue.add("analyze", {
          type: "analyze",
          productName,
          currentPrice,
          currency: currency ?? "BRL",
          profileId,
          lowestPrice,
          lowestPriceDate,
        });
        safeLog(`[analyze] enfileirado job ${job.id} para "${productName}"`);
        return res.json({ jobId: job.id, status: "queued" });
      }

      // Fallback: análise direta via Gemini (sem Redis)
      safeLog(`[analyze] Redis offline, executando análise direta para "${productName}"`);
      const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
      const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
      const nvidiaApiKey = profile?.nvidiaApiKey;
      if (!finalApiKey && !nvidiaApiKey) {
        return res.status(400).json({ error: "Configure a API key do Gemini ou NVIDIA nas configurações do perfil." });
      }

      const cur = currency || "BRL";
      const hasMultiplePrices = lowestPrice && lowestPriceDate && currentPrice !== lowestPrice;
      const prompt = `Você é um assistente ajudando um amigo a decidir se vale a pena comprar um produto de tecnologia.

Produto: "${productName}"
Preço Atual: ${cur} ${currentPrice}
${lowestPrice && lowestPriceDate ? `Referência histórica: ${cur} ${lowestPrice} (registrado em ${lowestPriceDate})` : "Sem dados históricos de preços."}

REGRAS IMPORTANTES:
- Se só temos 1 registro de preço, NÃO afirme que é "menor preço registrado" ou "maior preço". Diga apenas "único preço registrado".
- Só faça comparações de preço quando houver dados históricos suficientes (2+ registros).
- NUNCA invente dados. Se não souber algo, diga que não há informação suficiente.

Responda de forma SIMPLES e DIRETA. NÃO use termos técnicos de bolsa de valores.

**Formato de resposta:**
VALE A PENA? [Sim/Não/Talvez] - uma frase explicando por quê
PREÇO JUSTO: ${cur} X.XXX - quanto você pagaria nesse produto
QUANDO COMPRAR: [Agora/Esperar] - se deve comprar agora ou esperar promoção
DICA: Uma frase com conselho prático
${hasMultiplePrices && currentPrice > lowestPrice * 1.1 ? `ATENÇÃO: O preço já foi ${cur} ${lowestPrice}. Se esperar, pode baixar de novo.` : ""}
Fale de forma natural, sem saudações como "Olá" ou "Amigo".`;

      const { GoogleGenAI } = await import("@google/genai");
      const ai = finalApiKey ? new GoogleGenAI({ apiKey: finalApiKey }) : null;

      let analysis = "";
      let geminiFailed = false;

      // 1. Try Gemini
      if (ai) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: "gemini-3.6-flash",
              contents: prompt,
            });
            analysis = response.text || "";
            break;
          } catch (geminiErr: any) {
            const isRetryable = geminiErr?.status === 429 || geminiErr?.status === 503 || String(geminiErr?.message || "").includes("429") || String(geminiErr?.message || "").includes("503") || String(geminiErr?.message || "").includes("UNAVAILABLE");
            if (isRetryable && attempt < 2) {
              safeLog(`[analyze] ⚠️ Gemini indisponível — retrying in 3s...`);
              await new Promise(r => setTimeout(r, 3000));
            } else if (isRetryable) {
              safeLog("[analyze] ⚠️ Gemini indisponível — trying NVIDIA fallback...");
              geminiFailed = true;
            } else {
              throw geminiErr;
            }
          }
        }
      }

      // 2. NVIDIA fallback
      if (!analysis && nvidiaApiKey) {
        try {
          safeLog("[analyze] Trying NVIDIA NIM fallback...");
          const OpenAI = (await import("openai")).default;
          const client = new OpenAI({
            baseURL: "https://integrate.api.nvidia.com/v1",
            apiKey: nvidiaApiKey,
          });
          const response = await client.chat.completions.create({
            model: "meta/llama-3.1-8b-instruct",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500,
            temperature: 0,
          });
          analysis = response.choices[0]?.message?.content || "";
          if (analysis) safeLog("[analyze] NVIDIA fallback OK");
        } catch (nvidiaErr: any) {
          safeLog(`[analyze] NVIDIA fallback falhou: ${nvidiaErr.message}`);
        }
      }

      // 3. Local fallback: generate basic analysis from price data when all APIs fail
      if (!analysis) {
        const hasHistory = lowestPrice && lowestPriceDate;
        const priceDiff = hasHistory ? currentPrice - lowestPrice! : 0;
        const pctAboveLow = hasHistory && lowestPrice! > 0 ? Math.round((priceDiff / lowestPrice!) * 100) : 0;

        analysis = `### Análise Local (APIs indisponíveis)\n\n`;
        if (hasHistory) {
          if (pctAboveLow <= 5) {
            analysis += `**VALE A PENA?** Sim - preço próximo ao menor registrado (${cur} ${lowestPrice} em ${lowestPriceDate}).\n\n`;
          } else if (pctAboveLow <= 20) {
            analysis += `**VALE A PENA?** Talvez - preço ${pctAboveLow}% acima do menor registrado (${cur} ${lowestPrice} em ${lowestPriceDate}). Pode valer a pena esperar.\n\n`;
          } else {
            analysis += `**VALE A PENA?** Não - preço ${pctAboveLow}% acima do menor registrado. Aguarde promoção.\n\n`;
          }
          analysis += `**PREÇO JUSTO:** ${cur} ${lowestPrice}\n\n`;
        } else {
          analysis += `**VALE A PENA?** Sem dados suficientes para determinar.\n\n`;
          analysis += `**PREÇO ATUAL:** ${cur} ${currentPrice} (único registro)\n\n`;
        }
        analysis += `**QUANDO COMPRAR:** Aguardar consulta automática quando APIs estiverem disponíveis.\n\n`;
        analysis += `> ⚠️ Análise gerada localmente sem IA. Configure Gemini ou NVIDIA para análises completas.`;
        safeLog(`[analyze] Usando fallback local para "${productName}"`);
      }

      safeLog(`[analyze] análise direta OK para "${productName}"`);
      res.json({ jobId: null, status: "direct", analysis });
    } catch (error: any) {
      safeLog("[analyze] erro: " + error.message);
      res.status(500).json({ error: error.message || "Failed to analyze" });
    }
  });

  // ---- MÓDULO LOCAL / GEOLOCALIZADO (FASE 5) ------------------------------

  // Roteirização assíncrona: enfileira no BullMQ e responde { jobId }.
  // B4 — payload estendido com `vehicle` (combustível/tarifa) e `startTime`
  // ("suggest" para sugerir horário de menor movimento).
  app.post("/api/route", async (req, res) => {
    const { shoppingListItemIds, startLat, startLng, establishmentIds, name, vehicle, startTime } = req.body;
    if (!Array.isArray(shoppingListItemIds) || shoppingListItemIds.length === 0) {
      return res.status(400).json({ error: "shoppingListItemIds é obrigatório" });
    }
    if (typeof startLat !== "number" || typeof startLng !== "number") {
      return res.status(400).json({ error: "startLat e startLng são obrigatórios" });
    }
    try {
      const queue = getRouteQueue();
      const job = await queue.add("route", {
        type: "route",
        shoppingListItemIds,
        startLat,
        startLng,
        establishmentIds,
        name,
        vehicle,
        startTime,
      });
      safeLog(
        `[route] enfileirado job ${job.id} para ${shoppingListItemIds.length} itens vehicle=${vehicle?.type ?? "none"} startTime=${startTime ?? "default"}`
      );
      res.json({ jobId: job.id, status: "queued" });
    } catch (error: any) {
      safeLog("[route] erro ao enfileirar: " + error.message);
      res.status(500).json({ error: error.message || "Failed to enqueue route" });
    }
  });

  app.get("/api/establishments", (req, res) => {
    try {
      const all = EstablishmentRepository.getAll();
      // B1 — filtro opcional por raio: ?lat=&lng=&radiusKm=
      const lat = req.query.lat ? parseFloat(req.query.lat as string) : null;
      const lng = req.query.lng ? parseFloat(req.query.lng as string) : null;
      const radiusKm = req.query.radiusKm ? parseFloat(req.query.radiusKm as string) : null;
      if (lat !== null && lng !== null && radiusKm !== null) {
        const center = { lat, lng };
        const filtered = all.filter((e: any) => haversineKm(center, { lat: e.lat, lng: e.lng }) <= radiusKm);
        return res.json(filtered);
      }
      res.json(all);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // B1 — define localização do usuário (geocode Nominatim se address fornecido).
  // Salva lat/lng/endereço em user_settings para uso por /api/establishments/discover
  // e pelo filtro de raio do scan local (handleLocalPriceScan).
  app.post("/api/location", async (req, res) => {
    try {
      const { address, lat, lng, radiusKm, cep } = req.body as {
        address?: string;
        lat?: number;
        lng?: number;
        radiusKm?: number;
        cep?: string;
      };
      let finalLat: number | undefined;
      let finalLng: number | undefined;
      let finalAddress: string | undefined;

      if (cep) {
        const result = await geocodeFromCep(cep);
        if (!result) {
          return res.status(400).json({ error: "CEP não encontrado ou geocoding falhou" });
        }
        finalLat = result.lat;
        finalLng = result.lng;
        finalAddress = result.address;
      } else if (typeof lat === "number" && typeof lng === "number") {
        finalLat = lat;
        finalLng = lng;
        finalAddress = address;
      } else if (address) {
        const geocoded = await geocodeAddress(address);
        if (!geocoded) {
          return res.status(400).json({ error: "Geocoding falhou para o endereço fornecido" });
        }
        finalLat = geocoded.lat;
        finalLng = geocoded.lng;
        finalAddress = geocoded.displayName ?? address;
      } else {
        return res.status(400).json({ error: "Forneça {cep}, {address} ou {lat,lng}" });
      }

      SettingsRepository.set("user_lat", String(finalLat));
      SettingsRepository.set("user_lng", String(finalLng));
      if (finalAddress) SettingsRepository.set("user_address", finalAddress);
      if (cep) SettingsRepository.set("user_cep", cep);
      if (typeof radiusKm === "number") {
        SettingsRepository.set("geolocation_search_radius_m", String(Math.round(radiusKm * 1000)));
      }

      res.json({
        status: "ok",
        location: { lat: finalLat, lng: finalLng, address: finalAddress },
        radiusMeters: SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/location", (req, res) => {
    try {
      res.json({
        lat: SettingsRepository.getNumber("user_lat") || null,
        lng: SettingsRepository.getNumber("user_lng") || null,
        address: SettingsRepository.get("user_address") || null,
        cep: SettingsRepository.get("user_cep") || null,
        radiusMeters: SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // B1 — dispara descoberta de estabelecimentos via Overpass em segundo plano.
  app.post("/api/establishments/discover", async (req, res) => {
    try {
      const { isRedisAvailable } = await import("./src/queue/connection.ts");
      if (!isRedisAvailable()) {
        return res.status(503).json({ error: "Redis indisponível — filas desabilitadas. Inicie Redis e tente novamente." });
      }
      const userLat = SettingsRepository.getNumber("user_lat");
      const userLng = SettingsRepository.getNumber("user_lng");
      if (userLat === 0 && userLng === 0) {
        return res.status(400).json({ error: "Defina sua localização via POST /api/location primeiro" });
      }
      const radiusMeters =
        typeof req.body?.radiusMeters === "number"
          ? req.body.radiusMeters
          : SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000;
      const job = await getScanQueue().add("discover-establishments", {
        type: "discover-establishments",
        radiusMeters,
      });
      safeLog(`[discover] enfileirado job ${job.id} raio ${radiusMeters}m`);
      res.json({ jobId: job.id, status: "queued", radiusMeters });
    } catch (error: any) {
      safeLog("[discover] erro: " + error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/establishments", (req, res) => {
    try {
      // B1 — se source não vier, assume 'manual' (cadastro manual)
      const body = { ...req.body };
      if (!body.source) body.source = "manual";
      EstablishmentRepository.save(body);
      res.json({ status: "ok", establishment: EstablishmentRepository.getById(req.body.id) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/establishments/:id", (req, res) => {
    try {
      EstablishmentRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/shopping-list-items", (req, res) => {
    try {
      res.json(ShoppingListRepository.getAll());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/shopping-list-items", (req, res) => {
    try {
      ShoppingListRepository.save(req.body);
      res.json({ status: "ok", item: ShoppingListRepository.getById(req.body.id) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/shopping-list-items/:id", (req, res) => {
    try {
      ShoppingListRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/price-observations", (req, res) => {
    try {
      const filters = {
        shoppingListItemId: req.query.shoppingListItemId as string | undefined,
        establishmentId: req.query.establishmentId as string | undefined,
        productId: req.query.productId as string | undefined,
      };
      res.json(PriceObservationRepository.getAll(filters));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/price-observations", async (req, res) => {
    try {
      const obs = PriceObservationRepository.create(req.body);
      res.json({ status: "ok", observation: obs });

      // FASE 6: se o item tem preço-alvo e a observação ficou dentro dele, alerta.
      if (obs.shoppingListItemId && obs.price) {
        try {
          const item = ShoppingListRepository.getById(obs.shoppingListItemId);
          if (item?.targetPrice && obs.price <= item.targetPrice) {
            const est = EstablishmentRepository.getById(obs.establishmentId);
            alertShoppingItemTargetReached(
              item.name,
              item.id,
              est?.name ?? "estabelecimento",
              obs.price,
              item.targetPrice
            ).catch((e) => safeLog(`[alerts] erro item alvo: ${e}`));
          }
        } catch (e) {
          safeLog(`[alerts] erro ao avaliar item alvo: ${e}`);
        }
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/promotions", (req, res) => {
    try {
      const filters = {
        activeOnly: req.query.activeOnly === "true",
        establishmentId: req.query.establishmentId as string | undefined,
        onlyFlash: req.query.onlyFlash === "true",
        onlyActiveOrFlash: req.query.onlyActiveOrFlash === "true",
        orderBy: (req.query.orderBy as "detected" | "discount" | undefined) ?? undefined,
      };
      res.json(PromotionRepository.getAll(filters));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/promotions", (req, res) => {
    try {
      PromotionRepository.save(req.body);
      res.json({ status: "ok", promotion: PromotionRepository.getById(req.body.id) });

      // FASE 6: alerta promoções ativas cadastradas manualmente.
      const promo = PromotionRepository.getById(req.body.id);
      if (promo && promo.isActive) {
        const est = EstablishmentRepository.getById(promo.establishmentId);
        alertActivePromotion(
          promo.id,
          promo.productName,
          est?.name ?? "estabelecimento",
          promo.promoPrice,
          promo.regularPrice
        ).catch((e) => safeLog(`[alerts] erro promoção: ${e}`));
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/promotions/:id", (req, res) => {
    try {
      PromotionRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/routes", (req, res) => {
    try {
      res.json(RouteRepository.getAll());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/routes/:id", (req, res) => {
    try {
      RouteRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- SITES DE PROMOÇÕES ---------------------------------------------------

  app.get("/api/promotion-sites", (_req, res) => {
    try {
      res.json(PromotionSiteRepository.getAll());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/promotion-sites", (req, res) => {
    try {
      const body = { ...req.body };
      if (!body.id) body.id = `psite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!body.createdAt) body.createdAt = new Date().toISOString();
      PromotionSiteRepository.save(body);
      res.json({ status: "ok", site: PromotionSiteRepository.getById(body.id) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/promotion-sites/:id", (req, res) => {
    try {
      PromotionSiteRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // FASE 6: histórico de notificações enviadas (para o painel de alertas).
  app.get("/api/notifications", (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      res.json(NotificationRepository.getAll(limit));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- MONITORAMENTO SOCIAL (FASE 8) --------------------------------------

  // Fontes configuradas (WhatsApp/Instagram).
  app.get("/api/social/sources", (req, res) => {
    try {
      res.json(SocialSourceRepository.getAll(req.query.enabledOnly === "true"));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/social/sources", (req, res) => {
    try {
      const source = req.body;
      if (!source.id) source.id = `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      SocialSourceRepository.save(source);
      res.json({ status: "ok", source: SocialSourceRepository.getById(source.id) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/social/sources/:id", (req, res) => {
    try {
      SocialSourceRepository.delete(req.params.id);
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Captura de texto social (WhatsApp colado ou URL do Instagram) → enfileira.
  app.post("/api/social/capture", async (req, res) => {
    const { channel, text, url, sourceId, profileId } = req.body || {};
    if (channel !== "whatsapp" && channel !== "instagram") {
      return res.status(400).json({ error: "channel deve ser whatsapp ou instagram" });
    }
    try {
      const queue = getSocialQueue();
      const job = await queue.add("social-capture", { type: "social-capture", channel, text, url, sourceId, profileId });
      safeLog(`[social] captura enfileirada job ${job.id}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (error: any) {
      safeLog("[social] erro ao enfileirar captura: " + error.message);
      res.status(500).json({ error: error.message || "Failed to enqueue capture" });
    }
  });

  // Scan de todas as fontes ativas (varre cada fonte e enfileira capturas).
  app.post("/api/social/scan-all", async (req, res) => {
    try {
      const { isRedisAvailable } = await import("./src/queue/connection.ts");
      if (!isRedisAvailable()) {
        return res.status(503).json({ error: "Redis indisponível. Inicie Redis para usar scan social." });
      }
      const queue = getSocialQueue();
      const job = await queue.add("social-scan-all", { type: "social-scan-all", triggeredBy: "manual" });
      safeLog(`[social] scan-all enfileirado job ${job.id}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (error: any) {
      safeLog("[social] erro ao enfileirar scan-all: " + error.message);
      res.status(500).json({ error: error.message || "Failed to enqueue scan" });
    }
  });

  // C2 — endpoints WhatsApp real (whatsapp-web.js)
  // Toggle WhatsApp on/off via DB (sem .env)
  app.get("/api/social/whatsapp/toggle", (_req, res) => {
    try {
      const enabled = SettingsRepository.getBool("whatsapp_enabled");
      res.json({ enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/social/whatsapp/toggle", (req, res) => {
    try {
      const { enabled } = req.body || {};
      SettingsRepository.set("whatsapp_enabled", enabled ? "true" : "false");
      safeLog(`[whatsapp] ${enabled ? "ativado" : "desativado"} via UI`);
      res.json({ enabled: !!enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/social/whatsapp/qr", async (req, res) => {
    if (!SettingsRepository.getBool("whatsapp_enabled")) {
      return res.status(403).json({
        error: "WhatsApp desativado. Ative-o no painel social primeiro.",
      });
    }
    try {
      const { startWhatsappSession, getLastQr, getLastQrAnsi, isWhatsappReady } = await import("./src/social/whatsappSession.ts");
      if (await isWhatsappReady()) {
        return res.json({ status: "ready", qr: null, qrAnsi: null, message: "Sessão já autenticada" });
      }
      await startWhatsappSession({
        onQr: () => {},
        onAuthenticated: () => safeLog("[api] whatsapp autenticado"),
        onReady: () => safeLog("[api] whatsapp pronto"),
        onAuthFailure: (m) => safeLog(`[api] whatsapp auth failure: ${m}`),
        onDisconnected: () => safeLog("[api] whatsapp disconectado"),
      });
      const qr = getLastQr();
      const qrAnsi = getLastQrAnsi();
      if (!qr) {
        return res.json({ status: "pending", qr: null, qrAnsi: null, message: "Sessão inicializando — aguarde alguns segundos" });
      }
      res.json({ status: "qr", qr, qrAnsi });
    } catch (err: any) {
      safeLog("[api] erro iniciar whatsapp: " + err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/social/whatsapp/status", async (req, res) => {
    const enabled = SettingsRepository.getBool("whatsapp_enabled");
    if (!enabled) {
      return res.json({ enabled: false, ready: false });
    }
    try {
      const { isWhatsappReady } = await import("./src/social/whatsappSession.ts");
      const ready = await isWhatsappReady();
      res.json({ enabled: true, ready });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enfileira scan de Status dos contatos salvos em establishments.whatsapp_number.
  // O worker respeita throttle configurável (whatsapp_scan_per_contact_min).
  app.post("/api/social/whatsapp/scan", async (req, res) => {
    if (!SettingsRepository.getBool("whatsapp_enabled")) {
      return res.status(403).json({ error: "WhatsApp desativado. Ative-o no painel social." });
    }
    try {
      const queue = getSocialQueue();
      const job = await queue.add("whatsapp-status-scan", {
        type: "whatsapp-status-scan",
        triggeredBy: "manual" as const,
      });
      safeLog(`[social] whatsapp-status-scan enfileirado job ${job.id}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // C3 — Instagram credentials (stored in DB, no .env needed)
  app.get("/api/social/instagram/credentials", async (_req, res) => {
    try {
      const username = SettingsRepository.get("ig_username") || "";
      res.json({ username });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/social/instagram/credentials", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: "Username e senha são obrigatórios" });
      }
      SettingsRepository.set("ig_username", username);
      SettingsRepository.set("ig_password", password);
      safeLog("[instagram] Credenciais salvas no banco");
      // Responde primeiro, reinicia serviço em background
      res.json({ ok: true, username });
      setTimeout(() => restartInstagramService(), 100);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // C3 — endpoints Instagram Stories via microserviço Python (instagrapi)
  app.get("/api/social/instagram/health", async (_req, res) => {
    const hasCredentials = !!SettingsRepository.get("ig_username");
    if (!hasCredentials) {
      return res.json({ enabled: false, ok: false, sessionLoaded: false });
    }
    try {
      const { instagramServiceHealth } = await import("./src/social/instagramClient.ts");
      const h = await instagramServiceHealth();
      res.json({ enabled: true, ...h });
    } catch {
      // Serviço offline ou erro de conexão — retorna status offline
      res.json({ enabled: true, ok: false, sessionLoaded: false });
    }
  });

  app.post("/api/social/instagram/login", async (_req, res) => {
    const hasCredentials = !!SettingsRepository.get("ig_username");
    if (!hasCredentials) {
      return res.status(400).json({ error: "Configure usuário e senha primeiro" });
    }
    // Se serviço não está rodando, tenta iniciar
    if (!instagramProcess) {
      safeLog("[instagram] Serviço offline, reiniciando antes do login...");
      restartInstagramService();
      // Aguarda o serviço subir
      await new Promise((r) => setTimeout(r, 3000));
    }
    try {
      const { instagramLogin } = await import("./src/social/instagramClient.ts");
      const ok = await instagramLogin();
      res.json({ status: ok ? "ok" : "failed" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/social/instagram/scan", async (_req, res) => {
    const hasCredentials = !!SettingsRepository.get("ig_username");
    if (!hasCredentials) {
      return res.status(400).json({ error: "Configure Instagram primeiro" });
    }
    try {
      const queue = getSocialQueue();
      const job = await queue.add("instagram-stories-scan", {
        type: "instagram-stories-scan",
        triggeredBy: "manual" as const,
      });
      safeLog(`[social] instagram-stories-scan enfileirado job ${job.id}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Configuração do agendamento social (FASE 9).
  app.get("/api/social/settings", async (req, res) => {
    try {
      const intervalMs = SettingsRepository.getNumber("social_scan_interval_ms") ?? 6 * 60 * 60 * 1000;
      const scheduler = (await listSocialScheduledJob()).find((s) => s.id === "social-scan-cron");
      res.json({
        intervalMs,
        enabled: SettingsRepository.getBool("social_monitoring_enabled"),
        scheduler: scheduler ?? null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/social/settings", async (req, res) => {
    const { intervalMs } = req.body || {};
    try {
      const newInterval = Number(intervalMs);
      if (!Number.isFinite(newInterval) || newInterval <= 0) {
        return res.status(400).json({ error: "intervalMs deve ser um número positivo (ms)" });
      }
      SettingsRepository.set("social_scan_interval_ms", Math.round(newInterval));
      await registerSocialScheduler({ intervalMs: Math.round(newInterval) });
      safeLog(`[social] agendador atualizado para ${Math.round(newInterval / 60000)}min`);
      res.json({ status: "ok", intervalMs: Math.round(newInterval) });
    } catch (error: any) {
      safeLog("[social] erro ao atualizar agendador: " + error.message);
      res.status(500).json({ error: error.message || "Failed to update scheduler" });
    }
  });

  // ---- INSIGHTS LOCAIS (FASE 7) -------------------------------------------

  // Análise determinística imediata (sem rede): melhor estabelecimento por item,
  // custo por estabelecimento, economia entre estratégias.
  app.get("/api/local-insights", (req, res) => {
    try {
      const insights = buildLocalInsights(
        ShoppingListRepository.getAll(),
        PriceObservationRepository.getAll(),
        EstablishmentRepository.getAll(),
        PromotionRepository.getAll()
      );
      res.json({ insights, summary: summarizeInsights(insights) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Análise com IA (Gemini) — enfileira no scan-queue, responde { jobId }.
  app.post("/api/local-insights/analyze", async (req, res) => {
    const { profileId } = req.body || {};
    try {
      const queue = getScanQueue();
      const job = await queue.add("local-insight", { type: "local-insight", profileId });
      safeLog(`[local-insight] enfileirado job ${job.id}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (error: any) {
      safeLog("[local-insight] erro ao enfileirar: " + error.message);
      res.status(500).json({ error: error.message || "Failed to enqueue insight" });
    }
  });

  // Scraping de preços locais (FASE 11) — enfileira varredura de price_url por
  // estabelecimento (ou todos com price_url). Assíncrono, retorna { jobId }.
  app.post("/api/local-price-scan", async (req, res) => {
    const { establishmentId, profileId } = req.body || {};
    try {
      const queue = getScanQueue();
      const job = await queue.add("local-price-scan", {
        type: "local-price-scan",
        establishmentId,
        profileId,
      });
      safeLog(`[local-price-scan] enfileirado job ${job.id} est=${establishmentId ?? "all"}`);
      res.json({ jobId: job.id, status: "queued" });
    } catch (error: any) {
      safeLog("[local-price-scan] erro ao enfileirar: " + error.message);
      res.status(500).json({ error: error.message || "Failed to enqueue local price scan" });
    }
  });

  // Histórico de preços (FASE 10) — séries unificadas e-commerce + local
  app.get("/api/price-history", (req, res) => {
    try {
      const rangeDays = Number(req.query.rangeDays) || 0;
      const ecommerce = buildEcommerceEntities(ProductRepository.getAll());
      const local = buildLocalEntities(
        ShoppingListRepository.getAll(),
        PriceObservationRepository.getAll(),
        EstablishmentRepository.getAll()
      );
      const applyRange = (entities: PriceHistoryEntity[]) =>
        entities.map((e) => ({
          ...e,
          series: e.series.map((s) => ({ ...s, points: filterByRange(s.points, rangeDays) })),
        }));
      res.json({
        rangeDays,
        ecommerce: applyRange(ecommerce),
        local: applyRange(local),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Polling de status de jobs (FASE 2) — registrado antes do SPA fallback
  app.get("/api/jobs/:queue/:id", async (req, res) => {
    try {
      const queueMap: Record<string, any> = {
        scan: getScanQueue(),
        route: getRouteQueue(),
        social: getSocialQueue(),
      };
      const queue = queueMap[req.params.queue];
      if (!queue) return res.status(404).json({ error: "unknown queue" });
      const job = await queue.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: "job not found" });
      const state = await job.getState();
      res.json({
        id: job.id,
        name: job.name,
        state,
        attemptsMade: job.attemptsMade,
        progress: job.progress,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- CEP ----
  app.get("/api/cep/:cep", async (req, res) => {
    try {
      const data = await lookupCep(req.params.cep);
      if (!data) return res.status(404).json({ error: "CEP não encontrado" });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- BACKUP ----
  app.get("/api/backup/export", (_req, res) => {
    try {
      const db = getDb();
      const tables = [
        "profiles", "product_lists", "products", "price_history",
        "establishments", "shopping_list_items", "price_observations",
        "promotions", "routes", "route_stops", "social_sources",
        "user_settings", "notification_log",
      ];
      const data: Record<string, any[]> = {};
      for (const table of tables) {
        data[table] = db.prepare(`SELECT * FROM ${table}`).all();
      }
      const backup = {
        version: "1.0",
        appName: "Crimson Sentinel",
        exportedAt: new Date().toISOString(),
        data,
      };
      const filename = `crimson-sentinel-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.json(backup);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/backup/import", (req, res) => {
    try {
      const backup = req.body;
      if (!backup?.data || !backup?.version) {
        return res.status(400).json({ error: "Formato de backup inválido" });
      }
      const db = getDb();
      const tables = [
        "notification_log", "route_stops", "routes", "promotions",
        "price_observations", "shopping_list_items", "establishments",
        "price_history", "products", "product_lists", "profiles",
        "social_sources", "user_settings",
      ];
      const imported: Record<string, number> = {};
      db.exec("BEGIN TRANSACTION");
      try {
        for (const table of tables) {
          const rows = backup.data[table];
          if (!Array.isArray(rows)) continue;
          db.prepare(`DELETE FROM ${table}`).run();
          const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          const colNames = cols.map((c) => c.name);
          if (colNames.length === 0 || rows.length === 0) continue;
          const placeholders = colNames.map(() => "?").join(", ");
          const stmt = db.prepare(`INSERT INTO ${table} (${colNames.join(", ")}) VALUES (${placeholders})`);
          const insertMany = db.transaction((items: any[]) => {
            for (const item of items) {
              stmt.run(...colNames.map((c) => item[c] ?? null));
            }
          });
          insertMany(rows);
          imported[table] = rows.length;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      res.json({ status: "ok", imported });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- SHOPPING LIST EXPORT/IMPORT ----
  app.get("/api/shopping-list-items/export", (req, res) => {
    try {
      const format = (req.query.format as string) || "json";
      const items = ShoppingListRepository.getAll();
      if (format === "csv") {
        const headers = "name,quantity,unit,category,checked,targetPrice,productId";
        const rows = items.map((it) =>
          [it.name, it.quantity ?? 1, it.unit ?? "", it.category ?? "", it.checked ? "1" : "0", it.targetPrice ?? "", it.productId ?? ""].join(",")
        );
        const csv = [headers, ...rows].join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="lista-compras.csv"');
        res.send(csv);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", 'attachment; filename="lista-compras.json"');
        res.json(items);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/shopping-list-items/import", (req, res) => {
    try {
      const items = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: "Esperado um array de itens" });
      }
      let imported = 0;
      for (const item of items) {
        if (!item.name) continue;
        if (!item.id) {
          item.id = `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        ShoppingListRepository.save(item);
        imported++;
      }
      res.json({ status: "ok", imported });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    // Use a dynamic import with an obfuscated string to bypass tsx static analysis
    const v = "v";
    const i = "i";
    const t = "t";
    const e = "e";
    const { createServer: createViteServer } = await import(v + i + t + e);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In Electron production, use APP_PATH or current dir
    const baseDir = process.env.APP_PATH || process.cwd();
    const distPath = path.join(baseDir, 'dist');
    
    safeLog('Production mode: serving from ' + distPath);
    
    if (!fs.existsSync(distPath)) {
      safeLog('CRITICAL: dist directory not found at ' + distPath);
    }

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('System Error: Frontend assets not found. Check dist folder.');
      }
    });
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log("=".repeat(80));
    console.log("CRIMSON SENTINEL SERVER RUNNING!");
    console.log("Port:", PORT);
    console.log("Time:", new Date().toISOString());
    console.log("Access: http://localhost:" + PORT);
    console.log("=".repeat(80));
    safeLog(`Crimson Sentinel running on http://localhost:${PORT}`);

    // Registra os schedulers BullMQ (substituem setTimeout/setTimeout recursivo + setInterval)
    try {
      const scanIntervalMs = SettingsRepository.getNumber('scan_interval_ms') ?? (12 * 60 * 60 * 1000);
      const dailyHour = SettingsRepository.getNumber('scan_daily_hour') ?? 15;
      await registerSchedulers({ scanIntervalMs, dailyHour });
    } catch {
      safeLog("[scheduler] Falha ao registrar schedulers — Redis indisponível?");
    }

    try {
      const socialIntervalMs = SettingsRepository.getNumber('social_scan_interval_ms') ?? (6 * 60 * 60 * 1000);
      await registerSocialScheduler({ intervalMs: socialIntervalMs });
    } catch {
      safeLog("[scheduler] Falha ao registrar scheduler social — Redis indisponível?");
    }

    // C3 — auto-start Instagram microservice
    startInstagramService();

    // Catch-up: if scan was missed while PC was off, run immediately
    checkAndRunCatchupScan();
  });
}

let instagramProcess: ReturnType<typeof spawn> | null = null;

function execAsync(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

async function startInstagramService() {
  const igUsername = SettingsRepository.get("ig_username");
  const igPassword = SettingsRepository.get("ig_password");
  if (!igUsername || !igPassword) {
    safeLog("[instagram] Sem credenciais configuradas, serviço não será iniciado");
    return;
  }

  const appRoot = __dirname;
  const venvDir = path.join(appRoot, "python_instagram", ".venv");
  const venvPython = path.join(venvDir, "bin", "python");
  const venvPip = path.join(venvDir, "bin", "pip");
  const uvicorn = path.join(venvDir, "bin", "uvicorn");
  const reqFile = path.join(appRoot, "python_instagram", "requirements.txt");

  if (!fs.existsSync(venvPython) || !fs.existsSync(uvicorn)) {
    safeLog("[instagram] Configurando venv...");
    try {
      if (fs.existsSync(venvDir)) {
        safeLog("[instagram] Removendo venv vazio/incompleto...");
        await execAsync(`rm -rf "${venvDir}"`);
      }
      await execAsync(`python3 -m venv "${venvDir}"`);
      await execAsync(`"${venvPip}" install --upgrade pip && "${venvPip}" install -q -r "${reqFile}"`);
      safeLog("[instagram] Venv configurado com sucesso");
    } catch (err: any) {
      safeLog(`[instagram] Falha ao criar venv: ${err.message}. Instale python3 e tente novamente.`);
      return;
    }
  }

  instagramProcess = spawn(uvicorn, [
    "python_instagram.server:app",
    "--host", "127.0.0.1",
    "--port", process.env.INSTAGRAM_SERVICE_PORT || "8721",
  ], {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IG_USERNAME: igUsername,
      IG_PASSWORD: igPassword,
    },
  });

  instagramProcess.stdout?.on("data", (data) => {
    safeLog(`[instagram] ${data.toString().trim()}`);
  });
  instagramProcess.stderr?.on("data", (data) => {
    safeLog(`[instagram] ${data.toString().trim()}`);
  });
  instagramProcess.on("error", (err) => {
    safeLog(`[instagram] Erro ao iniciar: ${err.message}`);
    instagramProcess = null;
  });
  instagramProcess.on("exit", (code) => {
    safeLog(`[instagram] Processo encerrado com código ${code}`);
    instagramProcess = null;
  });

  safeLog("[instagram] Microserviço iniciado em 127.0.0.1:" + (process.env.INSTAGRAM_SERVICE_PORT || "8721"));
}

function stopInstagramService() {
  if (instagramProcess) {
    instagramProcess.kill("SIGTERM");
    instagramProcess = null;
  }
}

function restartInstagramService() {
  stopInstagramService();
  // Aguarda um instante para garantir que a porta foi liberada
  setTimeout(() => startInstagramService(), 1000);
}

// Catch-up scan: check if a scan was missed while PC was off
async function checkAndRunCatchupScan() {
  try {
    const lastScanStr = SettingsRepository.get('last_scan_timestamp');
    if (!lastScanStr) {
      SettingsRepository.set('last_scan_timestamp', new Date().toISOString());
      return;
    }
    const lastScan = new Date(lastScanStr).getTime();
    const now = Date.now();
    const elapsed = now - lastScan;
    const profiles = AppDataRepository.getAll().profiles;
    if (profiles.length === 0) return;
    const refreshHours = Number(profiles[0].refreshInterval || '12');
    const intervalMs = refreshHours * 60 * 60 * 1000;
    if (elapsed > intervalMs) {
      safeLog(`[catchup] Scan overdue by ${Math.round((elapsed - intervalMs) / 60000)}min — running now`);
      const products = AppDataRepository.getAll().products;
      const urls = products.map((p: any) => p.url).filter(Boolean);
      if (urls.length === 0) return;
      safeLog(`[catchup] Scanning ${urls.length} products...`);
      for (const url of urls) {
        try {
          const { advancedScrape } = await import('./src/lib/scraper.ts');
          const result = await advancedScrape(url, { geminiApiKey: profiles[0]?.geminiApiKey, nvidiaApiKey: profiles[0]?.nvidiaApiKey });
          if (result && result.price > 0) {
            const existing = products.find((p: any) => p.url === url || p.id === generateProductId(url));
            if (existing) {
              const prevPrice = existing.currentPrice;
              existing.currentPrice = result.price;
              existing.previousPrice = prevPrice;
              existing.lastUpdated = new Date().toISOString();
              existing.lastScrapeMethod = result.method;
              existing.name = result.name || existing.name;
              if (!existing.priceHistory) existing.priceHistory = [];
              existing.priceHistory.push({ date: new Date().toISOString(), price: result.price });
            }
          }
        } catch (e: any) {
          safeLog(`[catchup] Failed to scrape ${url}: ${e.message}`);
        }
      }
      AppDataRepository.saveAll(AppDataRepository.getAll());
      SettingsRepository.set('last_scan_timestamp', new Date().toISOString());
      safeLog(`[catchup] Scan complete`);
    }
  } catch (e: any) {
    safeLog(`[catchup] Error: ${e.message}`);
  }
}

// Update last_scan_timestamp after each scrape session completes
function updateLastScanTimestamp() {
  SettingsRepository.set('last_scan_timestamp', new Date().toISOString());
}

startServer();

// Cleanup: matar processos filhos no shutdown
process.on("exit", () => stopInstagramService());
process.on("SIGINT", () => { stopInstagramService(); process.exit(0); });
process.on("SIGTERM", () => { stopInstagramService(); process.exit(0); });
