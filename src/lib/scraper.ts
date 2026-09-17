import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import OpenAI from "openai";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";
import path from "path";
import { getStoreHandler, storeHandlers } from "./store-handlers";
import { CACHE_DIR, COOKIE_DIR } from "../database/db";
import { scraperBreaker } from "./circuitBreaker.ts";
import { AI_MODELS } from "./aiModels";

// @ts-ignore
chromium.use(stealth());

// CACHE_DIR/COOKIE_DIR agora vêm de db.ts (sob DATA_DIR, FASE 3) — não dependem
// mais de process.cwd(), que divergia entre api, workers e produção.

export interface ScrapeResult {
  name: string;
  price: number;
  currency: string;
  available: boolean;
  imageUrl?: string;
  method?: string;
  priceConfirmed?: boolean;
  nameSource?: string;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

const MAX_PRICE = 10_000_000;

// Modelo de extração NVIDIA NIM (o antigo meta/llama-3.1-8b-instruct foi retirado da lista)
const NVIDIA_EXTRACT_MODEL = "deepseek-ai/deepseek-v4-flash-0731";
const NVIDIA_FALLBACK_MODEL = "z-ai/glm-5.3-flash";
const NVIDIA_MAX_RETRIES = 2;
const NVIDIA_RETRY_DELAY_MS = 2_000;

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

let cachedLMStudioModel: string | null = null;

async function detectLMStudioModel(baseUrl: string): Promise<string> {
	if (cachedLMStudioModel) {
		return cachedLMStudioModel;
	}

	try {
		const response = await fetch(`${baseUrl}/models`, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
		});

		if (response.ok) {
			const data = await response.json();
			if (data.data && data.data.length > 0) {
				const modelId = data.data[0].id;
				console.log("[LM Studio] Detected model:", modelId);
				cachedLMStudioModel = modelId;
				return modelId;
			}
		}
	} catch (error) {
		console.log("[LM Studio] Could not detect model, using default");
	}

	return "local-model";
}

function isVisionModel(modelId: string): boolean {
	const visionKeywords = ["vl", "vision", "qwen-vl", "llava", "bakllava", "cogvlm"];
	const lowerModelId = modelId.toLowerCase();
	for (const keyword of visionKeywords) {
		if (lowerModelId.indexOf(keyword) !== -1) {
			return true;
		}
	}
	return false;
}

export function isValidPrice(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (price > MAX_PRICE) return false;
  if (price > 1e10 || (price < 1 && price > 0 && price < 1e-10)) return false;
  return true;
}

export function sanitizePrice(price: number): number {
  if (!isValidPrice(price)) return 0;
  return Math.round(price * 100) / 100;
}

export function isScientificNotation(text: string): boolean {
  return /[eE][+-]?\d+/i.test(text);
}

function isPriceRealistic(price: number, productName?: string): boolean {
  // Preços devem estar entre R$ 10 e R$ 5.000.000
  if (price < 10 || price > 5000000) {
    return false;
  }

  if (productName) {
    const nameLower = productName.toLowerCase();

    // Cap geral para produtos que NÃO são veículos/imóveis
    const expensiveKeywords = ['carro', 'veículo', 'veiculo', 'automóvel', 'automovel', 'moto', 'barco', 'embarcação', 'imóvel', 'imovel', 'apartamento', 'casa', 'terreno', 'veleiro', 'ian', 'ia'];
    const isExpensive = expensiveKeywords.some(k => nameLower.includes(k));
    if (!isExpensive && price > 50000) {
      return false;
    }

    // Placas-mãe devem ter preço mínimo de R$ 200
    if (nameLower.includes('placa mae') || nameLower.includes('placa-mãe') || 
        nameLower.includes('motherboard') || nameLower.includes('placa mãe')) {
      return price >= 200 && price <= 15000;
    }

    // Placas de vídeo e processadores — preço mínimo maior
    if (nameLower.includes('rtx') || nameLower.includes('radeon') ||
        nameLower.includes('ryzen') || nameLower.includes('intel') ||
        nameLower.includes('placa de video') || nameLower.includes('placa de vídeo') ||
        nameLower.includes('processador') || nameLower.includes('gpu')) {
      // Xeons antigos, CPUs server e processadores antigos são baratos (AliExpress/OLX)
      if (nameLower.includes('xeon') || nameLower.includes('e5-') || nameLower.includes('e3-') ||
          nameLower.includes('opteron') || nameLower.includes('epyc') ||
          nameLower.includes('i3-') || nameLower.includes('i5-2') || nameLower.includes('i5-3') ||
          nameLower.includes('i7-2') || nameLower.includes('i7-3') || nameLower.includes('pentium') ||
          nameLower.includes('celeron')) {
        return price >= 30 && price <= 30000;
      }
      // Coolers, ventoinhas e watercoolers citam Intel/AMD só por compatibilidade — são baratos
      if (nameLower.includes('cooler') || nameLower.includes('ventoinha') ||
          nameLower.includes('watercooler') || nameLower.includes('cooling') ||
          nameLower.includes('pasta termica') || nameLower.includes('pasta térmica') ||
          nameLower.includes('fan set') || nameLower.includes('kit fan')) {
        return price >= 15 && price <= 3000;
      }
      // Placas de vídeo de alta gama (RX 9070, RTX 4080, etc) devem ter preço mínimo maior
      if (nameLower.includes('9070') || nameLower.includes('4080') ||
          nameLower.includes('4090') || nameLower.includes('7900') ||
          nameLower.includes('4070') || nameLower.includes('4070 ti') ||
          nameLower.includes('7800') || nameLower.includes('6950') ||
          nameLower.includes('3090') || nameLower.includes('3080')) {
        return price >= 3000 && price <= 30000;
      }
      // Placas antigas/baratas (RX 580, GTX 1050, etc) — preço mínimo menor
      if (nameLower.includes('580') || nameLower.includes('570') || nameLower.includes('590') ||
          nameLower.includes('1050') || nameLower.includes('1060') || nameLower.includes('1070') ||
          nameLower.includes('1650') || nameLower.includes('1660') || nameLower.includes('rx 5') ||
          nameLower.includes('rx 6') || nameLower.includes('arc a')) {
        return price >= 100 && price <= 20000;
      }
      return price >= 300 && price <= 30000;
    }

    // Storage (SSD, HD, Memória) deve ter preço mínimo razoável
    if (nameLower.includes('ssd') || nameLower.includes('hd') ||
        nameLower.includes('memória') || nameLower.includes('memoria') ||
        nameLower.includes('pendrive') || nameLower.includes('ddr') ||
        nameLower.includes('ram')) {
      return price >= 50 && price <= 10000;
    }

    // Monitores e TVs devem ter preço mínimo
    if (nameLower.includes('monitor') || nameLower.includes('tv ') ||
        nameLower.includes('televisão')) {
      return price >= 150 && price <= 30000;
    }

    // Periféricos (teclado, mouse, headset) devem ter preço mínimo
    if (nameLower.includes('teclado') || nameLower.includes('mouse') ||
        nameLower.includes('headset') || nameLower.includes('fone')) {
      return price >= 20 && price <= 5000;
    }

    // Roupas, acessórios, banho — não pode custar mais que R$ 5000
    if (nameLower.includes('cueca') || nameLower.includes('calça') || nameLower.includes('camisa') ||
        nameLower.includes('bermuda') || nameLower.includes('kit ') || nameLower.includes('algodão') ||
        nameLower.includes('roupa') || nameLower.includes('vestido')) {
      return price >= 10 && price <= 5000;
    }

    // Celulares e tablets
    if (nameLower.includes('celular') || nameLower.includes('iphone') || nameLower.includes('samsung') ||
        nameLower.includes('xiaomi') || nameLower.includes('ipad') || nameLower.includes('tablet')) {
      return price >= 100 && price <= 15000;
    }
  }

  return true;
}

// Nomes que NÃO são nomes de produto (filtros, labels, headers de busca)
const INVALID_PRODUCT_NAMES = [
  "intervalo de preço", "intervalo de preco", "faixa de preço", "faixa de preco",
  "preço", "preco", "price", "filtrar", "ordenar", "relevantes",
  "menor preço", "menor preco", "maior preço", "maior preco",
  "novidades", "promoções", "promocoes", "mais vendidos",
  "resultados para", "buscando por", "nenhum resultado",
  "comprar", "adicionar", "ver mais", "ver todos",
  "marca", "modelo", "cor", "tamanho", "capacidade",
  "descrição", "descricao", "especificações", "especificacoes",
  "avaliações", "avaliacoes", "opinião", "opiniao",
  "frete", "entrega", "garantia", "devolução", "devolucao",
  "parcelamento", "à vista", "a vista",
  // Login/auth texts (OLX, etc)
  "acesse a sua conta", "acesse sua conta", "entre na sua conta",
  "criar conta", "criar uma conta", "cadastro", "login", "entrar",
  "crie sua conta", "acesso à conta", "acesso a conta",
  "access to this page", "access denied", "page denied",
  // Generic site names
  "webmotors", "olx", "mercadolivre", "mercado livre",
  "mercado libre", "mercadolibre",
  // WebMotors homepage/search phrases
  "encontre o carro que você precisa", "encontre o carro que voce precisa",
  "compre carros novos e usados", "encontre seu carro ideal",
  // AliExpress generic
  "aliexpress", "alibaba",
];

function isProductNameValid(name: string): boolean {
  if (!name || name.length < 5) return false;
  const lower = name.toLowerCase().trim();
  // Rejeitar nomes que são labels/filtros
  for (const invalid of INVALID_PRODUCT_NAMES) {
    if (lower === invalid || lower.startsWith(invalid + " ") || lower.startsWith(invalid + ":")) {
      return false;
    }
  }
  // Rejeitar nomes que são preços (ex: "R$ 210.000", "R$8.500")
  if (/^r\$?\s*[\d.,]+$/.test(lower)) {
    return false;
  }
  // Rejeitar nomes muito curtos ou genéricos
  if (lower.split(" ").length < 2 && !/\d/.test(lower)) {
    return false;
  }
  return true;
}

// Detectar URLs de busca (não são páginas de produto)
function isSearchUrl(url: string): boolean {
  return /\/busca\/|\/search\?|\/s\?|q=|search=/i.test(url);
}

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "unknown";
  }
}

interface RawProductData {
  title: string;
  ogTitle?: string;
  ogImage?: string;
  ogPrice?: number;
  metaPrice?: number;
  jsonLdName?: string;
  jsonLdPrice?: number;
  jsonLdImage?: string;
  jsonLdAvailability?: string;
  twitterImage?: string;
  metaName?: string;
  metaImage?: string;
}

function cleanProductName(name: string): string {
  if (!name) return "";
  let n = name.replace(/\s+/g, " ").trim();
  n = n.replace(/\s*[|–—]\s*[A-Za-zÀ-ú0-9&.'" ]{2,40}$/i, "").trim();
  n = n.replace(/\s+[|:]\s+[A-Za-zÀ-ú0-9&.'" ]{2,40}$/i, "").trim();
  return n;
}

// Parse de HTML bruto (server-side, sem browser) — usado pelo FETCH_FALLBACK.
// Extrai nome/preço/foto de múltiplas fontes: JSON-LD, og:, meta itemprop.
// O preço só ganha priceConfirmed=true quando 2+ fontes independentes concordam.
function extractFromRawHtml(html: string): RawProductData {
  const data: RawProductData = { title: "" };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  data.title = cleanProductName(htmlDecode(titleMatch?.[1]?.trim() || ""));

  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogTitle) data.ogTitle = cleanProductName(htmlDecode(ogTitle[1]));

  const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogImage) data.ogImage = ogImage[1];

  const tImage = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (tImage) data.twitterImage = tImage[1];

  const ogPrice = html.match(/<meta[^>]*property=["'](?:og:price:amount|product:price:amount|og:product:price)["'][^>]*content=["']([^"']+)["']/i);
  if (ogPrice) data.ogPrice = parseFloat(htmlDecode(ogPrice[1])) || undefined;

  const metaPrice = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (metaPrice) data.metaPrice = parseFloat(htmlDecode(metaPrice[1])) || undefined;

  const metaName = html.match(/<meta[^>]*itemprop=["']name["'][^>]*content=["']([^"']+)["']/i);
  if (metaName) data.metaName = cleanProductName(htmlDecode(metaName[1]));

  const metaImage = html.match(/<meta[^>]*itemprop=["']image["'][^>]*content=["']([^"']+)["']/i);
  if (metaImage) data.metaImage = metaImage[1];

  // JSON-LD — procura o primeiro @type Product (ou produto dentro de @graph)
  const ldBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const blockRaw of ldBlocks) {
    const block = blockRaw.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(block); } catch { continue; }
    const candidates = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      if (cand["@type"] === "Product" || (Array.isArray(cand["@type"]) && cand["@type"].includes("Product"))) {
        if (!data.jsonLdName && cand.name) data.jsonLdName = cleanProductName(String(cand.name));
        if (!data.jsonLdImage) {
          const img = cand.image;
          if (Array.isArray(img)) {
            const first = img.find((x: any) => typeof x === "string") || (img[0] && img[0].url);
            if (first) data.jsonLdImage = first;
          } else if (typeof img === "string") {
            data.jsonLdImage = img;
          } else if (img && img.url) {
            data.jsonLdImage = img.url;
          }
        }
        const offersData = cand.offers;
        let lowPrice = 0;
        let currency = "";
        let availability = "";
        if (offersData) {
          const offersList = Array.isArray(offersData) ? offersData : [offersData];
          let minPrice = 0;
          for (const o of offersList) {
            const priceRaw = o && (o.price || (o.lowPrice ?? o.highPrice) || (o.priceSpecification && o.priceSpecification.price));
            if (!priceRaw) continue;
            const p = parseFloat(priceRaw);
            if (!isValidPrice(p)) continue;
            if (!minPrice || p < minPrice) minPrice = p;
            if (o.priceCurrency && !currency) currency = o.priceCurrency;
            if (o.availability && !availability) availability = String(o.availability);
          }
          if (minPrice) lowPrice = minPrice;
        }
        if (lowPrice && !data.jsonLdPrice) {
          data.jsonLdPrice = sanitizePrice(lowPrice);
          data.jsonLdAvailability = availability;
        }
        if (data.jsonLdName && (data.jsonLdPrice || lowPrice)) break;
      }
    }
    if (data.jsonLdName) break;
  }

  return data;
}

function htmlDecode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function pickBestName(data: RawProductData): { name: string; source: string } {
  const order: Array<{ v: string | undefined; s: string }> = [
    { v: data.jsonLdName, s: "JSONLD" },
    { v: data.ogTitle, s: "OG" },
    { v: data.metaName, s: "META" },
    { v: data.title, s: "TITLE" },
  ];
  const longest = { v: "", s: "" , len: 0};
  for (const o of order) {
    if (o.v && o.v.length > longest.len) {
      longest.v = o.v;
      longest.s = o.s;
      longest.len = o.v.length;
    }
  }
  return { name: longest.v, source: longest.s };
}

function pickBestImage(data: RawProductData): string | undefined {
  for (const img of [data.jsonLdImage, data.ogImage, data.metaImage, data.twitterImage]) {
    if (img && /^https?:\/\//i.test(img) && !/\.svg(\?|$)/i.test(img)) return img;
  }
  return data.ogImage || data.jsonLdImage || data.metaImage;
}

function parseBrazilianPrice(text: string): number {
  if (!text) return 0;

  if (isScientificNotation(text)) {
    console.warn("[PriceParser] Scientific notation detected, rejecting:", text);
    return 0;
  }

  const cleaned = text.replace(/[^\d.,]/g, "");
  if (!cleaned) return 0;

  const parts = cleaned.split(/[.,]/).filter(p => p);

  if (parts.length === 0) return 0;
  if (parts.length === 1) return sanitizePrice(parseFloat(parts[0]) || 0);

  if (parts.length === 2) {
    const hasCommaDecimal = text.includes(",") && text.lastIndexOf(",") > text.lastIndexOf(".");
    if (hasCommaDecimal || (!text.includes(".") && text.includes(","))) {
      return sanitizePrice(parseFloat(parts[0]) + parseFloat(parts[1]) / 100);
    }
    return sanitizePrice(parseFloat(parts[0] + "." + parts[1]) || 0);
  }

  const intPart = parts.slice(0, -1).join("");
  const decPart = parts[parts.length - 1];
  const result = parseFloat(intPart) + parseFloat(decPart) / 100;
  
  if (!isValidPrice(result)) {
    console.warn("[PriceParser] Invalid price parsed:", result, "from:", text);
    return 0;
  }
  
  return sanitizePrice(result);
}

export interface ScrapeOptions {
  lmStudioUrl?: string;
  nvidiaApiKey?: string;
  geminiApiKey?: string;
  serperApiKey?: string;
  tavilyApiKey?: string;
}

type ScrapeStrategy = {
  name: string;
  fn: () => Promise<ScrapeResult | null>;
};

// FASE 14 — compõe o melhor resultado entre estratégias:
// melhor nome + melhor preço (confirmado/prioridade) + melhor foto.
function mergeResults(partials: ScrapeResult[]): ScrapeResult | null {
  const all = partials.filter((p) => p && typeof p === "object" && isValidPrice(p.price));
  if (all.length === 0) return null;

  // MELHOR NOME
  let bestName = "";
  let bestNameSource = "";
  for (const r of all) {
    const n = (r.name || "").trim();
    if (n.length > bestName.length && n.length >= 5) {
      bestName = n;
      bestNameSource = r.nameSource || r.method || "";
    }
  }

  // MELHOR PREÇO — prioridade: confirmado > STEALTH/NVIDIA/GEMINI > FETCH
  const priceCandidates = [...all].sort((a, b) => {
    const quality = (r: ScrapeResult) => {
      let q = 0;
      if (r.priceConfirmed) q += 4;
      if ((r.method || "").includes("STEALTH")) q += 2;
      if ((r.method || "").includes("NVIDIA")) q += 1;
      if ((r.method || "").includes("GEMINI")) q += 1;
      if ((r.method || "").includes("FETCH")) q -= 2;
      return q;
    };
    return quality(b) - quality(a);
  });
  const priceSrc = priceCandidates.find((r) => r.available !== false) || priceCandidates[0];

  // MELHOR FOTO
  let bestImage: string | undefined;
  for (const r of all) {
    if (!r.imageUrl) continue;
    if (/^https?:\/\//i.test(r.imageUrl) && !/\.svg(\?|$)/i.test(r.imageUrl)) {
      bestImage = r.imageUrl;
      break;
    }
  }

  const method = priceSrc.method
    ? `MERGED_${priceSrc.method}${bestNameSource ? `+${bestNameSource}` : ""}`
    : `MERGED+${bestNameSource}`;

  return {
    name: bestName || priceSrc.name || "",
    price: priceSrc.price,
    currency: "BRL",
    available: priceSrc.available !== false,
    imageUrl: bestImage || priceSrc.imageUrl,
    method,
    priceConfirmed: priceSrc.priceConfirmed,
    nameSource: bestNameSource,
  };
}

export async function advancedScrape(rawUrl: string, options: ScrapeOptions): Promise<ScrapeResult> {
  // Normalizar URL: adicionar https:// se ausente
  const url = (() => {
    let u = rawUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      u = "https://" + u;
    }
    return u;
  })();
  // Usar URL completa como chave do cache
  const urlHash = simpleHash(url);
  const cacheFile = path.join(CACHE_DIR, `${urlHash}.json`);

  // Verificar cache com expiração de 30 minutos (FASE 14)
  if (fs.existsSync(cacheFile)) {
    const stats = fs.statSync(cacheFile);
    const cacheAge = Date.now() - stats.mtimeMs;
    const MAX_CACHE_AGE = 30 * 60 * 1000;

    if (cacheAge < MAX_CACHE_AGE) {
      console.log(`[Scraper] Cache hit (${Math.round(cacheAge/1000)}s old): ${url.substring(0, 60)}...`);
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as ScrapeResult;

      // Validar cache: deve ter preço E nome válidos E realistas
      if (cached && cached.price && cached.price > 0 && cached.name && cached.name.length > 5
          && isProductNameValid(cached.name) && isPriceRealistic(cached.price, cached.name)) {
        console.log(`[Scraper] Using cached data: "${cached.name?.substring(0, 30)}" - R$ ${cached.price}`);
        return cached;
      } else {
        console.log(`[Scraper] Cache invalid (missing price or name), removing...`);
        fs.unlinkSync(cacheFile);
      }
    } else {
      console.log(`[Scraper] Cache expired (${Math.round(cacheAge/1000/60)}min old), removing...`);
      fs.unlinkSync(cacheFile);
    }
  }

  console.log(`[Scraper] Starting fresh scrape for: ${url.substring(0, 80)}...`);
  console.log(`[Scraper] Options available:`);
  console.log(`  - LMStudio: ${options.lmStudioUrl ? "YES" : "NO"}`);
  console.log(`  - NVIDIA: ${options.nvidiaApiKey ? "YES" : "NO"}`);
  console.log(`  - Gemini: ${options.geminiApiKey ? "YES" : "NO"}`);
  console.log(`  - Serper: ${options.serperApiKey ? "YES" : "NO"}`);
  console.log(`  - Tavily: ${options.tavilyApiKey ? "YES" : "NO"}`);

  const strategies: ScrapeStrategy[] = [];

  // Circuit breaker por domínio (FASE 3): se a loja está caindo/bloqueando,
  // pula as estratégias Playwright (caras) e só tenta as baratas.
  const domain = getDomain(url);
  const circuitOpen = scraperBreaker.isOpen(domain);
  if (circuitOpen) {
    console.log(`[Scraper] ⏸ Circuit OPEN for ${domain} — pulando estratégias Playwright`);
  }

  if (!circuitOpen) {
    // 1. Playwright stealth (handler + genérico)
    strategies.push({ name: "PLAYWRIGHT_STEALTH", fn: () => scrapeWithPlaywrightStealth(url, options) });

    // 2. LM Studio (se configurado) - Vision e Text (LOCAL = RÁPIDO)
    if (options.lmStudioUrl) {
      let lmStudioAvailable = false;
      try {
        const lmStudioCheck = await fetch(`${options.lmStudioUrl}/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000)
        });
        if (lmStudioCheck.ok) {
          lmStudioAvailable = true;
          console.log("[Scraper] LM Studio is available, adding strategies");
        } else {
          console.log("[Scraper] LM Studio responded but not OK, skipping");
        }
      } catch (e) {
        console.log("[Scraper] LM Studio not responding, skipping LM Studio strategies");
      }

      if (lmStudioAvailable) {
        strategies.push(
          { name: "PLAYWRIGHT_LM_STUDIO_VISION", fn: () => scrapeWithPlaywrightLLMLocal(url, options, true) },
          { name: "PLAYWRIGHT_LM_STUDIO_TEXT", fn: () => scrapeWithPlaywrightLLMLocal(url, options, false) }
        );
      }
    }

    // 3a. Fallback Playwright (sem IA)
    strategies.push(
      { name: "PLAYWRIGHT_BASIC", fn: () => scrapeWithPlaywrightBasic(url, options) }
    );

    // 3b. NVIDIA NIM (extração LLM sobre o corpo da página)
    if (options.nvidiaApiKey) {
      strategies.push({ name: "NVIDIA_NIM", fn: () => scrapeWithNvidiaNim(url, options.nvidiaApiKey!) });
    }

    // 3c. GEMINI_VISION: screenshot + visão (quando o HTML é ilegível)
    if (options.geminiApiKey) {
      strategies.push({ name: "GEMINI_VISION", fn: () => scrapeWithGeminiVision(url, options.geminiApiKey!) });
    }

    // 4. SEARCH_VERIFY: snippet de busca (Serper/Tavily) + NVIDIA/Gemini
    if ((options.serperApiKey || options.tavilyApiKey) && (options.geminiApiKey || options.nvidiaApiKey)) {
      strategies.push({
        name: "SEARCH_VERIFY",
        fn: () => scrapeWithSearchVerify(url, (mergeResults(partials)?.name || ""), options),
      });
    }

    // 5. Gemini como ÚLTIMO recurso (grounding via urlContext) — fora do circuit
  }

  // 4b. FETCH_FALLBACK é barato (sem browser) — sempre tentado
  strategies.push({ name: "FETCH_FALLBACK", fn: () => scrapeWithFetch(url) });

  // 5. Gemini grounding (apenas se configurado) — sempre tentado
  if (options.geminiApiKey) {
    strategies.push({ name: "GEMINI_FALLBACK", fn: () => scrapeWithGemini(url, "", options.geminiApiKey!) });
  }

  console.log(`[Scraper] Total strategies: ${strategies.length}`);
  console.log(`[Scraper] Strategy order: ${strategies.map(s => s.name).join(" -> ")}`);

  const partials: ScrapeResult[] = [];

  for (const strategy of strategies) {
    let strategyBrowser: any = null;
    try {
      console.log(`[Scraper] ========== Trying strategy: ${strategy.name} ==========`);

      const strategyPromise = (async () => {
        const res = await strategy.fn();
        return res;
      })();

      const timeoutPromise = new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('Strategy timeout (90s)')), 90000);
      });

      const result = await Promise.race([
        strategyPromise,
        timeoutPromise
      ]) as ScrapeResult | null;

      if (result && isValidPrice(result.price)) {
        result.price = sanitizePrice(result.price);
        result.method = strategy.name;
        result.name = result.name || "";
        partials.push(result);

        const merged = mergeResults(partials);
        if (!merged) continue;

        console.log(`[Scraper] Merged so far: price=${merged.price}, name="${merged.name?.substring(0, 50)}", img=${merged.imageUrl ? "yes" : "no"} (confirmed=${!!merged.priceConfirmed})`);

        if (merged.name.length > 5 && isProductNameValid(merged.name) && isPriceRealistic(merged.price, merged.name)) {
          console.log(`[Scraper] ✓ SUCCESS (${strategy.name}, merged): price=${merged.price}, name="${merged.name?.substring(0, 50)}"`);

          fs.writeFileSync(cacheFile, JSON.stringify(merged));
          scraperBreaker.recordSuccess(domain);
          if (circuitOpen) {
            console.log(`[Scraper] ✅ Circuit CLOSED for ${domain} (probe ok)`);
          }
          return merged;
        } else if (merged.name.length <= 5 || !isProductNameValid(merged.name)) {
          console.log(`[Scraper] ✗ Strategy ${strategy.name} returned invalid/weak name:`, JSON.stringify(merged.name));
        } else {
          console.log(`[Scraper] ⚠️ Merged price R$ ${merged.price} seems unrealistic for "${merged.name.substring(0, 40)}"`);
        }
      } else {
        console.log(`[Scraper] ✗ Strategy ${strategy.name} returned invalid data:`, result);
      }
    } catch (error: any) {
      console.error(`[Scraper] ✗ Strategy ${strategy.name} failed:`, error.message || error);
      console.error(`[Scraper] Error stack:`, error.stack?.split("\n").slice(0, 3).join("\n"));
    }
  }

  // Se todas as estratégias falharam mas temos um resultado composto válido (nome ok)
  const mergedFinal = mergeResults(partials);
  if (mergedFinal && mergedFinal.name && mergedFinal.name.length > 5 && isProductNameValid(mergedFinal.name)) {
    console.log(`[Scraper] ⚠️ Using best available merged result: R$ ${mergedFinal.price} — "${mergedFinal.name.substring(0, 50)}" (${mergedFinal.method})`);
    fs.writeFileSync(cacheFile, JSON.stringify(mergedFinal));
    return mergedFinal;
  }

  console.error("[Scraper] ✗✗✗ All strategies failed ✗✗✗");
  console.error("[Scraper] Strategies attempted:", strategies.map(s => s.name).join(", "));
  console.error("[Scraper] URL:", url);
  scraperBreaker.recordFailure(domain);
  throw new Error(`Failed to scrape product data from all strategies (tried: ${strategies.map(s => s.name).join(", ")})`);
}
async function scrapeWithLLMLocal(
	page: any,
	lmStudioUrl: string,
	useVision: boolean
): Promise<Partial<ScrapeResult> | null> {
	const model = await detectLMStudioModel(lmStudioUrl);
	console.log(`[LLM Local] Using model: ${model}`);

  try {
const client = new OpenAI({
		baseURL: lmStudioUrl,
		apiKey: "lm-studio",
	});

	// Reduzir tamanho do texto para evitar exceder contexto
	const bodyText = await page.evaluate(`document.body.innerText.slice(0, 1500)`);

	let messages: any[];

if (useVision) {
		console.log("[LLM Local] Taking screenshot for vision model...");
		const screenshot = await page.screenshot({ encoding: "base64" });

		messages = [
			{
				role: "system",
				content: "Você é um extrator de preços. Retorne APENAS um JSON válido sem markdown, sem explicação, sem texto adicional. Formato: {\"name\":\"Produto\",\"price\":1234.56}",
			},
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: {
							url: `data:image/png;base64,${screenshot}`,
						},
					},
					{
						type: "text",
						text: `Qual o menor preço (Pix/Boleto/à vista)? Retorne JSON: {"name":"nome","price":999.99}`,
					},
				],
			},
		];
	} else {
		messages = [
			{
				role: "system",
				content: "Retorne APENAS JSON válido. Sem markdown. Sem explicação. Formato: {\"name\":\"Produto\",\"price\":1234.56}",
			},
			{
				role: "user",
				content: `Extraia nome e menor preço (Pix/Boleto/à vista) deste texto:

${bodyText}

JSON:`,
			},
		];
	}

	console.log(`[LLM Local] Sending request to ${model}...`);
	const response = await client.chat.completions.create({
		model: model,
		messages: messages,
		max_tokens: 300,
		temperature: 0,
	});

	const resultText = response.choices[0].message?.content || "";
	console.log(`[LLM Local] Raw response: ${resultText.substring(0, 300)}`);

	// Tentar extrair JSON da resposta
	let jsonMatch = resultText.match(/\{[\s\S]*\}/);
	
	if (!jsonMatch) {
		// Se não encontrou JSON, tentar extrair preço diretamente
		const priceMatch = resultText.match(/R?\$?\s*[\d.,]+/);
		if (priceMatch) {
			const priceStr = priceMatch[0].replace(/R\$\s?/g, '').replace(/\./g, '').replace(',', '.');
			const price = parseFloat(priceStr);
			if (!isNaN(price) && price > 10 && price < 100000) {
				console.log(`[LLM Local] Extracted price from text: R$ ${price}`);
				return {
					name: "",
					price: price,
					currency: "BRL",
					available: true,
				};
			}
		}
		console.log("[LLM Local] No JSON or valid price found in response");
		return null;
	}

	// Limpar JSON antes de parsear
	let jsonStr = jsonMatch[0];
	// Remover markdown code blocks se houver
	jsonStr = jsonStr.replace(/```json?\s*/gi, '').replace(/```\s*/g, '');
	// Remover vírgulas trailing
	jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
	
	let result;
	try {
		result = JSON.parse(jsonStr);
	} catch (e) {
		console.log("[LLM Local] Failed to parse JSON:", e);
		// Tentar extrair preço do JSON malformado
		const priceMatch = jsonStr.match(/price["\s:]+(\d+[.,]?\d*)/i);
		if (priceMatch) {
			const price = parseFloat(priceMatch[1].replace(',', '.'));
			if (!isNaN(price) && price > 10) {
				return {
					name: "",
					price: price,
					currency: "BRL",
					available: true,
				};
			}
		}
		return null;
	}

if (isValidPrice(result.price)) {
		result.price = sanitizePrice(result.price);
		result.name = result.name || "";
		console.log(`[LLM Local - ${model}] SUCCESS: "${result.name?.substring(0, 30)}" - R$ ${result.price}`);
		return {
			...result,
			currency: result.currency || "BRL",
		};
	}

    console.log("[LLM Local] Invalid result:", result);
    return null;
  } catch (error: any) {
    console.error(`[LLM Local - ${model}] Error:`, error.message || error);
    return null;
  }
}

async function scrapeWithPlaywrightLLMLocal(
  url: string,
  options: any,
  requestVision: boolean
): Promise<ScrapeResult | null> {
  if (!options.lmStudioUrl) {
    console.log("[Playwright + LLM Local] No lmStudioUrl configured, skipping");
    return null;
  }

  console.log("[Playwright + LM Studio] Starting...");
  console.log("[Playwright + LM Studio] URL:", url);

  const detectedModel = await detectLMStudioModel(options.lmStudioUrl);
  const modelSupportsVision = isVisionModel(detectedModel);
  const useVision = requestVision && modelSupportsVision;

  if (requestVision && !modelSupportsVision) {
    console.log(`[Playwright + LM Studio] Model ${detectedModel} does not support vision, using text mode`);
  }

  console.log(`[Playwright + LM Studio] Model: ${detectedModel} (${useVision ? 'vision' : 'text'})`);

  const domain = getDomain(url);
  const userAgent = getRandomUserAgent();
  const cookieFile = path.join(COOKIE_DIR, `${domain.replace(/\./g, "_")}.json`);

  let browser;
  try {
    console.log("[Playwright + LM Studio] Launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });

    console.log("[Playwright + LM Studio] Creating context...");
    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      extraHTTPHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    });

    if (fs.existsSync(cookieFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
        await context.addCookies(cookies);
        console.log(`[Playwright + LM Studio] Loaded saved cookies`);
      } catch (e) {}
    }

    const page = await context.newPage();

    await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", function(route) { route.abort(); });
    await page.route("**/analytics/**", function(route) { route.abort(); });
    await page.route("**/tracking/**", function(route) { route.abort(); });

    console.log(`[Playwright + LM Studio] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log(`[Playwright + LM Studio] Page loaded`);

    await page.waitForFunction(`
      (function() {
        var body = document.body.innerText;
        return body.indexOf("R$") !== -1 || /\\d{1,3}[.,]\\d{2}/.test(body);
      })()
    `, { timeout: 15000 }).catch(function() {
      console.log(`[Playwright + LM Studio] Price wait timeout, continuing anyway`);
    });

    await page.waitForTimeout(3000);

    console.log(`[Playwright + LM Studio] Scrolling...`);
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight / 2)`);
    await page.waitForTimeout(2000);

const storeHandler = getStoreHandler(url);
    if (storeHandler) {
      console.log(`[Playwright + LM Studio] Trying store handler first...`);
      try {
        const handlerResult = await storeHandler(page);
        console.log(`[Playwright + LM Studio] Handler result:`, JSON.stringify(handlerResult));
        if (handlerResult.name && handlerResult.price && handlerResult.price > 0) {
          console.log(`[Playwright + LM Studio] Store handler succeeded`);
          
          try {
            const cookies = await context.cookies();
            fs.writeFileSync(cookieFile, JSON.stringify(cookies));
          } catch (e) {}

          await browser.close();
          return handlerResult as ScrapeResult;
        }
      } catch (e) {
        console.log(`[Playwright + LM Studio] Store handler failed, using LLM`);
      }
    }

	console.log(`[Playwright + LM Studio] Processing with LLM...`);
	const llmResult = await scrapeWithLLMLocal(page, options.lmStudioUrl, useVision);

	if (llmResult && llmResult.price > 0) {
		try {
			const cookies = await context.cookies();
			fs.writeFileSync(cookieFile, JSON.stringify(cookies));
		} catch (e) {}

		await browser.close();
		return llmResult as ScrapeResult;
	}

	await browser.close();
	return null;
	} catch (error) {
		console.error(`[Playwright + LM Studio] Error:`, error);
		if (browser) await browser.close().catch(function() {});
		return null;
	}
}

async function scrapeWithPlaywrightStealth(url: string, options: any): Promise<ScrapeResult | null> {
  const domain = getDomain(url);
  const cookieDomain = domain.includes("aliexpress") ? "aliexpress.com" : domain;
  const userAgent = getRandomUserAgent();
  const cookieFile = path.join(COOKIE_DIR, `${cookieDomain.replace(/\./g, "_")}.json`);

  console.log(`[Playwright] UA: ${userAgent.substring(0, 50)}...`);
  console.log(`[Playwright] Domain: ${domain}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
      ],
    });

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      extraHTTPHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    if (fs.existsSync(cookieFile)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf-8"));
        await context.addCookies(cookies);
        console.log("[Playwright] Loaded saved cookies");
      } catch (e) {
        console.log("[Playwright] Failed to load cookies, continuing without");
      }
    }

    const page = await context.newPage();

await page.route("**/*.{woff,woff2,ttf,otf}", function(route) { route.abort(); });
		await page.route("**/analytics/**", function(route) { route.abort(); });
		await page.route("**/tracking/**", function(route) { route.abort(); });
		await page.route("**/ads/**", function(route) { route.abort(); });
    if (!domain.includes("aliexpress")) {
      await page.route("**/*.{png,jpg,jpeg,gif,webp,svg}", function(route) { route.abort(); });
    }

    console.log("[Playwright] Navigating to URL...");
    const isAliExpress = domain.includes("aliexpress");
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: isAliExpress ? 60000 : 45000,
    });

    if (response?.status() === 403) {
      console.warn("[Playwright] Got 403 Forbidden, trying alternative approach");
    }

    const content = await page.content();
    if (content.includes("Access Denied") || content.includes("Cloudflare")) {
      console.warn("[Playwright] Bot detection detected");
    }

	console.log("[Playwright] Waiting for price content...");
	await page.waitForFunction(`
		(function() {
			var body = document.body.innerText;
			return body.indexOf("R$") !== -1 || body.indexOf("R$ ") !== -1 || /\\d{1,3}[.,]\\d{2}/.test(body);
		})()
	`, { timeout: 10000 }).catch(function() {
		console.log("[Playwright] Price wait timeout, continuing anyway");
	});

await page.waitForTimeout(2000);

	console.log("[Playwright] Scrolling to trigger lazy content...");
	await page.evaluate(`
		(function() {
			return new Promise(function(resolve) {
				var totalHeight = 0;
				var distance = 150;
				var timer = setInterval(function() {
					var scrollHeight = document.body.scrollHeight;
					window.scrollBy(0, distance);
					totalHeight += distance;
					if (totalHeight >= scrollHeight * 0.4) {
						clearInterval(timer);
						resolve(undefined);
					}
				}, 100);
			});
		})()
	`);
	await page.waitForTimeout(1500);

	await page.evaluate(`window.scrollTo(0, 0);`);

  let result: Partial<ScrapeResult> = {};

  // Always try store handler first if available
  const storeHandler = getStoreHandler(url);
  if (storeHandler) {
    console.log("[Playwright] Using store-specific handler for:", domain);
    try {
      result = await Promise.race([
        storeHandler(page),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Handler timeout (60s)")), 60000))
      ]);
      console.log("[Playwright] Handler returned:", JSON.stringify({ name: (result.name || "").substring(0, 50), price: result.price }));
      if (!result.name || !result.price || result.price <= 0) {
        console.log("[Playwright] Handler returned invalid data, falling back to generic");
        result = {};
      }
    } catch (e: any) {
      console.log("[Playwright] Store handler error:", e.message || e);
      result = {};
    }
  } else {
    console.log("[Playwright] No store handler for", domain);
  }

  // Generic extraction as fallback if handler didn't get results
  if (!result.name || !result.price || result.price <= 0) {
    console.log("[Playwright] Using generic extraction");
    result = await genericPageExtraction(page);
  }

	if (!result.name || !result.price || result.price <= 0) {
		console.log("[Playwright] No valid data extracted");
		await browser.close();
		return null;
	}

    if (result.name && result.price) {
      try {
        const cookies = await context.cookies();
        fs.writeFileSync(cookieFile, JSON.stringify(cookies));
        console.log("[Playwright] Saved cookies for future use");
      } catch (e) {
        console.log("[Playwright] Failed to save cookies");
      }
    }

    await browser.close();
    browser = null;

    return result as ScrapeResult;
  } catch (error) {
    console.error("[Playwright] Error:", error);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return null;
  }
}

async function genericPageExtraction(page: any): Promise<Partial<ScrapeResult>> {
	const evaluateCode = `
(function() {
	var body = document.body ? document.body.innerText : "";
	var bodyLower = body ? body.toLowerCase() : "";

	function parseBrazilianPrice(text) {
		if (!text) return 0;
		text = text.replace(/R\\$\\s?/gi, '').trim();
		if (/[eE][+-]?\\d+/i.test(text)) return 0;
		text = text.replace(/\\.(?=\\d{3})/g, '').replace(',', '.');
		var price = parseFloat(text);
		return isNaN(price) ? 0 : price;
	}

	function isValidPrice(p) {
		return p >= 10 && p <= 5000000 && Number.isFinite(p);
	}

	function cleanName(n) {
		if (!n) return "";
		n = n.replace(/\\s+/g, ' ').trim();
		n = n.replace(/\\s*[|–—]\\s*[^|–—]{2,40}$/i, '').trim();
		n = n.replace(/\\s*\\|\\s*[A-Za-zÀ-ú0-9&.'" ]{2,30}$/i, '').trim();
		return n;
	}

	// ---- JSON-LD ----
	var jsonLdName = "", jsonLdPrice = 0, jsonLdImage = "", jsonLdAvail = "";
	var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
	for (var li = 0; li < ldScripts.length; li++) {
		try {
			var ld = JSON.parse(ldScripts[li].textContent || "{}");
			var cands = Array.isArray(ld) ? ld : (ld['@graph'] || [ld]);
			for (var ci = 0; ci < cands.length; ci++) {
				var c = cands[ci];
				if (!c || typeof c !== 'object' || c['@type'] !== 'Product') continue;
				if (!jsonLdName && c.name) jsonLdName = cleanName(c.name);
				var img = c.image;
				if (!jsonLdImage) {
					if (Array.isArray(img)) {
						for (var ii = 0; ii < img.length; ii++) {
							if (typeof img[ii] === 'string') { jsonLdImage = img[ii]; break; }
							if (img[ii] && img[ii].url) { jsonLdImage = img[ii].url; break; }
						}
					} else if (typeof img === 'string') jsonLdImage = img;
					else if (img && img.url) jsonLdImage = img.url;
				}
				var offers = c.offers;
				if (offers && !jsonLdPrice) {
					var list = Array.isArray(offers) ? offers : [offers];
					var minP = 0;
					for (var oi = 0; oi < list.length; oi++) {
						var o = list[oi];
						var pr = o && (o.price || (o.lowPrice != null ? o.lowPrice : (o.highPrice != null ? o.highPrice : (o.priceSpecification && o.priceSpecification.price))));
						var pp = parseFloat(pr);
						if (!isNaN(pp) && isValidPrice(pp)) {
							if (!minP || pp < minP) minP = pp;
						}
						if (o && o.availability && !jsonLdAvail) jsonLdAvail = String(o.availability);
					}
					if (minP) jsonLdPrice = Math.round(minP * 100) / 100;
				}
				if (jsonLdName && jsonLdPrice) break;
			}
			if (jsonLdName) break;
		} catch (e) { continue; }
	}

	// ---- og / meta ----
	function metaContent(selectors) {
		for (var i = 0; i < selectors.length; i++) {
			var el = document.querySelector(selectors[i]);
			if (el) {
				var v = el.getAttribute("content");
				if (v && v.trim()) return v.trim();
			}
		}
		return "";
	}
	var ogTitle = cleanName(metaContent(['meta[property="og:title"]', 'meta[name="twitter:title"]']));
	var metaName = cleanName(metaContent(['meta[itemprop="name"]']));
	var ogPriceText = metaContent(['meta[property="og:price:amount"]', 'meta[property="product:price:amount"]', 'meta[itemprop="price"]']);
	var ogPrice = parseFloat((ogPriceText || "").replace(',', '.'));
	if (isNaN(ogPrice)) ogPrice = 0;
	var ogImage = metaContent(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[itemprop="image"]']);

	// ---- Nome ----
	var name = jsonLdName || ogTitle || metaName || "";
	var nameSource = jsonLdName ? "JSONLD" : (ogTitle ? "OG" : (metaName ? "META" : ""));
	if (!name) {
		var h1 = document.querySelector("h1");
		if (h1 && h1.textContent && h1.textContent.trim()) name = cleanName(h1.textContent);
		else {
			var titleEl = document.querySelector("title");
			if (titleEl && titleEl.textContent) name = cleanName(titleEl.textContent);
		}
		if (!nameSource) nameSource = h1 ? "H1" : "TITLE";
	}

	// ---- Preço ----
	var priceSelectors = [
		'[itemprop="price"]:not(meta)',
		'[class*="price"]',
		'[data-price]',
		'.product-price',
		'#price',
		'.price',
		'.preco'
	];
	var domCandidates = [];
	for (var i = 0; i < priceSelectors.length; i++) {
		var els = document.querySelectorAll(priceSelectors[i]);
		for (var e2 = 0; e2 < els.length; e2++) {
			var el = els[e2];
			if (el.closest && (el.closest("s") || el.closest("del"))) continue;
			var txt = el.textContent || "";
			if (/[eE][+-]?\\d+/i.test(txt)) continue;
			if (/\\d+\\s*x\\s*(de\\s*)?/i.test(txt)) continue;
			var parsed = parseBrazilianPrice(txt);
			if (isValidPrice(parsed) && domCandidates.indexOf(parsed) === -1) domCandidates.push(parsed);
		}
	}
	var domPrice = 0;
	if (domCandidates.length > 0) domPrice = Math.min.apply(null, domCandidates);

	function nearNamePrices() {
		var idx = body.indexOf(name);
		if (idx < 0) return [];
		var start = Math.max(0, idx - 1200);
		var end = Math.min(body.length, idx + 1800);
		var region = body.slice(start, end);
		var res = [];
		var porRes = [];
		var re = /R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}/gi;
		var nm;
		while ((nm = re.exec(region))) {
			var before = region.substring(Math.max(0, nm.index - 30), nm.index);
			if (/x\\s*de\\s*r\\$/i.test(before) || /x\\s*r\\$/i.test(before) || /(\\d)\\s*x\\s*$/i.test(before)) continue;
			var p = parseBrazilianPrice(nm[0]);
			if (isValidPrice(p)) {
				if (/\\bpor\\b/i.test(before) || /\\bsó\\b/i.test(before) || /\\bvista\\b/i.test(before)) porRes.push(p);
				else res.push(p);
			}
		}
		res.sort(function(a, b) { return a - b; });
		porRes.sort(function(a, b) { return a - b; });
		return porRes.concat(res);
	}

	var price = 0;
	var confirmed = false;
	var usedSource = "";

	// 1) JSON-LD (estruturado) — confiável; confirmado se DOM/og concordar
	if (jsonLdPrice && isValidPrice(jsonLdPrice)) {
		price = jsonLdPrice;
		usedSource = "JSONLD";
		if (domPrice && Math.abs(domPrice - jsonLdPrice) <= jsonLdPrice * 0.02) confirmed = true;
		else if (ogPrice && Math.abs(ogPrice - jsonLdPrice) <= jsonLdPrice * 0.02) { confirmed = true; price = jsonLdPrice; }
	}
	// 2) Confirmação DOM + og/meta
	if (!isValidPrice(price)) {
		if (domPrice && ogPrice && Math.abs(domPrice - ogPrice) <= ogPrice * 0.02) {
			price = Math.min(domPrice, ogPrice);
			confirmed = true;
			usedSource = "DOM_CONFIRMED";
		}
	}
	// 3) DOM sozinho
	if (!isValidPrice(price) && domPrice) { price = domPrice; usedSource = "DOM"; }
	// 4) preços próximos ao nome
	if (!isValidPrice(price)) {
		var near = nearNamePrices();
		if (near.length > 0) { price = near[0]; usedSource = "NEAR_NAME"; }
	}
	// 5) last resort: por/só > frequência > menor (exclui parcelas)
	if (!isValidPrice(price)) {
		var allPrices = [];
		var bodyScan = /R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}/gi;
		var bsm;
		while ((bsm = bodyScan.exec(body))) {
			var ctx = body.substring(Math.max(0, bsm.index - 30), bsm.index);
			if (/x\\s*de\\s*r\\$/i.test(ctx) || /x\\s*r\\$/i.test(ctx) || /(\\d)\\s*x\\s*$/i.test(ctx)) continue;
			var pp = parseBrazilianPrice(bsm[0]);
			if (isValidPrice(pp)) allPrices.push(pp);
		}
		var porPrices = [];
		var bodyLines = body.split(/\\n/);
		for (var li2 = 0; li2 < bodyLines.length; li2++) {
			var line = bodyLines[li2];
			if ((/\\bpor\\b/i.test(line) || /\\bvista\\b/i.test(line) || /\\bsó\\b/i.test(line)) && /\\$/.test(line)) {
				var lx = /R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}/gi;
				var lm2;
				while ((lm2 = lx.exec(line))) {
					var lctx = line.substring(Math.max(0, lm2.index - 30), lm2.index);
					if (/x\\s*de\\s*r\\$/i.test(lctx) || /x\\s*r\\$/i.test(lctx) || /(\\d)\\s*x\\s*$/i.test(lctx)) continue;
					var lp = parseBrazilianPrice(lm2[0]);
					if (isValidPrice(lp)) porPrices.push(lp);
				}
			}
		}
		if (porPrices.length > 0) price = Math.min.apply(null, porPrices);
		else if (allPrices.length > 0) {
			var freqMap = {};
			for (var fi = 0; fi < allPrices.length; fi++) freqMap[allPrices[fi]] = (freqMap[allPrices[fi]] || 0) + 1;
			var bestP = allPrices[0], bestF = 0;
			for (var fi2 = 0; fi2 < allPrices.length; fi2++) if ((freqMap[allPrices[fi2]] || 0) > bestF) { bestF = freqMap[allPrices[fi2]]; bestP = allPrices[fi2]; }
			price = bestF > 1 ? bestP : Math.min.apply(null, allPrices);
		}
		if (!usedSource) usedSource = "FREQ";
	}

	price = Math.round(price * 100) / 100;

	// ---- Foto ----
	var imageUrl = jsonLdImage || ogImage || undefined;
	if (!imageUrl) {
		var imageEl = document.querySelector("img[class*='product']") ||
			document.querySelector("img[class*='Product']") ||
			document.querySelector("img[itemprop='image']") ||
			document.querySelector("#product-gallery img") ||
			document.querySelector("img[class*='main']");
		if (imageEl) imageUrl = imageEl.getAttribute("src") || imageEl.getAttribute("data-src") || undefined;
	}
	if (imageUrl && imageUrl.indexOf("//") === 0 && window.location) imageUrl = window.location.protocol + imageUrl;

	// ---- Disponível ----
	var unavailableKeywords = ["esgotado", "indisponível", "sem estoque", "fora de estoque", "sold out", "unavailable"];
	var available = true;
	if (jsonLdAvail && jsonLdAvail.indexOf("OutOfStock") !== -1) available = false;
	for (var ki = 0; ki < unavailableKeywords.length; ki++) {
		if (bodyLower.indexOf(unavailableKeywords[ki]) !== -1) { available = false; break; }
	}

	return { name: name, price: price, currency: "BRL", available: available, imageUrl: imageUrl, nameSource: nameSource, priceConfirmed: confirmed };
})()
	`;
	const data = await page.evaluate(evaluateCode) as ScrapeResult;

  var namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
  console.log(`[Generic] Extracted: name="${namePreview}" (${data.nameSource || "?"}), price=${data.price}${data.priceConfirmed ? " (confirmed)" : ""}, img=${data.imageUrl ? "yes" : "no"}`);
  return data;
}
async function scrapeWithPlaywrightBasic(url: string, options: any): Promise<ScrapeResult | null> {
  const userAgent = getRandomUserAgent();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      userAgent,
      viewport: { width: 1280, height: 800 },
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const result = await genericPageExtraction(page);
    await browser.close();

    return result as ScrapeResult;
  } catch (error) {
    if (browser) await browser.close().catch(function() {});
    return null;
  }
}

async function scrapeWithFetch(url: string): Promise<ScrapeResult | null> {
  try {
    const userAgent = getRandomUserAgent();
    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      console.log(`[Fetch] HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    const data = extractFromRawHtml(html);

    const { name, source } = pickBestName(data);
    if (!name) return null;

    // Preço: JSON-LD é a fonte mais confiável. Meta/og confirmam (dupla fonte).
    let price = data.jsonLdPrice || data.metaPrice || data.ogPrice || 0;
    let confirmed = false;
    const sources: number[] = [];
    if (data.jsonLdPrice) sources.push(data.jsonLdPrice);
    if (data.metaPrice) sources.push(data.metaPrice);
    if (data.ogPrice) sources.push(data.ogPrice);
    if (sources.length >= 2) {
      const min = Math.min(...sources);
      const max = Math.max(...sources);
      if (max - min <= max * 0.02 || min === max) {
        price = min;
        confirmed = true;
      } else {
        price = data.jsonLdPrice || data.metaPrice || 0;
      }
    }

    if (!isValidPrice(price)) {
      // Último recurso: preços do body (menor válido), sem confirmação
      const priceMatches = html.match(/R?\$?\s*[\d.,]+/gi) || [];
      const prices = priceMatches.map((m) => parseBrazilianPrice(m)).filter(isValidPrice);
      if (prices.length > 0) price = Math.min(...prices);
    }

    console.log(`[Fetch] name="${name.substring(0, 50)}", price=${price}${confirmed ? " (confirmed)" : ""}, img=${data.ogImage ? "yes" : "no"}`);

    return {
      name,
      price: sanitizePrice(price),
      currency: "BRL",
      available: price > 0,
      imageUrl: pickBestImage(data),
      nameSource: source,
      priceConfirmed: confirmed,
    };
  } catch (error) {
    console.error("[Fetch] Error:", error);
    return null;
  }
}

async function scrapeWithNvidiaNim(url: string, apiKey: string): Promise<ScrapeResult | null> {
  console.log("[NVIDIA NIM] Starting scrape...");
  console.log("[NVIDIA NIM] URL:", url);
  
  let browser;
  try {
    console.log("[NVIDIA NIM] Launching browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    console.log("[NVIDIA NIM] Browser launched, creating context...");
    const context = await browser.newContext({
      userAgent: getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    console.log("[NVIDIA NIM] Navigating to URL...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("[NVIDIA NIM] Page loaded, waiting for content...");
    await page.waitForTimeout(3000);

    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight / 2)`);
    await page.waitForTimeout(2000);

    console.log("[NVIDIA NIM] Extracting body text...");
    const bodyText = await page.evaluate(`document.body.innerText.slice(0, 1500)`);
    console.log("[NVIDIA NIM] Body text length:", bodyText.length);

    await browser.close();
    browser = null;

    if (!bodyText || bodyText.length < 50) {
      console.log("[NVIDIA NIM] Body text too short, aborting");
      return null;
    }

    console.log("[NVIDIA NIM] Calling NVIDIA NIM API...");
    const client = new OpenAI({
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: apiKey,
    });

    const models = [NVIDIA_EXTRACT_MODEL, NVIDIA_FALLBACK_MODEL];
    for (const model of models) {
      for (let attempt = 1; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
        try {
          console.log(`[NVIDIA NIM] Calling API (model=${model}, attempt=${attempt}/${NVIDIA_MAX_RETRIES})...`);
          const response = await client.chat.completions.create({
            model,
            messages: [
              {
                role: "system",
                content: "Extraia dados do produto. Retorne APENAS JSON válido. Sem markdown. Formato: {\"name\":\"Produto\",\"price\":1234.56}",
              },
              {
                role: "user",
                content: `Extraia nome e menor preço (Pix/Boleto/à vista) deste texto:\n\n${bodyText}\n\nJSON:`,
              },
            ],
            max_tokens: 300,
            temperature: 0,
          });

          const resultText = response.choices[0].message?.content || "";
          console.log(`[NVIDIA NIM] Raw response: ${resultText.substring(0, 200)}`);

          const jsonMatch = resultText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            let jsonStr = jsonMatch[0].replace(/```json?\s*/gi, "").replace(/```\s*/g, "");
            jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");

            try {
              const result = JSON.parse(jsonStr);
              if (isValidPrice(result.price)) {
                result.price = sanitizePrice(result.price);
                result.currency = result.currency || "BRL";
                result.name = result.name || "";
                console.log(`[NVIDIA NIM] SUCCESS (model=${model}): "${result.name?.substring(0, 30)}" - R$ ${result.price}`);
                return result as ScrapeResult;
              }
            } catch (e) {
              console.log("[NVIDIA NIM] Failed to parse JSON");
            }
          }
          break; // resposta válida mas sem JSON → não retry
        } catch (err: any) {
          console.log(`[NVIDIA NIM] Error (model=${model}, attempt=${attempt}): ${err.message || err}`);
          if (attempt < NVIDIA_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, NVIDIA_RETRY_DELAY_MS));
          }
        }
      }
    }

    console.log("[NVIDIA NIM] No valid result from any model");
    return null;
  } catch (error: any) {
    console.error("[NVIDIA NIM] Error:", error.message);
    console.error("[NVIDIA NIM] Stack:", error.stack?.split("\n").slice(0, 3).join("\n"));
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return null;
  }
}

function isGeminiRateLimitError(error: any): boolean {
  if (!error) return false;
  const message = String(error.message || "");
  return (
    error.status === 429 ||
    error.code === 429 ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

async function scrapeWithGemini(url: string, contextText: string, apiKey?: string): Promise<ScrapeResult | null> {
  if (!apiKey) {
    console.warn("[Gemini] No API key configured, skipping");
    return null;
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = contextText
    ? `Extract product info from this webpage content.

Content: ${contextText.slice(0, 15000)}

Return JSON with: {name, price (number only, no currency symbol), currency ("BRL"), available (boolean), imageUrl}.

CRITICAL PRICE RULES:
- Extract the LOWEST price shown (Pix/Boleto/Cash price)
- Ignore installment prices or "suggested" prices
- Price must be a NUMBER (e.g., 2999.99)
- If multiple prices found, pick the smallest one

Return ONLY valid JSON, no explanation.`
    : `Extract product info from this URL: ${url}. Return JSON: {name, price (number), currency ("BRL"), available (boolean), imageUrl}.`;

  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: AI_MODELS.URL_CONTEXT,
        contents: prompt,
        config: {
          tools: contextText ? [] : [{ urlContext: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              price: { type: Type.NUMBER },
              currency: { type: Type.STRING },
              available: { type: Type.BOOLEAN },
              imageUrl: { type: Type.STRING },
            },
            required: ["name", "price", "currency", "available"],
          },
        },
      });

      const result = JSON.parse(response.text || "{}");
      console.log(`[Gemini] Extracted: name="${result.name?.substring(0, 50)}", price=${result.price}`);
      return result as ScrapeResult;
    } catch (error: any) {
      if (isGeminiRateLimitError(error)) {
        if (attempt < MAX_ATTEMPTS) {
          console.warn("[Gemini] ⚠️ Quota 429 - retrying in 3s...");
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        console.error("[Gemini] ✗ Quota 429 exhausted - skipping Gemini");
        console.error("[Gemini] Gemini API quota exceeded (429). Try again later or use another strategy.");
        return null;
      }
      console.error("[Gemini] Error:", error.message || error);
      return null;
    }
  }

  return null;
}

// FASE 14 — GEMINI_VISION: screenshot via Playwright + modelo de visão,
// usado quando o HTML é ilegível (paywall/JS pesado/bot).
async function scrapeWithGeminiVision(url: string, apiKey: string): Promise<ScrapeResult | null> {
  if (!apiKey) return null;
  console.log("[GEMINI_VISION] Starting vision extraction...");

  const ai = new GoogleGenAI({ apiKey });
  let browser: any = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const context = await browser.newContext({
      userAgent: getRandomUserAgent(),
      viewport: { width: 1280, height: 960 },
      locale: "pt-BR",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(`window.scrollTo(0, 300)`);
    await page.waitForTimeout(1500);
    await page.evaluate(`window.scrollTo(0, 0)`);
    await page.waitForTimeout(800);

    const shot: any = await page.screenshot({ type: "png" });
    const data = Buffer.isBuffer(shot) ? shot.toString("base64") : shot.data;

    await browser.close();
    browser = null;

    if (!data) {
      console.log("[GEMINI_VISION] Screenshot vazio");
      return null;
    }

    const response = await ai.models.generateContent({
      model: AI_MODELS.VISION,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Esta é uma captura de tela de uma página de produto. Extraia: 1) o NOME COMPLETO do produto (sem nome do site); 2) o MENOR preço à vista em reais (ignore parcelas/'de R$', juros e custos de frete); 3) a URL da imagem principal do produto se estiver visível. Responda APENAS JSON válido: {name: string, price: number, imageUrl: string}.",
            },
            { inlineData: { mimeType: "image/png", data } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            price: { type: Type.NUMBER },
            imageUrl: { type: Type.STRING },
          },
          required: ["name", "price"],
        },
      },
    });

    const result = JSON.parse(response.text || "{}");
    if (!isValidPrice(Number(result.price)) || !result.name) {
      console.log("[GEMINI_VISION] Resposta sem dados válidos:", result.name || "sem nome");
      return null;
    }
    result.price = sanitizePrice(Number(result.price));
    result.currency = "BRL";
    result.available = true;
    result.imageUrl = result.imageUrl || undefined;
    console.log(`[GEMINI_VISION] ✓ name="${(result.name || "").substring(0, 50)}", price=${result.price}`);
    return result as ScrapeResult;
  } catch (error: any) {
    console.error("[GEMINI_VISION] Error:", error.message || error);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    return null;
  }
}

// FASE 14 — SEARCH_VERIFY: quando a página não renderiza, usa Serper/Tavily
// + NVIDIA para extrair nome/preço a partir dos snippets de busca.
async function scrapeWithSearchVerify(
  url: string,
  nameHint: string,
  options: ScrapeOptions
): Promise<ScrapeResult | null> {
  if (nameHint.length < 5) {
    // sem nome confiável — grounding via Gemini urlContext é a melhor aposta
    if (options.geminiApiKey) {
      return scrapeWithGemini(url, "", options.geminiApiKey);
    }
    return null;
  }

  console.log(`[SEARCH_VERIFY] Buscando "${nameHint}" para validar...`);

  let snippet = "";
  if (options.tavilyApiKey) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: options.tavilyApiKey,
          query: `"${nameHint}"`,
          search_depth: "basic",
          max_results: 3,
          include_answer: true,
          language: "pt",
        }),
      });
      const j = await res.json();
      const answer = j.answer && typeof j.answer === "string" ? j.answer : "";
      const results = Array.isArray(j.results) ? j.results.slice(0, 3) : [];
      snippet = (answer + " " + results.map((x: any) => `${x.title || ""} ${x.content || ""}`).join(" ")).trim();
      console.log(`[SEARCH_VERIFY] Tavily snippet (${snippet.length} chars)`);
    } catch (e: any) {
      console.log("[SEARCH_VERIFY] Tavily falhou:", e.message || e);
    }
  } else if (options.serperApiKey) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": options.serperApiKey },
        body: JSON.stringify({ q: `"${nameHint}"`, gl: "br", hl: "pt-br" }),
      });
      const j = await res.json();
      const results = Array.isArray(j.organic) ? j.organic.slice(0, 3) : [];
      snippet = results.map((x: any) => `${x.title || ""} ${x.snippet || ""}`).join(" ");
      console.log(`[SEARCH_VERIFY] Serper snippet (${snippet.length} chars)`);
    } catch (e: any) {
      console.log("[SEARCH_VERIFY] Serper falhou:", e.message || e);
    }
  }

  if (!snippet || snippet.length < 40) return null;

  // 1) NVIDIA (grátis) extrai do snippet — com retry e fallback de modelo
  if (options.nvidiaApiKey) {
    const client = new OpenAI({
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: options.nvidiaApiKey,
    });
    const models = [NVIDIA_EXTRACT_MODEL, NVIDIA_FALLBACK_MODEL];
    for (const model of models) {
      for (let attempt = 1; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
        try {
          console.log(`[SEARCH_VERIFY] NVIDIA call (model=${model}, attempt=${attempt})`);
          const resp = await client.chat.completions.create({
            model,
            messages: [
              { role: "system", content: "Extraia o nome do produto e o MENOR preço em reais (BRL). Retorne APENAS JSON válido: {\"name\":\"\", \"price\":123.45}" },
              { role: "user", content: `Texto: ${snippet.slice(0, 3000)}\n\nJSON:` },
            ],
            max_tokens: 300,
            temperature: 0,
          });
          const text = resp.choices[0].message?.content || "";
          const jm = text.match(/\{[\s\S]*\}/);
          if (jm) {
            const out = JSON.parse(jm[0].replace(/```json?\s*/gi, "").replace(/```\s*/g, ""));
            const price = sanitizePrice(Number(out.price));
            if (isValidPrice(price) && out.name && String(out.name).length > 5) {
              console.log(`[SEARCH_VERIFY] ✓ NVIDIA (model=${model}): "${String(out.name).substring(0, 40)}" R$ ${price}`);
              return {
                name: cleanProductName(String(out.name)),
                price,
                currency: "BRL",
                available: true,
                priceConfirmed: false,
                nameSource: "SEARCH",
              } as ScrapeResult;
            }
          }
          break; // resposta válida mas sem resultado → não retry
        } catch (e: any) {
          console.log(`[SEARCH_VERIFY] NVIDIA falhou (model=${model}, attempt=${attempt}):`, e.message || e);
          if (attempt < NVIDIA_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, NVIDIA_RETRY_DELAY_MS));
          }
        }
      }
    }
  }

  // 2) Gemini grounding na página original como validação
  if (options.geminiApiKey) {
    const viaGemini = await scrapeWithGemini(url, "", options.geminiApiKey);
    if (viaGemini && isValidPrice(viaGemini.price) && (viaGemini.name || "").length > 5) {
      console.log(`[SEARCH_VERIFY] ✓ Gemini grounding: "${viaGemini.name.substring(0, 40)}" R$ ${viaGemini.price}`);
      return viaGemini;
    }
  }

  return null;
}
