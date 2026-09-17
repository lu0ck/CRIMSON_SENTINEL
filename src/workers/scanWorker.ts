import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { ScanJobPayload } from "../queue/types";
import { AppDataRepository } from "../repositories/appDataRepository";
import { ProductRepository } from "../repositories/productRepository";
import { ProfileRepository } from "../repositories/profileRepository";
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
import { alertFlashPromotion, recordInAppAlert } from "../lib/notify";
import { TRUSTED_DOMAINS, isTrustedHost } from "../lib/trustedDomains";
import { filterAndDedupe, isProductUrl, buildSearchQuery, sameProduct } from "../lib/compare";
import { normalizeProductUrl } from "../lib/url";
import { AI_MODELS } from "../lib/aiModels";

const COMPARE_SEARCH_TIMEOUT_MS = 20_000;
const COMPARE_SCRAPE_TIMEOUT_MS = 30_000;
const COMPARE_NVIDIA_TIMEOUT_MS = 30_000;
const NVIDIA_MAX_RETRIES = 2;
const NVIDIA_RETRY_DELAY_MS = 2_000;
const NVIDIA_EXTRACT_MODEL = "deepseek-ai/deepseek-v4-flash-0731";
const NVIDIA_FALLBACK_MODEL = "z-ai/glm-5.3-flash";
const LM_STUDIO_TIMEOUT_MS = 120_000;
const LM_STUDIO_DEFAULT_URL = "http://127.0.0.1:44277/v1";
const LM_STUDIO_API_KEY = process.env.LM_STUDIO_API_KEY || "lm-studio";

// Corrida com timeout: rejeita a promise após `ms` sem travar o worker.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function handleScrape(job: Job<ScanJobPayload & { type: "scrape" }>) {
  const { url, productId, profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;

  const info = await advancedScrape(url, {
    lmStudioUrl: profile?.lmStudioUrl,
    nvidiaApiKey: profile?.nvidiaApiKey,
    geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
    serperApiKey: profile?.serperApiKey,
    tavilyApiKey: profile?.tavilyApiKey,
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
      const info = await advancedScrape(product.url, {
        lmStudioUrl: profile?.lmStudioUrl,
        nvidiaApiKey: profile?.nvidiaApiKey,
        geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
        serperApiKey: profile?.serperApiKey,
        tavilyApiKey: profile?.tavilyApiKey,
      });
      if (info && info.price) {
        const now = new Date().toISOString();
        const priceChanged = info.price !== product.currentPrice;
        product.previousPrice = priceChanged ? product.currentPrice : product.previousPrice;
        product.currentPrice = info.price;
        product.lastUpdated = now;
        product.lastScrapeMethod = info.method ?? "scan-all";
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
      if (product.url) {
        recordInAppAlert("scrape", product.url, `✗ FALHA NO RASTREIO: ${product.name}`, `${product.url}\n\n${err}`, 1);
      }
    }
  }

  // Atualiza o timestamp do último scan (usado pelo catch-up no boot: se o PC
  // ficou desligado além do refreshInterval, o próximo boot enfileira scan-all).
  SettingsRepository.set("last_scan_timestamp", new Date().toISOString());

  return { updated, errors, total: data.products.length };
}

async function handleCompare(job: Job<ScanJobPayload & { type: "compare" }>) {
  const { productName, profileId, jobKey } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const systemInstruction = `Você é o SENTINEL, um agente de inteligência de mercado de elite.
  Sua missão é extrair preços REAIS e ATUAIS de produtos no mercado brasileiro com precisão cirúrgica.
  FONTES CONFIÁVEIS: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau, Kabum, AliExpress e Shopee (preços em BRL no site Brasil).
  A URL DEVE ser a página EXATA do produto (NUNCA catálogo, busca, categoria ou produtos relacionados).
  O produto encontrado DEVE ser o MESMO modelo/SKU do usuário (conferir código do modelo, ex: KLK00094, KYBER850G-BKCBR). NUNCA um modelo parecido da mesma marca.
  PREÇO À VISTA: Extraia o MENOR PREÇO PARA PAGAMENTO IMEDIATO (Pix ou Boleto).
  PARCELAMENTO: IGNORE o valor total parcelado se houver um preço à vista menor.
  PREÇOS ANTIGOS: Ignore preços riscados. Foque no "Por: R$ ...".
  Retorne um array JSON de objetos: {"site": string, "price": number, "url": string}.
  Se não houver resultados válidos, retorne [].`;

  const prompt = `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras confiáveis.`;
  const searchQuery = buildSearchQuery(productName);

  // Cascata rápido → lento (nunca escrape pesado sequencial):
  // 1) Gemini (1 chamada com googleSearch) — tenta SEMPRE que houver chave;
  // 2) Serper → Tavily para achar URLs confiáveis (+ snippets);
  // 3) advancedScrape em PARALELO (máx 3, timeout 45s/URL);
  // 4) NVIDIA extraindo preços direto dos snippets de busca.

  // 1) GEMINI — caminho rápido.
  if (finalApiKey) {
    try {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      const response = await withTimeout(
        ai.models.generateContent({
          model: AI_MODELS.TEXT,
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
        }),
        COMPARE_SEARCH_TIMEOUT_MS
      );
      const parsed = JSON.parse(response.text || "[]");
      const rawResults = (Array.isArray(parsed) ? parsed : []).filter((r: any) => {
        if (!r || !r.url || !r.price || r.price < 30 || r.price > 5000000) return false;
        try {
          return isTrustedHost(new URL(r.url).hostname);
        } catch {
          return false;
        }
      });
      const results = await filterAndDedupe(rawResults, productName);
      if (results.length > 0) {
        safeLog(`[scan-worker] compare via Gemini: ${results.length} resultados para "${productName}"`);
        const best = results.reduce((a, b) => a.price < b.price ? a : b);
        recordInAppAlert("compare", productName, "MERCADO ENCONTRADO (Gemini)", `${new URL(best.url).hostname}: R$ ${best.price.toFixed(2)} — ${productName}`, 1);
        return { jobKey, results };
      }
      safeLog(`[scan-worker] compare Gemini: ${rawResults.length}/${Array.isArray(parsed) ? parsed.length : 0} válidos — baixando para busca+scrape`);
    } catch (err: any) {
      const msg = err.message || String(err);
      if (/429|quota|rate.?limit/i.test(msg)) {
        safeLog(`[scan-worker] compare Gemini: quota esgotada (429), pulando para Tavily`);
      } else {
        safeLog(`[scan-worker] compare Gemini falhou: ${msg}`);
      }
    }
  }

  // 2) BUSCA — Tavily primeiro (1 chamada com site-operator); Serper como
  //    fallback se Tavily não achar nada.
  type SearchItem = { url: string; snippet: string };
  let items: SearchItem[] = [];
  if (profile?.tavilyApiKey) {
    const siteQuery = `${searchQuery} site:mercadolivre.com.br OR site:kabum.com.br OR site:amazon.com.br OR site:pichau.com.br OR site:terabyteshop.com.br OR site:magazineluiza.com.br OR site:aliexpress.com OR site:shopee.com.br`;
    try {
      const body: any = {
        api_key: profile.tavilyApiKey,
        query: siteQuery,
        search_depth: "basic",
        max_results: 20,
      };
      const res = await withTimeout(
        fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        COMPARE_SEARCH_TIMEOUT_MS
      );
      const j = await res.json();
      items = (Array.isArray(j.results) ? j.results : []).map((x: any) => ({
        url: x.url || "",
        snippet: `${x.title || ""} ${x.content || ""}`,
      }));
      items = items.filter((i) => {
        if (!isProductUrl(i.url)) return false;
        try {
          const h = new URL(i.url).hostname;
          if (/^(?!www\.|pt\.)[a-z]{2}\.aliexpress\.com$/.test(h)) return false;
    } catch (e: any) {
      safeLog(`[scan-worker] compare LM Studio check falhou: ${e?.message || e}`);
    }
        return true;
      });
      safeLog(`[scan-worker] compare Tavily (site-operator): ${items.length} URLs de produto`);
    } catch (err: any) {
      safeLog(`[scan-worker] compare Tavily falhou: ${err.message || err}`);
    }
  }
  if (items.length === 0 && profile?.serperApiKey) {
    try {
      const res = await withTimeout(
        fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": profile.serperApiKey },
          body: JSON.stringify({ q: searchQuery, gl: "br", hl: "pt-br", num: 10 }),
        }),
        COMPARE_SEARCH_TIMEOUT_MS
      );
      const j = await res.json();
      items = (Array.isArray(j.organic) ? j.organic : []).map((x: any) => ({
        url: x.link || "",
        snippet: `${x.title || ""} ${x.snippet || ""}`,
      }));
      items = items.filter((i) => isProductUrl(i.url));
      safeLog(`[scan-worker] compare Serper: ${items.length} URLs de produto`);
    } catch (err: any) {
      safeLog(`[scan-worker] compare Serper falhou: ${err.message || err}`);
    }
  }

  // 3) SCRAPE PARALELO — máx 5 URLs únicas, timeout de 45s por página.
  const seenUrls = new Set<string>();
  const urls = items
    .map((i) => i.url)
    .filter((u) => {
      const key = normalizeProductUrl(u);
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    })
    .slice(0, 5);
  safeLog(`[scan-worker] compare scrape: ${urls.length} URLs para escrapar: ${urls.join(", ")}`);
  const scraped: { site: string; price: number; url: string }[] = [];
  let rejectedSameProduct = 0;
  let rejectedNoData = 0;
  let rejectedLowPrice = 0;
  if (urls.length > 0) {
    const settled = await Promise.allSettled(
      urls.map((url) =>
        withTimeout(
          advancedScrape(url, {
            lmStudioUrl: profile?.lmStudioUrl,
            nvidiaApiKey: profile?.nvidiaApiKey,
            geminiApiKey: finalApiKey,
            serperApiKey: profile?.serperApiKey,
            tavilyApiKey: profile?.tavilyApiKey,
          }),
          COMPARE_SCRAPE_TIMEOUT_MS
        ).then((info: any) => {
          if (!info || !info.price || !info.name) { rejectedNoData++; safeLog(`[scan-worker] compare scrape skip ${url}: no data (price=${info?.price}, name=${info?.name})`); return null; }
          if (!sameProduct(productName, info.name)) { rejectedSameProduct++; safeLog(`[scan-worker] compare scrape skip ${url}: sameProduct=false (name="${info.name}")`); return null; }
          // Descartar preços absurdamente baixos (provavelmente erro de scraping)
          if (info.price < 30) { rejectedLowPrice++; safeLog(`[scan-worker] compare scrape skip ${url}: price R$ ${info.price} too low`); return null; }
          return { site: new URL(url).hostname, price: info.price, url };
        })
      )
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) scraped.push(s.value);
    }
    safeLog(`[scan-worker] compare scrape: ${scraped.length}/${urls.length} URLs com preço do MESMO produto`);
    if (scraped.length > 0) {
      const best = scraped.reduce((a, b) => a.price < b.price ? a : b);
      recordInAppAlert("compare", productName, "MERCADO ENCONTRADO (Scrape)", `${best.site}: R$ ${best.price.toFixed(2)} — ${productName}`, 1);
      return { jobKey, results: scraped };
    }
  }

  // 4) NVIDIA — último recurso: extrai preços dos snippets (sem abrir páginas).
  //    Tenta até NVIDIA_MAX_RETRIES vezes; se DeepSeek falhar, usa GLM Flash.
  safeLog(`[scan-worker] compare step4 check: nvidiaKey=${!!profile?.nvidiaApiKey}, items=${items.length}`);
  if (profile?.nvidiaApiKey && items.length > 0) {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: profile.nvidiaApiKey,
    });
    const snippet = items
      .slice(0, 5)
      .map((i) => `${i.url}\n${i.snippet}`)
      .join("\n---\n")
      .slice(0, 1500);
    const models = [NVIDIA_EXTRACT_MODEL, NVIDIA_FALLBACK_MODEL];
    for (const model of models) {
      for (let attempt = 1; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
        try {
          safeLog(`[scan-worker] compare NVIDIA tentativa ${attempt}/${NVIDIA_MAX_RETRIES} modelo=${model}`);
          const resp = await withTimeout(
            client.chat.completions.create({
              model,
              messages: [
                { role: "system", content: 'Você é o SENTINEL. A partir dos resultados de busca abaixo, retorne APENAS JSON válido, sem markdown: [{"site":"string","price":123.45,"url":"string","title":"string"}]. FONTES: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau, Kabum, AliExpress e Shopee (BRL). Inclua SÓ a página exata do produto pesquisado (mesmo modelo/SKU) — nunca um modelo parecido da mesma marca. Use preços à vista em BRL e só URLs completas. O campo "title" deve conter o nome do produto encontrado na página.' },
                { role: "user", content: `Produto pesquisado: "${productName}"\n\nResultados de busca:\n${snippet}\n\nJSON:` },
              ],
              max_tokens: 600,
              temperature: 0,
            }),
            COMPARE_NVIDIA_TIMEOUT_MS
          );
          const rawText = (resp.choices[0]?.message?.content || "").replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const jm = rawText.match(/\[[\s\S]*\]/);
          if (jm) {
            const parsed = JSON.parse(jm[0]);
            const snippetMap = new Map(items.map((i) => [i.url, i.snippet]));
            const rawResults = (Array.isArray(parsed) ? parsed : []).map((r: any) => ({
              ...r,
              title: r.title || r.site || snippetMap.get(r.url) || productName,
            })).filter(
              (r: any) => r && r.url && r.price >= 30 && r.price <= 5000000
            );
            safeLog(`[scan-worker] compare NVIDIA: ${rawResults.length} resultados brutos (modelo=${model})`);
            const results = await filterAndDedupe(rawResults, productName);
            if (results.length > 0) {
              safeLog(`[scan-worker] compare NVIDIA: ${results.length} resultados após filtro`);
              const best = results.reduce((a, b) => a.price < b.price ? a : b);
              recordInAppAlert("compare", productName, `MERCADO ENCONTRADO (NVIDIA/${model})`, `${new URL(best.url).hostname}: R$ ${best.price.toFixed(2)} — ${productName}`, 1);
              return { jobKey, results };
            }
          }
          safeLog(`[scan-worker] compare NVIDIA: resposta sem resultados válidos (modelo=${model}, tentativa=${attempt})`);
          break; // resposta válida mas sem resultados → não adianta retry
        } catch (err: any) {
          safeLog(`[scan-worker] compare NVIDIA falhou: ${err.message || err} (modelo=${model}, tentativa=${attempt})`);
          if (attempt < NVIDIA_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, NVIDIA_RETRY_DELAY_MS));
          }
        }
      }
    }
  }

  // 5) LM STUDIO — fallback local: envia snippets de busca para o LLM local.
  const lmStudioUrl = profile?.lmStudioUrl || LM_STUDIO_DEFAULT_URL;
  if (items.length > 0) {
    let lmStudioAvailable = false;
    let detectedModel = "local-model";
    try {
      const checkResp = await withTimeout(
        fetch(`${lmStudioUrl}/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LM_STUDIO_API_KEY}` },
        }),
        3_000
      );
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        if (checkData.data && checkData.data.length > 0) {
          detectedModel = checkData.data[0].id;
          lmStudioAvailable = true;
        } else if (checkData.models && checkData.models.length > 0) {
          detectedModel = checkData.models[0].model || checkData.models[0].name || "local-model";
          lmStudioAvailable = true;
        }
      }
    } catch (e: any) {
      safeLog(`[scan-worker] compare LM Studio check falhou: ${e?.message || e}`);
    }
    if (lmStudioAvailable) {
      try {
        const OpenAI = (await import("openai")).default;
        const client = new OpenAI({ baseURL: lmStudioUrl, apiKey: LM_STUDIO_API_KEY });
        const snippet = items
          .slice(0, 5)
          .map((i) => `${i.url}\n${i.snippet}`)
          .join("\n---\n")
          .slice(0, 1500);
        safeLog(`[scan-worker] compare LM Studio: modelo=${detectedModel}, tentando extrair preços (timeout=${LM_STUDIO_TIMEOUT_MS / 1000}s)`);
        const lmStart = Date.now();
        const resp = await withTimeout(
          client.chat.completions.create({
            model: detectedModel,
            messages: [
              {
                role: "system",
                content:
                  'Retorne APENAS JSON válido, sem markdown: [{"site":"string","price":123.45,"url":"string"}]. Só inclua o produto pesquisado se for EXATAMENTE o mesmo modelo. Preço à vista BRL. Se nada correspondente, retorne [].',
              },
              {
                role: "user",
                content: `Produto: "${productName}"\n\nBuscas:\n${snippet}\n\nJSON:`,
              },
            ],
            max_tokens: 2048,
            temperature: 0,
          }),
          LM_STUDIO_TIMEOUT_MS
        );
        const lmElapsed = ((Date.now() - lmStart) / 1000).toFixed(1);
        const msg = resp.choices[0]?.message as any;
        const rawText = (msg?.content || msg?.reasoning_content || "")
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();
        safeLog(`[scan-worker] compare LM Studio raw (${lmElapsed}s): ${rawText.slice(0, 300)}`);
        const jm = rawText.match(/\[[\s\S]*\]/);
        if (jm) {
          const parsed = JSON.parse(jm[0]);
          const snippetMap = new Map(items.map((i) => [i.url, i.snippet]));
          const rawResults = (Array.isArray(parsed) ? parsed : [])
            .map((r: any) => ({
              ...r,
              title: r.title || r.site || snippetMap.get(r.url) || productName,
            }))
            .filter((r: any) => r && r.url && r.price >= 30 && r.price <= 5000000);
          safeLog(`[scan-worker] compare LM Studio: ${rawResults.length} resultados brutos (${lmElapsed}s)`);
          const results = await filterAndDedupe(rawResults, productName);
          if (results.length > 0) {
            safeLog(`[scan-worker] compare LM Studio: ${results.length} resultados após filtro`);
            const best = results.reduce((a: any, b: any) => (a.price < b.price ? a : b));
            recordInAppAlert(
              "compare",
              productName,
              `MERCADO ENCONTRADO (LM Studio)`,
              `${new URL(best.url).hostname}: R$ ${best.price.toFixed(2)} — ${productName}`,
              1
            );
            return { jobKey, results };
          }
        }
        safeLog(`[scan-worker] compare LM Studio: resposta sem resultados válidos (${lmElapsed}s)`);
      } catch (err: any) {
        safeLog(`[scan-worker] compare LM Studio falhou: ${err.message || err}`);
      }
    } else {
      safeLog(`[scan-worker] compare LM Studio indisponível, pulando`);
    }
  }

  const parts: string[] = [];
  if (items.length > 0) parts.push(`${items.length} links encontrados`);
  if (urls.length > 0) parts.push(`${urls.length} URLs escavadas`);
  if (rejectedSameProduct > 0) parts.push(`${rejectedSameProduct} rejeitadas (produto diferente)`);
  if (rejectedNoData > 0) parts.push(`${rejectedNoData} falha no scrape`);
  if (rejectedLowPrice > 0) parts.push(`${rejectedLowPrice} preço muito baixo`);
  const detail = parts.length > 0 ? `\n\nDetalhes: ${parts.join(", ")}` : "";

  const detailsPayload = {
    searchItems: items.slice(0, 10).map((i) => ({ url: i.url, snippet: i.snippet.slice(0, 200) })),
    scrapedUrls: urls,
    rejectedSameProduct,
    rejectedNoData,
    rejectedLowPrice,
  };

  recordInAppAlert(
    "compare",
    productName,
    "MERCADO SEM RESULTADOS",
    `Nenhum preço compatível encontrado para "${productName}" nas lojas pesquisadas.${detail}`,
    6,
    JSON.stringify(detailsPayload)
  );
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
        model: AI_MODELS.TEXT,
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
  const hasMultiplePrices = lowestPrice && lowestPriceDate && currentPrice !== lowestPrice;
  const prompt = `Você é um assistente ajudando um amigo a decidir se vale a pena comprar um produto de tecnologia.

Produto: "${productName}"
Preço Atual: ${cur} ${currentPrice}
${lowestPrice && lowestPriceDate ? `Referência histórica: ${cur} ${lowestPrice} (registrado em ${lowestPriceDate})` : "Sem dados históricos de preços."}

REGRAS IMPORTANTES:
- Se só temos 1 registro de preço, NÃO afirme que é "menor preço registrado" ou "maior preço". Diga apenas "único preço registrado".
- Só faça comparações de preço quando houver dados históricos suficientes (2+ registros).
- NUNCA invente dados. Se não souber algo, diga que não há informação suficiente.

Responda de forma SIMPLES e DIRETA, como amigo conversando. NÃO use termos técnicos de bolsa de valores.

**Formato de resposta:**

VALE A PENA? [Sim/Não/Talvez] - uma frase explicando por quê

PREÇO JUSTO: ${cur} X.XXX - quanto você pagaria nesse produto

QUANDO COMPRAR: [Agora/Esperar] - se deve comprar agora ou esperar promoção

DICA: Uma frase com conselho prático

${hasMultiplePrices && currentPrice > lowestPrice * 1.1 ? `ATENÇÃO: O preço já foi ${cur} ${lowestPrice}. Se esperar, pode baixar de novo.` : ""}

Fale de forma natural, sem saudações como "Olá" ou "Amigo".`;

  let analysis = "";

  // 1. Local LLM (LM Studio)
  if (profile?.lmStudioUrl) {
    try {
      safeLog("[scan-worker] analyze: LM Studio");
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ baseURL: profile.lmStudioUrl, apiKey: "lm-studio" });
      const response = await client.chat.completions.create({
        model: AI_MODELS.LOCAL_LLM,
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
        model: AI_MODELS.TEXT,
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
    if (job?.data?.type === "scrape" && job?.data?.url) {
      recordInAppAlert("scrape", job.data.url, "✗ SCRAPE FALHOU", `${job.data.url}\n\n${err.message}`, 1);
    }
  });
  worker.on("error", (err) => {
    safeLog(`[scan-worker] erro: ${err.message}`);
  });

  console.log("[scan-worker] rodando, escutando " + QUEUE_NAMES.SCAN);
  return worker;
}
