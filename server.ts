import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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
import { getScanQueue } from "./src/queue/queues.ts";
import { registerSchedulers } from "./src/queue/schedulers.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'affiliate', 'src', 'source', 'fbclid', 'gclid', 'msclkid',
      'cmp', 'abtest', 'utm_source', 'utm_medium', 'promo', 'category'
    ];
    trackingParams.forEach(param => parsed.searchParams.delete(param));
    
    parsed.hash = '';
    
    const productIdPatterns = [
      { pattern: /\/produto\/(\d+)/, format: (m: RegExpMatchArray) => `/produto/${m[1]}` },
      { pattern: /\/dp\/([A-Z0-9]+)/, format: (m: RegExpMatchArray) => `/dp/${m[1]}` },
      { pattern: /\/MLB-(\d+)/, format: (m: RegExpMatchArray) => `/MLB-${m[1]}` },
      { pattern: /\/p\/([a-z0-9]+)/i, format: (m: RegExpMatchArray) => `/p/${m[1]}` },
      { pattern: /\/product\/(\d+)/, format: (m: RegExpMatchArray) => `/product/${m[1]}` },
      { pattern: /\/(\d+)\/p/, format: (m: RegExpMatchArray) => `/${m[1]}/p` },
      { pattern: /\/sku\/([A-Z0-9]+)/i, format: (m: RegExpMatchArray) => `/sku/${m[1]}` },
    ];
    
    for (const { pattern, format } of productIdPatterns) {
      const match = parsed.pathname.match(pattern);
      if (match) {
        parsed.pathname = format(match);
        break;
      }
    }
    
    return parsed.toString();
  } catch {
    return url;
  }
}

function generateProductId(url: string): string {
  const normalized = normalizeProductUrl(url);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

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
  const { url, productId, profileId } = req.body;
  try {
    const queue = getScanQueue();
    const job = await queue.add("scrape", {
      type: "scrape",
      url,
      productId,
      profileId,
    });
    safeLog(`[scrape] enfileirado job ${job.id} para ${url}`);
    res.json({ jobId: job.id, status: "queued" });
  } catch (error: any) {
    safeLog("[scrape] erro ao enfileirar: " + error.message);
    res.status(500).json({ error: error.message || "Failed to enqueue scrape" });
  }
});

// Throttle de comparações removido: BullMQ controla concorrência por job (FASE 2).
// O user_settings ainda guarda scan_timeout_ms para os workers.

app.post("/api/compare", async (req, res) => {
  const { productName, profileId } = req.body;
  try {
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
  } catch (error: any) {
    safeLog("[compare] erro ao enfileirar: " + error.message);
    res.status(500).json({ error: error.message || "Failed to enqueue compare" });
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
    nextScanMinutes: 0
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

  res.json(status);
});

app.post("/api/analyze", async (req, res) => {
    const { productName, currentPrice, currency, history, profileId, lowestPrice, lowestPriceDate } = req.body;

    try {
      const profile = ProfileRepository.getById(profileId);
      const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

      const prompt = `Você é um assistente ajudando um amigo a decidir se vale a pena comprar um produto de tecnologia.

Produto: "${productName}"
Preço Atual: R$ ${currentPrice}
${lowestPrice ? `Menor Preço Registrado: R$ ${lowestPrice} (em ${lowestPriceDate})` : 'Sem histórico de preços anteriores.'}

Responda de forma SIMPLES e DIRETA, como amigo conversando. NÃO use termos técnicos de bolsa de valores.

**Formato de resposta:**

VALE A PENA? [Sim/Não/Talvez] - uma frase explicando por quê

PREÇO JUSTO: R$ X.XXX - quanto você pagaria nesse produto

QUANDO COMPRAR: [Agora/Esperar] - se deve comprar agora ou esperar promoção

DICA: Uma frase com conselho prático

${lowestPrice && currentPrice > lowestPrice * 1.1 ? `ATENÇÃO: O preço já foi R$ ${lowestPrice}. Se esperar, pode baixar de novo.` : ''}

Fale de forma natural, sem saudações como "Olá" ou "Amigo".`;

      let analysis = "";

      // 1. Try Local LLM
      if (profile?.lmStudioUrl) {
        try {
          safeLog("Using Local LLM for analysis...");
          const OpenAI = (await import("openai")).default;
          const client = new OpenAI({
            baseURL: profile.lmStudioUrl,
            apiKey: "lm-studio",
          });
          const response = await client.chat.completions.create({
            model: "qwen",
            messages: [{ role: "user", content: prompt }]
          });
          analysis = response.choices[0].message.content || "";
        } catch (e) {
          safeLog("Local LLM analysis failed: " + e);
        }
      }

      // 2. Try NVIDIA API
      if (!analysis && profile?.nvidiaApiKey) {
        try {
          safeLog("Using NVIDIA API for analysis...");
          const OpenAI = (await import("openai")).default;
          const client = new OpenAI({
            baseURL: "https://integrate.api.nvidia.com/v1",
            apiKey: profile.nvidiaApiKey,
          });
          const response = await client.chat.completions.create({
            model: "meta/llama-3.1-405b-instruct",
            messages: [{ role: "user", content: prompt }]
          });
          analysis = response.choices[0].message.content || "";
        } catch (e) {
          safeLog("NVIDIA analysis failed: " + e);
        }
      }

      // 3. Try Gemini
      if (!analysis && finalApiKey) {
        try {
          safeLog("Using Gemini API for analysis...");
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI({ apiKey: finalApiKey });
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
          });
          analysis = response.text || "";
        } catch (e) {
          safeLog("Gemini analysis failed: " + e);
        }
      }

      if (!analysis) {
        throw new Error("All analysis providers failed.");
      }

      res.json({ text: analysis });
    } catch (error: any) {
      safeLog("Analysis failed: " + error);
      res.status(500).json({ error: "Analysis failed" });
    }
  });

  // Polling de status de jobs (FASE 2) — registrado antes do SPA fallback
  app.get("/api/jobs/:queue/:id", async (req, res) => {
    try {
      const queueMap: Record<string, any> = {
        scan: getScanQueue(),
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
    const scanIntervalMs = SettingsRepository.getNumber('scan_interval_ms') ?? (12 * 60 * 60 * 1000);
    const dailyHour = SettingsRepository.getNumber('scan_daily_hour') ?? 15;
    await registerSchedulers({ scanIntervalMs, dailyHour });
  });
}

startServer();
