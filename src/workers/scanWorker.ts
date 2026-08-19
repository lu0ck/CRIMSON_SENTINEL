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
import { alertProductTargetReached } from "../lib/notify";
import {
  buildLocalInsights,
  summarizeInsights,
  buildInsightPrompt,
} from "../lib/localInsights";
import { EstablishmentRepository } from "../repositories/establishmentRepository";
import { ShoppingListRepository } from "../repositories/shoppingListRepository";
import { PriceObservationRepository } from "../repositories/priceObservationRepository";
import { PromotionRepository } from "../repositories/promotionRepository";
import { SettingsRepository } from "../repositories/settingsRepository";
import { scanEstablishmentPrices, type LocalPriceScanOutcome } from "../lib/localPriceScrape";
import { overpassDiscoverEstablishments, haversineKm, type GeoPoint } from "../lib/geo";
import { isFlashPrice, createFlashPromotion } from "../lib/flashDetect";
import { alertFlashPromotion } from "../lib/notify";

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

      if (product.targetPrice && product.currentPrice <= product.targetPrice) {
        try {
          const alerted = await alertProductTargetReached(
            profile,
            product.name || product.url,
            product.id,
            product.currentPrice,
            product.targetPrice
          );
          if (alerted) safeLog(`[scan-worker] ALERTA enviado: ${product.name} atingiu alvo`);
        } catch (err) {
          safeLog(`[scan-worker] erro ao enviar alerta de alvo: ${err}`);
        }
      }

      // C1 — detectar flash promotion em produto de e-commerce
      try {
        const flash = isFlashPrice(info.price, product.priceHistory.map((h) => ({ observedAt: h.date, price: h.price })));
        if (flash.isFlash) {
          const promo = createFlashPromotion({
            productName: product.name || product.url,
            establishmentId: "ecommerce",
            currentPrice: info.price,
            regularPrice: product.previousPrice ?? undefined,
            source: "site",
            detectedAt: now,
          });
          if (promo) {
            await alertFlashPromotion(promo, "E-commerce", flash.reason);
            safeLog(`[scan-worker] FLASH detectado em ${product.name}: ${flash.reason}`);
          }
        }
      } catch (err) {
        safeLog(`[scan-worker] erro na detecção flash: ${err}`);
      }
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

        if (product.targetPrice && product.currentPrice <= product.targetPrice) {
          try {
            const alerted = await alertProductTargetReached(
              profile,
              product.name || product.url,
              product.id,
              product.currentPrice,
              product.targetPrice
            );
            if (alerted) safeLog(`[scan-worker] ALERTA enviado: ${product.name} atingiu alvo`);
          } catch (err) {
            safeLog(`[scan-worker] erro ao enviar alerta de alvo: ${err}`);
          }
        }
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

// FASE 7 — insights locais: análise determinística + narrativa IA (Gemini)
// com fallback para o resumo determinístico.
async function handleLocalInsight(job: Job<ScanJobPayload & { type: "local-insight" }>) {
  const { profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;

  const insights = buildLocalInsights(
    ShoppingListRepository.getAll(),
    PriceObservationRepository.getAll(),
    EstablishmentRepository.getAll(),
    PromotionRepository.getAll()
  );

  const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
  let text = summarizeInsights(insights);
  let method = "deterministic";

  if (finalApiKey) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: buildInsightPrompt(insights),
      });
      if (response.text) {
        text = response.text;
        method = "gemini";
      }
    } catch (err: any) {
      safeLog(`[scan-worker] Gemini local-insight falhou, usando fallback: ${err.message}`);
    }
  }

  return { insights, text, method };
}

async function handleLocalPriceScan(job: Job<ScanJobPayload & { type: "local-price-scan" }>) {
  const { establishmentId, profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const apiKeys = {
    lmStudioUrl: profile?.lmStudioUrl,
    nvidiaApiKey: profile?.nvidiaApiKey,
    geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
  };

  const items = ShoppingListRepository.getAll();
  // B2 — filtro por raio: se establishmentId ausente, varre apenas est.
  // com price_url E dentro do raio configurado a partir da localização do
  // usuário (user_lat/user_lng em user_settings).
  const userLat = SettingsRepository.getNumber("user_lat");
  const userLng = SettingsRepository.getNumber("user_lng");
  const radiusMeters = SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000;
  const hasUserLocation = !(userLat === 0 && userLng === 0);

  let targets: import("../types").Establishment[];
  if (establishmentId) {
    const est = EstablishmentRepository.getById(establishmentId);
    targets = est ? [est] : [];
  } else {
    targets = EstablishmentRepository.getAll().filter((e) => e.priceUrl);
    if (hasUserLocation) {
      const center: GeoPoint = { lat: userLat, lng: userLng };
      targets = targets.filter((e) => haversineKm(center, { lat: e.lat, lng: e.lng }) * 1000 <= radiusMeters);
      safeLog(`[scan-worker] local-price-scan: filtro raio ${radiusMeters}m manteve ${targets.length} est. de ${EstablishmentRepository.getAll().length}`);
    } else {
      safeLog("[scan-worker] local-price-scan: sem user_lat/user_lng, varrendo todos com price_url");
    }
  }

  const outcomes: LocalPriceScanOutcome[] = [];
  for (const est of targets) {
    if (!est.priceUrl) continue;
    safeLog(`[scan-worker] local-price-scan ${est.name} (${items.length} itens)`);
    const outcome = await scanEstablishmentPrices(est, items, apiKeys);
    outcomes.push(outcome);

    // C1 — detectar flash por cada item registrado neste estabelecimento
    for (const r of outcome.results) {
      if (r.status !== "recorded") continue;
      try {
        const item = items.find((it) => it.id === r.itemId);
        if (!item) continue;
        const hist = PriceObservationRepository.getAll({ shoppingListItemId: item.id }).map((o) => ({
          observedAt: o.observedAt,
          price: o.price,
        }));
        const flash = isFlashPrice(r.price ?? 0, hist);
        if (flash.isFlash) {
          const promo = createFlashPromotion({
            productName: item.name,
            establishmentId: est.id,
            currentPrice: r.price ?? 0,
            regularPrice: undefined,
            source: "scraping",
            detectedAt: new Date().toISOString(),
          });
          if (promo) {
            await alertFlashPromotion(promo, est.name, flash.reason);
            safeLog(`[scan-worker] FLASH detectado em ${item.name} @ ${est.name}: ${flash.reason}`);
          }
        }
      } catch (err) {
        safeLog(`[scan-worker] erro detecção flash local: ${err}`);
      }
    }
  }

  const recorded = outcomes.reduce((a, o) => a + o.recorded, 0);
  const duplicates = outcomes.reduce((a, o) => a + o.duplicates, 0);
  const errors = outcomes.reduce((a, o) => a + o.errors, 0);
  return { establishmentId, establishments: outcomes.length, recorded, duplicates, errors, outcomes };
}

// A2 — handler de análise movido do `server.ts` (era chamada síncrona de
// Gemini/NVIDIA/LM Studio dentro do handler Express). Agora roda no worker.
async function handleAnalyze(job: Job<ScanJobPayload & { type: "analyze" }>) {
  const { productName, currentPrice, currency, profileId, lowestPrice, lowestPriceDate } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const cur = currency || "BRL";
  const prompt = `Você é um assistente ajudando um amigo a decidir se vale a pena comprar um produto de tecnologia.

Produto: "${productName}"
Preço Atual: ${cur} ${currentPrice}
${lowestPrice ? `Menor Preço Registrado: ${cur} ${lowestPrice} (em ${lowestPriceDate})` : "Sem histórico de preços anteriores."}

Responda de forma SIMPLES e DIRETA, como amigo conversando. NÃO use termos técnicos de bolsa de valores.

**Formato de resposta:**

VALE A PENA? [Sim/Não/Talvez] - uma frase explicando por quê

PREÇO JUSTO: ${cur} X.XXX - quanto você pagaria nesse produto

QUANDO COMPRAR: [Agora/Esperar] - se deve comprar agora ou esperar promoção

DICA: Uma frase com conselho prático

${lowestPrice && currentPrice > lowestPrice * 1.1 ? `ATENÇÃO: O preço já foi ${cur} ${lowestPrice}. Se esperar, pode baixar de novo.` : ""}

Fale de forma natural, sem saudações como "Olá" ou "Amigo".`;

  let analysis = "";

  // 1. Local LLM (LM Studio)
  if (profile?.lmStudioUrl) {
    try {
      safeLog("[scan-worker] analyze: LM Studio");
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ baseURL: profile.lmStudioUrl, apiKey: "lm-studio" });
      const response = await client.chat.completions.create({
        model: "qwen",
        messages: [{ role: "user", content: prompt }],
      });
      analysis = response.choices[0]?.message?.content || "";
    } catch (e: any) {
      safeLog(`[scan-worker] analyze LM Studio falhou: ${e.message}`);
    }
  }

  // 2. NVIDIA API
  if (!analysis && profile?.nvidiaApiKey) {
    try {
      safeLog("[scan-worker] analyze: NVIDIA");
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({
        baseURL: "https://integrate.api.nvidia.com/v1",
        apiKey: profile.nvidiaApiKey,
      });
      const response = await client.chat.completions.create({
        model: "meta/llama-3.1-405b-instruct",
        messages: [{ role: "user", content: prompt }],
      });
      analysis = response.choices[0]?.message?.content || "";
    } catch (e: any) {
      safeLog(`[scan-worker] analyze NVIDIA falhou: ${e.message}`);
    }
  }

  // 3. Gemini
  if (!analysis && finalApiKey) {
    try {
      safeLog("[scan-worker] analyze: Gemini");
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      analysis = response.text || "";
    } catch (e: any) {
      safeLog(`[scan-worker] analyze Gemini falhou: ${e.message}`);
    }
  }

  if (!analysis) {
    throw new Error("Todos os provedores de análise falharam (LM Studio, NVIDIA, Gemini).");
  }
  return { text: analysis };
}

// B1 — descoberta de estabelecimentos via Overpass + Nominatim. Lê a localização
// do usuário de user_settings (user_lat/user_lng) e varre mercados no raio
// configurado. Upsert em establishments com source='discovered'.
async function handleDiscoverEstablishments(job: Job<ScanJobPayload & { type: "discover-establishments" }>) {
  const userLat = SettingsRepository.getNumber("user_lat");
  const userLng = SettingsRepository.getNumber("user_lng");
  if (userLat === 0 && userLng === 0) {
    throw new Error("Localização do usuário não configurada (user_lat/user_lng em user_settings).");
  }
  const radiusMeters = job.data.radiusMeters ?? SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000;
  safeLog(`[scan-worker] discover-establishments: raio ${radiusMeters}m a partir de (${userLat}, ${userLng})`);

  const discovered = await overpassDiscoverEstablishments({ lat: userLat, lng: userLng }, radiusMeters);
  safeLog(`[scan-worker] Overpass retornou ${discovered.length} estabelecimentos`);

  const existing = EstablishmentRepository.getAll();
  const existingByOsm = new Map(existing.filter((e) => e.osmId).map((e) => [String(e.osmId), e]));
  const existingByName = new Map(existing.map((e) => [e.name.toLowerCase() + "|" + e.lat.toFixed(4), e]));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const d of discovered) {
    // Dedup por osmId; se ausente, por nome + lat近似
    let id: string;
    if (d.osmId && existingByOsm.has(String(d.osmId))) {
      // Atualiza
      const est = existingByOsm.get(String(d.osmId))!;
      est.name = d.name;
      est.category = d.category;
      est.lat = d.lat;
      est.lng = d.lng;
      est.address = d.address;
      est.city = d.city;
      est.state = d.state;
      est.postalCode = d.postalCode;
      est.whatsappNumber = d.phone;
      est.source = "discovered";
      est.osmId = d.osmId;
      EstablishmentRepository.save(est);
      updated++;
      continue;
    }
    const key = d.name.toLowerCase() + "|" + d.lat.toFixed(4);
    if (existingByName.has(key)) {
      skipped++;
      continue;
    }
    id = "osm-" + d.osmId;
    EstablishmentRepository.save({
      id,
      name: d.name,
      chain: d.brand,
      category: d.category,
      lat: d.lat,
      lng: d.lng,
      address: d.address,
      city: d.city,
      state: d.state,
      postalCode: d.postalCode,
      whatsappNumber: d.phone,
      osmId: d.osmId,
      source: "discovered",
    });
    inserted++;
  }
  return { discovered: discovered.length, inserted, updated, skipped };
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
        case "local-insight":
          return handleLocalInsight(job as Job<ScanJobPayload & { type: "local-insight" }>);
        case "local-price-scan":
          return handleLocalPriceScan(job as Job<ScanJobPayload & { type: "local-price-scan" }>);
        case "discover-establishments":
          return handleDiscoverEstablishments(job as Job<ScanJobPayload & { type: "discover-establishments" }>);
        case "analyze":
          return handleAnalyze(job as Job<ScanJobPayload & { type: "analyze" }>);
      }
    },
    {
      connection: getRedis(),
      // A3: concorrência configurável (default 5). Com 4 instâncias pm2 em
      // exec_mode cluster = até 20 jobs simultâneos sem OOM.
      concurrency: SettingsRepository.getNumber("scan_concurrency") || 5,
      // A4: proteção contra jobs travados (lock do BullMQ).
      lockDuration: 65_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
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
