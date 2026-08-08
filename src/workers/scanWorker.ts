import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { ScanJobPayload } from "../queue/types";
import { AppDataRepository } from "../repositories/appDataRepository";
import { ProductRepository } from "../repositories/productRepository";
import { ProfileRepository } from "../repositories/profileRepository";
import { scrapeProductInfo } from "../lib/gemini";
import { advancedScrape } from "../lib/scraper";
import { safeLog } from "../lib/safeLog";

// Comparação em provedores externos — cópia adaptada da lógica antiga de
// server.ts /api/compare. Mantém comportamento idêntico para não regredir.
const TRUSTED_DOMAINS = [
  "mercadolivre.com.br",
  "amazon.com.br",
  "kabum.com.br",
  "pichau.com.br",
  "terabyteshop.com.br",
  "magazineluiza.com.br",
  "casasbahia.com.br",
  "pontofrio.com.br",
  "extra.com.br",
  "fastshop.com.br",
  "girafa.com.br",
  "carrefour.com.br",
  "americanas.com.br",
];

const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 590_000;

async function handleScrape(job: Job<ScanJobPayload & { type: "scrape" }>) {
  const { url, productId, profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;

  const info = await advancedScrape(url, {
    lmStudioUrl: profile?.lmStudioUrl,
    nvidiaApiKey: profile?.nvidiaApiKey,
    geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
  });

  if (productId && info?.price) {
    const product = ProductRepository.getById(productId);
    if (product) {
      const now = new Date().toISOString();
      const priceChanged = info.price !== product.currentPrice;
      product.previousPrice = priceChanged ? product.currentPrice : product.previousPrice;
      product.currentPrice = info.price;
      product.lastUpdated = now;
      product.lastScrapeMethod = "queue";
      if (priceChanged) {
        product.priceHistory.push({ date: now, price: info.price });
      }
      ProductRepository.save(product);
    }
  }

  return info;
}

async function handleScanAll() {
  const data = AppDataRepository.getAll();
  let updated = 0;
  let errors = 0;

  for (const product of data.products) {
    try {
      const profile = data.profiles.find((p) => p.id === product.profileId);
      const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) continue;

      const info = await scrapeProductInfo(product.url, apiKey, product.profileId);
      if (info && info.price) {
        const now = new Date().toISOString();
        const priceChanged = info.price !== product.currentPrice;
        product.previousPrice = priceChanged ? product.currentPrice : product.previousPrice;
        product.currentPrice = info.price;
        product.lastUpdated = now;
        if (priceChanged) product.priceHistory.push({ date: now, price: info.price });
        ProductRepository.save(product);
        updated++;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    } catch (err) {
      errors++;
      safeLog(`[scan-worker] erro ${product.name}: ${err}`);
    }
  }
  return { updated, errors, total: data.products.length };
}

async function handleCompare(job: Job<ScanJobPayload & { type: "compare" }>) {
  const { productName, profileId, jobKey } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const systemInstruction = `Você é o SENTINEL, um agente de inteligência de mercado de elite.
  Sua missão é extrair preços REAIS e ATUAIS de produtos no mercado brasileiro com precisão cirúrgica.
  FONTES CONFIÁVEIS: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau e Kabum.
  PROIBIDO: Shopee, AliExpress, sites de cupons, fóruns ou anúncios de usados.
  PREÇO À VISTA: Extraia o MENOR PREÇO PARA PAGAMENTO IMEDIATO (Pix ou Boleto).
  PARCELAMENTO: IGNORE o valor total parcelado se houver um preço à vista menor.
  PREÇOS ANTIGOS: Ignore preços riscados. Foque no "Por: R$ ...".
  Retorne um array JSON de objetos: {"site": string, "price": number, "url": string}.
  Se não houver resultados válidos, retorne [].`;

  const prompt = `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras confiáveis.`;

  const { GoogleGenAI, Type } = await import("@google/genai");

  if (finalApiKey && !profile?.serperApiKey && !profile?.tavilyApiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          systemInstruction,
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
      const result = JSON.parse(text);
      return { jobKey, results: result };
    } catch (err: any) {
      safeLog(`[scan-worker] Gemini Search falhou: ${err.message}`);
    }
  }

  // Fallback Tavily
  if (profile?.tavilyApiKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: profile.tavilyApiKey,
          query: `${productName} preço brasil`,
          search_depth: "basic",
          include_domains: TRUSTED_DOMAINS,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const j = await r.json();
      const links = (j.results || []).map((i: any) => i.url).slice(0, 5);

      const scraped: { site: string; price: number; url: string }[] = [];
      for (const url of links) {
        try {
          const info: any = await advancedScrape(url, {
            lmStudioUrl: profile.lmStudioUrl,
            nvidiaApiKey: profile.nvidiaApiKey,
            geminiApiKey: finalApiKey,
          });
          if (info && info.price && info.name) {
            scraped.push({ site: new URL(url).hostname, price: info.price, url });
          }
        } catch {}
      }
      return { jobKey, results: scraped };
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  return { jobKey, results: [] };
}

export function startScanWorker() {
  const worker = new Worker<ScanJobPayload>(
    QUEUE_NAMES.SCAN,
    async (job) => {
      safeLog(`[scan-worker] job ${job.id} type=${job.data.type}`);
      switch (job.data.type) {
        case "scrape":
          return handleScrape(job as Job<ScanJobPayload & { type: "scrape" }>);
        case "scan-all":
          return handleScanAll();
        case "compare":
          return handleCompare(job as Job<ScanJobPayload & { type: "compare" }>);
      }
    },
    {
      connection: getRedis(),
      concurrency: 2,
    }
  );

  worker.on("completed", (job, result) => {
    safeLog(`[scan-worker] ${job.id} concluído: ${JSON.stringify(result)?.slice(0, 200)}`);
  });
  worker.on("failed", (job, err) => {
    safeLog(`[scan-worker] ${job?.id} falhou: ${err.message}`);
  });
  worker.on("error", (err) => {
    safeLog(`[scan-worker] erro: ${err.message}`);
  });

  console.log("[scan-worker] rodando, escutando " + QUEUE_NAMES.SCAN);
  return worker;
}
