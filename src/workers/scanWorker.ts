import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES } from "../queue/queues";
import type { ScanJobPayload } from "../queue/types";
import { AppDataRepository } from "../repositories/appDataRepository";
import { ProductRepository } from "../repositories/productRepository";
import { ProfileRepository } from "../repositories/profileRepository";
import { advancedScrape, isPriceRealistic } from "../lib/scraper";
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
import { resolveMarketHandler } from "../lib/market-handlers";
import { overpassDiscoverEstablishments, haversineKm, type GeoPoint } from "../lib/geo";
import { isFlashPrice, createFlashPromotion } from "../lib/flashDetect";
import { alertFlashPromotion, recordInAppAlert } from "../lib/notify";
import { filterAndDedupe, isProductUrl, buildSearchQuery, sameProduct } from "../lib/compare";
import { normalizeProductUrl } from "../lib/url";
import { AI_MODELS } from "../lib/aiModels";

const COMPARE_SEARCH_TIMEOUT_MS = 20_000;
const COMPARE_SCRAPE_TIMEOUT_MS = 30_000;
const COMPARE_NVIDIA_TIMEOUT_MS = 30_000;
const NVIDIA_MAX_RETRIES = 2;
const NVIDIA_RETRY_DELAY_MS = 2_000;
// #43 — -0731/-flash EOL 410; sondado 2026-09-24
const NVIDIA_EXTRACT_MODEL = "z-ai/glm-5.3";
const NVIDIA_FALLBACK_MODEL = "openai/gpt-oss-20b";
const LM_STUDIO_TIMEOUT_MS = 120_000;
const LM_STUDIO_DEFAULT_URL = "http://127.0.0.1:1234/v1";
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
    // #41 — progresso real por estratégia (UI deixa de simular/engatar em 99%)
    onProgress: (p) => {
      void job.updateProgress(p).catch(() => {});
    },
  });

  if (productId && info?.price) {
    const product = ProductRepository.getById(productId);
    if (product) {
      // #44 — não persiste/não alerta preço irreal (frete/parcela/unidade vindos de busca)
      if (!isPriceRealistic(info.price, product.name || product.url)) {
        safeLog(`[scan-worker] preço irreal descartado p/ ${product.name}: R$ ${info.price} (mantido R$ ${product.currentPrice})`);
      } else {
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
              product.targetPrice,
              product.url
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
              await alertFlashPromotion(promo, "E-commerce", flash.reason, product.url);
              safeLog(`[scan-worker] FLASH detectado em ${product.name}: ${flash.reason}`);
            }
          }
        } catch (err) {
          safeLog(`[scan-worker] erro na detecção flash: ${err}`);
        }
      }
    }
  }

  return info;
}

async function handleScanAll() {
  const data = AppDataRepository.getAll();
  let updated = 0;
  let errors = 0;

  for (const snap of data.products) {
    try {
      // #47 — re-lê do banco ANTES de cada iteração: produto deletado durante o scan
      // NÃO é re-inserido (save() é upsert) e campos alterados no meio não são sobrescritos
      const product = ProductRepository.getById(snap.id);
      if (!product) {
        safeLog(`[scan-worker] produto removido durante o scan, pulando: ${snap.name || snap.id}`);
        continue;
      }
      const profile = data.profiles.find((p) => p.id === product.profileId);
      const info = await advancedScrape(product.url, {
        lmStudioUrl: profile?.lmStudioUrl,
        nvidiaApiKey: profile?.nvidiaApiKey,
        geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY,
        serperApiKey: profile?.serperApiKey,
        tavilyApiKey: profile?.tavilyApiKey,
      });
      if (info && info.price) {
        // #44 — gate igual ao handleScrape: preço irreal não atualiza nem alerta
        if (!isPriceRealistic(info.price, product.name || product.url)) {
          safeLog(`[scan-worker] preço irreal descartado p/ ${product.name}: R$ ${info.price} (mantido R$ ${product.currentPrice})`);
        } else {
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
              product.targetPrice,
              product.url
            );
            if (alerted) safeLog(`[scan-worker] ALERTA enviado: ${product.name} atingiu alvo`);
          } catch (err) {
            safeLog(`[scan-worker] erro ao enviar alerta de alvo: ${err}`);
          }
        }
        }
      }
      await new Promise((r) => setTimeout(r, 5_000));
    } catch (err) {
      errors++;
      safeLog(`[scan-worker] erro ${snap.name}: ${err}`);
      if (snap.url) {
        recordInAppAlert("scrape", snap.url, `✗ FALHA NO RASTREIO: ${snap.name}`, `${snap.url}\n\n${err}`, 1);
      }
    }
  }

  // Atualiza o timestamp do último scan (usado pelo catch-up no boot: se o PC
  // ficou desligado além do refreshInterval, o próximo boot enfileira scan-all).
  SettingsRepository.set("last_scan_timestamp", new Date().toISOString());

  return { updated, errors, total: data.products.length };
}

// ---------------------------------------------------------------------------
// Comparação de mercado — lógica central (compartilhada entre single e batch).
// ---------------------------------------------------------------------------

type CompareResult = { site: string; price: number; url: string };

async function runComparison(
  productName: string,
  profile: { geminiApiKey?: string; tavilyApiKey?: string; serperApiKey?: string; nvidiaApiKey?: string; lmStudioUrl?: string } | undefined
): Promise<CompareResult[]> {
  const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const systemInstruction = `Você é o SENTINELA, um agente de inteligência de mercado de elite.
  Sua missão é extrair preços REAIS e ATUAIS de produtos no mercado brasileiro com precisão cirúrgica.
  FONTES CONFIÁVEIS: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau, Kabum, AliExpress e Shopee (preços em BRL no site Brasil).
  A URL DEVE ser a página EXATA do produto (NUNCA catálogo, busca, categoria, loja ou produtos relacionados).
  URL DIRETA: AliExpress precisa conter /item/ (ou /i/); Amazon precisa conter /dp/ ou /gp/product/; Shopee precisa conter -i.<seller>.<item> ou /product/; Mercado Livre precisa conter MLB-<número>.
  O produto encontrado DEVE ser o MESMO modelo/SKU do usuário (conferir código do modelo, ex: KLK00094, KYBER850G-BKCBR). NUNCA um modelo parecido da mesma marca.
  PREÇO À VISTA: Extraia o MENOR PREÇO PARA PAGAMENTO IMEDIATO (Pix ou Boleto).
  PARCELAMENTO: IGNORE o valor total parcelado se houver um preço à vista menor.
  PREÇOS ANTIGOS: Ignore preços riscados. Foque no "Por: R$ ...".
  Retorne um array JSON de objetos: {"site": string, "price": number, "url": string, "title": string} (title = título do anúncio/página).
  Se não houver resultados válidos, retorne [].`;

  const prompt = `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras confiáveis.`;
  const searchQuery = buildSearchQuery(productName);

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
                  title: { type: Type.STRING },
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
        return isProductUrl(r.url); // #46 — só páginas diretas de produto
      }).map((r: any) => ({ ...r, title: r.title || productName }));
      const results = await filterAndDedupe(rawResults, productName);
      if (results.length > 0) {
        const geminiUrls = results.map((r) => r.url).filter((u) => isProductUrl(u)).slice(0, 3);
        const confirmed: Array<{ url: string; title: string; price: number }> = [];
        if (geminiUrls.length > 0) {
          const gemSettled = await Promise.allSettled(
            geminiUrls.map((url) =>
              withTimeout(
                advancedScrape(url, {
                  lmStudioUrl: profile?.lmStudioUrl,
                  nvidiaApiKey: profile?.nvidiaApiKey,
                  geminiApiKey: finalApiKey,
                  serperApiKey: profile?.serperApiKey,
                  tavilyApiKey: profile?.tavilyApiKey,
                }),
                15_000
              ).then((info: any) => {
                if (!info || !info.price || info.available === false) return null;
                return { url, title: info.name || productName, price: info.price };
              })
            )
          );
          for (const g of gemSettled) {
            if (g.status === "fulfilled" && g.value) confirmed.push(g.value);
          }
        }
        if (confirmed.length > 0) {
          const deduped = await filterAndDedupe(confirmed, productName);
          if (deduped.length > 0) {
            safeLog(`[compare] Gemini+scrape: ${deduped.length} resultados CONFIRMADOS para "${productName}"`);
            return deduped.map((r) => ({ site: new URL(r.url).hostname, price: r.price, url: r.url }));
          }
        }
        safeLog(`[compare] Gemini: ${results.length} resultados mas nenhum confirmado — continuando`);
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      if (/429|quota|rate.?limit/i.test(msg)) {
        safeLog(`[compare] Gemini: quota esgotada (429), pulando`);
      } else {
        safeLog(`[compare] Gemini falhou: ${msg}`);
      }
    }
  }

  // 2) BUSCA — Tavily primeiro; Serper como fallback.
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
          safeLog(`[compare] LM Studio check falhou: ${e?.message || e}`);
        }
        return true;
      });
    } catch (err: any) {
      safeLog(`[compare] Tavily falhou: ${err.message || err}`);
    }
    safeLog(`[compare] Tavily retornou ${items.length} resultados`);
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
    } catch (err: any) {
      safeLog(`[compare] Serper falhou: ${err.message || err}`);
    }
    safeLog(`[compare] Serper retornou ${items.length} resultados`);
  }

  // Filtrar snippets com keywords de esgotamento.
  const UNAVAILABLE_SNIPPET_KEYWORDS = ["esgotado", "indisponível", "indisponivel", "sem estoque", "fora de estoque", "sold out", "unavailable"];
  const itemsBefore = items.length;
  items = items.filter((i) => {
    const snipLower = (i.snippet || "").toLowerCase();
    return !UNAVAILABLE_SNIPPET_KEYWORDS.some((kw) => snipLower.includes(kw));
  });
  if (itemsBefore !== items.length) {
    safeLog(`[compare] ${itemsBefore - items.length} snippets descartados por esgotamento`);
  }

  // 3) SCRAPE PARALELO — máx 5 URLs, timeout de 45s por página.
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
  const scraped: CompareResult[] = [];
  let rejectedSameProduct = 0, rejectedNoData = 0, rejectedLowPrice = 0, rejectedUnavailable = 0;
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
          if (!info || !info.price || !info.name) { rejectedNoData++; return null; }
          if (info.available === false) { rejectedUnavailable++; return null; }
          if (!sameProduct(productName, info.name)) { rejectedSameProduct++; return null; }
          if (info.price < 30) { rejectedLowPrice++; return null; }
          return { site: new URL(url).hostname, price: info.price, url };
        })
      )
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) scraped.push(s.value);
    }
    safeLog(`[compare] scrape: ${scraped.length}/${urls.length} ok (${rejectedSameProduct} outro produto, ${rejectedNoData} sem dados, ${rejectedLowPrice} preço baixo, ${rejectedUnavailable} esgotado)`);
    if (scraped.length > 0) return scraped;
  }

  // 4) NVIDIA — extrai preços dos snippets.
  if (profile?.nvidiaApiKey && items.length > 0) {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: profile.nvidiaApiKey,
    });
    const snippet = items.slice(0, 5).map((i) => `${i.url}\n${i.snippet}`).join("\n---\n").slice(0, 1500);
    const models = [NVIDIA_EXTRACT_MODEL, NVIDIA_FALLBACK_MODEL];
    for (const model of models) {
      for (let attempt = 1; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
        try {
          const resp = await withTimeout(
            client.chat.completions.create({
              model,
              messages: [
                { role: "system", content: 'Retorne APENAS JSON: [{"site":"string","price":123.45,"url":"string","title":"string"}]. Só o mesmo modelo/SKU. Preço à vista BRL. A url deve ser a PÁGINA DIRETA do produto (AliExpress: precisa conter /item/; Amazon: /dp/ ou /gp/product/; Shopee: -i.<seller>.<item> ou /product/; Mercado Livre: MLB-<número>) — NUNCA URL de catálogo, busca ou loja.' },
                { role: "user", content: `Produto: "${productName}"\n\nBuscas:\n${snippet}\n\nJSON:` },
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
              ...r, title: r.title || r.site || snippetMap.get(r.url) || productName,
            })).filter((r: any) => r && r.url && r.price >= 30 && r.price <= 5000000 && isProductUrl(r.url)); // #46
            const results = await filterAndDedupe(rawResults, productName);
            if (results.length > 0) return results.map((r) => ({ site: new URL(r.url).hostname, price: r.price, url: r.url }));
          }
          break;
        } catch (err: any) {
          if (attempt < NVIDIA_MAX_RETRIES) await new Promise((r) => setTimeout(r, NVIDIA_RETRY_DELAY_MS));
        }
      }
    }
  }

  // 5) LM STUDIO — fallback local.
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
    } catch { /* skip */ }
    if (lmStudioAvailable) {
      try {
        const OpenAI = (await import("openai")).default;
        const client = new OpenAI({ baseURL: lmStudioUrl, apiKey: LM_STUDIO_API_KEY });
        const snippet = items.slice(0, 5).map((i) => `${i.url}\n${i.snippet}`).join("\n---\n").slice(0, 1500);
        const resp = await withTimeout(
          client.chat.completions.create({
            model: detectedModel,
            messages: [
              { role: "system", content: 'Retorne APENAS JSON: [{"site":"string","price":123.45,"url":"string"}]. Só o mesmo modelo. Preço à vista BRL. Se nada, retorne []. A url deve ser a PÁGINA DIRETA do produto (AliExpress: precisa conter /item/; Amazon: /dp/ ou /gp/product/; Shopee: -i.<seller>.<item> ou /product/; Mercado Livre: MLB-<número>) — NUNCA URL de catálogo, busca ou loja.' },
              { role: "user", content: `Produto: "${productName}"\n\nBuscas:\n${snippet}\n\nJSON:` },
            ],
            max_tokens: 2048,
            temperature: 0,
          }),
          LM_STUDIO_TIMEOUT_MS
        );
        const msg = resp.choices[0]?.message as any;
        const rawText = (msg?.content || msg?.reasoning_content || "").replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const jm = rawText.match(/\[[\s\S]*\]/);
        if (jm) {
          const parsed = JSON.parse(jm[0]);
          const snippetMap = new Map(items.map((i) => [i.url, i.snippet]));
          const rawResults = (Array.isArray(parsed) ? parsed : []).map((r: any) => ({
            ...r, title: r.title || r.site || snippetMap.get(r.url) || productName,
          })).filter((r: any) => r && r.url && r.price >= 30 && r.price <= 5000000 && isProductUrl(r.url)); // #46
          const results = await filterAndDedupe(rawResults, productName);
          if (results.length > 0) return results.map((r) => ({ site: new URL(r.url).hostname, price: r.price, url: r.url }));
        }
      } catch { /* skip */ }
    }
  }

  safeLog(`[compare] NENHUM resultado válido para "${productName}" — query: "${searchQuery}"`);
  return [];
}

// ---------------------------------------------------------------------------
// handleCompare — comparação single (job type "compare").
// ---------------------------------------------------------------------------
async function handleCompare(job: Job<ScanJobPayload & { type: "compare" }>) {
  const { productName, profileId, jobKey } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;

  const results = await runComparison(productName, profile);

  if (results.length > 0) {
    const best = results.reduce((a, b) => a.price < b.price ? a : b);
    recordInAppAlert("compare", productName, "MERCADO ENCONTRADO", `${best.site}: R$ ${best.price.toFixed(2)} — ${productName}`, 1);
    return { jobKey, results };
  }

  recordInAppAlert("compare", productName, "MERCADO SEM RESULTADOS", `Nenhum preço compatível encontrado para "${productName}".`, 6);
  return { jobKey, results: [] };
}

// ---------------------------------------------------------------------------
// handleCompareAll — comparação em lote (job type "compare-all").
// ---------------------------------------------------------------------------
async function handleCompareAll(job: Job<ScanJobPayload & { type: "compare-all" }>) {
  const { products, profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const total = products.length;
  const results: Record<string, CompareResult[]> = {};

  safeLog(`[compare-all] iniciando comparação em lote: ${total} produtos`);

  for (let i = 0; i < total; i++) {
    const product = products[i];
    await job.updateProgress({ current: i + 1, total, productName: product.name });
    safeLog(`[compare-all] ${i + 1}/${total} — ${product.name}`);

    try {
      const productResults = await runComparison(product.name, profile);
      results[product.id] = productResults;
      if (productResults.length > 0) {
        const best = productResults.reduce((a, b) => a.price < b.price ? a : b);
        safeLog(`[compare-all] ${product.name}: ${productResults.length} resultados (menor: R$ ${best.price})`);
      } else {
        safeLog(`[compare-all] ${product.name}: sem resultados`);
      }
    } catch (err: any) {
      safeLog(`[compare-all] ${product.name}: erro — ${err.message || err}`);
      results[product.id] = [];
    }

    // Cooldown entre produtos para não sobrecarregar APIs.
    if (i < total - 1) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  const withResults = Object.values(results).filter((r) => r.length > 0).length;
  safeLog(`[compare-all] concluído: ${withResults}/${total} produtos com dados de mercado`);
  recordInAppAlert(
    "compare-all",
    `${total} produtos`,
    "COMPARAÇÃO EM LOTE CONCLUÍDA",
    `${withResults}/${total} produtos com dados de mercado encontrados.`,
    1
  );

  return { results };
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
    // #32 — keys de busca para market-handlers (padrão process.env igual /api/status)
    serperApiKey: profile?.serperApiKey || process.env.SERPER_API_KEY,
    tavilyApiKey: profile?.tavilyApiKey || process.env.TAVILY_API_KEY,
  };

  const items = ShoppingListRepository.getAll();
  // B2 — filtro por raio: se establishmentId ausente, varre apenas est.
  // com price_url E dentro do raio configurado a partir da localização do
  // usuário (user_lat/user_lng em user_settings).
  const userLat = SettingsRepository.getNumber("user_lat");
  const userLng = SettingsRepository.getNumber("user_lng");
  const radiusMeters = SettingsRepository.getNumber("geolocation_search_radius_m") ?? 5000;
  const hasUserLocation = !!userLat && !!userLng;

  let targets: import("../types").Establishment[];
  if (establishmentId) {
    const est = EstablishmentRepository.getById(establishmentId);
    targets = est ? [est] : [];
  } else {
    // #33 — bulk/cron: price_url sempre; sem price_url só se handler resolve
    // E houver keys de busca (Serper|Tavily + NVIDIA|Gemini). Cap de custo:
    // no máximo MARKET_SEARCH_BULK_MAX est. só-chain por run (evita N×items
    // chamadas Serper no cron sem profileId).
    const MARKET_SEARCH_BULK_MAX = 8;
    const canMarketSearch =
      !!(apiKeys.serperApiKey || apiKeys.tavilyApiKey) &&
      !!(apiKeys.nvidiaApiKey || apiKeys.geminiApiKey);
    const all = EstablishmentRepository.getAll();
    const withUrl = all.filter((e) => e.priceUrl);
    let chainOnly: import("../types").Establishment[] = [];
    if (canMarketSearch) {
      chainOnly = all
        .filter((e) => !e.priceUrl && resolveMarketHandler(e.chain || e.name))
        .slice(0, MARKET_SEARCH_BULK_MAX);
      if (chainOnly.length > 0) {
        safeLog(
          `[scan-worker] local-price-scan bulk: +${chainOnly.length} est. só-chain (cap ${MARKET_SEARCH_BULK_MAX}) p/ market-search`
        );
      }
    }
    targets = [...withUrl, ...chainOnly];
    if (hasUserLocation) {
      const center: GeoPoint = { lat: userLat, lng: userLng };
      targets = targets.filter((e) => haversineKm(center, { lat: e.lat, lng: e.lng }) * 1000 <= radiusMeters);
      safeLog(`[scan-worker] local-price-scan: filtro raio ${radiusMeters}m manteve ${targets.length} est. de ${all.length}`);
    } else {
      safeLog(
        `[scan-worker] local-price-scan: sem user_lat/user_lng, varrendo ${withUrl.length} com price_url${chainOnly.length ? ` + ${chainOnly.length} só-chain` : ""}`
      );
    }
  }

  const outcomes: LocalPriceScanOutcome[] = [];
  for (const est of targets) {
    // #32 — sem price_url: cascade market-handler / social-dependent dentro de scanEstablishmentPrices
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
            await alertFlashPromotion(promo, est.name, flash.reason, r.url);
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
  const socialDependent = outcomes.reduce((a, o) => a + (o.socialDependent || 0), 0);
  return {
    establishmentId,
    establishments: outcomes.length,
    recorded,
    duplicates,
    errors,
    socialDependent,
    outcomes,
  };
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
  if (!userLat || !userLng) {
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
      // #32 — brand do OSM vira chain p/ market-handlers
      if (d.brand && !est.chain) est.chain = d.brand;
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
        case "compare-all":
          return handleCompareAll(job as Job<ScanJobPayload & { type: "compare-all" }>);
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
      // A4/#30: lock deve cobrir UMA estratégia de scrape (timeout 90s em
      // scraper.ts) + margem. Antes 65s < 90s → sob 20 jobs concorrentes,
      // renovação podia falhar e BullMQ re-entregava (stalled, maxStalledCount 1).
      lockDuration: 120_000,
      stalledInterval: 60_000,
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
