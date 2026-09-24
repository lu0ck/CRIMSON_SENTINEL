// #32 — registry de handlers por rede de varejo (market-handlers).
// Quando establishments.price_url está vazio, o scan local usa chain/nome
// para montar query "«item» «rede» preço" (Serper/Tavily) e extrair preço
// via NVIDIA/Gemini — mesmo espírito do store-handlers, mas por rede.
// #38 — seed expandido (6 → 26+ redes nacionais/regionais; §6.23).

import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { normalizeText } from "./text";
import { isValidPrice, sanitizePrice } from "./price";
import { safeLog } from "./safeLog";
import { AI_MODELS } from "./aiModels";

export interface MarketHandler {
  chainKey: string;
  aliases: string[];
  searchLabel: string;
}

export const marketHandlers: MarketHandler[] = [
  {
    chainKey: "tatico",
    aliases: ["tatico", "supermercados tatico", "rede tatico"],
    searchLabel: "Tatico",
  },
  {
    chainKey: "bretas",
    aliases: ["bretas", "supermercados bretas", "rede bretas"],
    searchLabel: "Bretas",
  },
  {
    chainKey: "carrefour",
    aliases: ["carrefour", "hyper carrefour", "carrefour express", "supermercado carrefour"],
    searchLabel: "Carrefour",
  },
  {
    chainKey: "pao-de-acucar",
    aliases: ["pao de acucar", "paodeacucar", "grupo pao de acucar", "pão de açúcar"],
    searchLabel: "Pao de Acucar",
  },
  {
    chainKey: "assai",
    aliases: ["assai", "assai atacadista", "supermercados assai"],
    searchLabel: "Assai",
  },
  {
    chainKey: "atacadao",
    aliases: ["atacadao", "atacadao atacadista", "grupo atacadista atacadao"],
    searchLabel: "Atacadao",
  },
  {
    chainKey: "extra",
    aliases: ["extra", "supermercado extra", "hiper extra", "extra supermercados"],
    searchLabel: "Extra Supermercados",
  },
  {
    chainKey: "ponto",
    aliases: ["ponto", "ponto extra", "supermercado ponto", "gpa ponto"],
    searchLabel: "Ponto Extra",
  },
  {
    chainKey: "minasu",
    aliases: ["minasu", "supermercado minasu"],
    searchLabel: "Minasu",
  },
  {
    chainKey: "mundial",
    aliases: ["mundial", "supermercados mundial", "supermercado mundial"],
    searchLabel: "Supermercados Mundial",
  },
  {
    chainKey: "zaffari",
    aliases: ["zaffari", "supermercados zaffari", "extra zaffari"],
    searchLabel: "Zaffari",
  },
  {
    chainKey: "bomboniere",
    aliases: ["bomboniere", "supermercados bomboniere"],
    searchLabel: "Bomboniere",
  },
  {
    chainKey: "prezunic",
    aliases: ["prezunic", "supermercados prezunic"],
    searchLabel: "Prezunic",
  },
  {
    chainKey: "sendas",
    aliases: ["sendas", "supermercados sendas", "sendas atacarejo"],
    searchLabel: "Sendas",
  },
  {
    chainKey: "sendas-fortaleza",
    aliases: ["sendas fortaleza", "supermercado fortaleza", "supermercados fortaleza"],
    searchLabel: "Sendas Fortaleza",
  },
  {
    chainKey: "angeloni",
    aliases: ["angeloni", "supermercados angeloni"],
    searchLabel: "Angeloni",
  },
  {
    chainKey: "diana",
    aliases: ["diana", "supermercados diana", "diana supermercados"],
    searchLabel: "Diana Supermercados",
  },
  {
    chainKey: "verdemar",
    aliases: ["verdemar", "supermercados verdemar"],
    searchLabel: "Verdemar",
  },
  {
    chainKey: "supermercados-real",
    aliases: ["supermercados real", "supermercado real"],
    searchLabel: "Supermercados Real",
  },
  {
    chainKey: "sams-club",
    aliases: ["sams club", "samsclub", "sam s club"],
    searchLabel: "Sam's Club",
  },
  {
    chainKey: "parcela-amarela",
    aliases: ["parcela amarela", "supermercados parcela amarela"],
    searchLabel: "Parcela Amarela",
  },
  {
    chainKey: "imperatriz",
    aliases: ["supermercados imperatriz", "imperatriz supermercados"],
    searchLabel: "Supermercados Imperatriz",
  },
  {
    chainKey: "bonanza",
    aliases: ["supermercados bonanza", "bonanza supermercados"],
    searchLabel: "Supermercados Bonanza",
  },
  {
    chainKey: "gbarbosa",
    aliases: ["gbarbosa", "grupo gbarbosa", "supermercados gbarbosa"],
    searchLabel: "Gbarbosa",
  },
  {
    chainKey: "sonda",
    aliases: ["sonda", "sonda supermercados", "supermercados sonda"],
    searchLabel: "Sonda Supermercados",
  },
  {
    chainKey: "seven-eleven",
    aliases: ["7 eleven", "seven eleven", "sete e meio"],
    searchLabel: "7-Eleven",
  },
  {
    chainKey: "supermercados-ideal",
    aliases: ["supermercados ideal", "supermercado ideal"],
    searchLabel: "Supermercados Ideal",
  },
  {
    chainKey: "atacadao-da-familia",
    aliases: ["atacadao da familia", "atacadao familia"],
    searchLabel: "Atacadão da Família",
  },
  {
    chainKey: "super-bom-preco",
    aliases: ["super bom preco", "supermercado super bom preco"],
    searchLabel: "Super Bom Preço",
  },
  {
    chainKey: "redebompreco",
    aliases: ["rede bom preco", "redebompreco"],
    searchLabel: "Rede Bom Preço",
  },
  {
    chainKey: "hiper-rio",
    aliases: ["hiper rio", "supermercado hiper rio"],
    searchLabel: "Hiper Rio",
  },
];

/** Resolve handler por chain, brand ou nome do estabelecimento (normalizado). */
export function resolveMarketHandler(chainOrName?: string): MarketHandler | null {
  if (!chainOrName) return null;
  const n = normalizeText(chainOrName);
  if (!n) return null;

  for (const h of marketHandlers) {
    const key = normalizeText(h.chainKey);
    if (n === key) return h;
    for (const a of h.aliases) {
      const an = normalizeText(a);
      if (!an) continue;
      if (n === an) return h;
      // includes só em aliases longos (evita "assai" casando em nomes genéricos)
      if (an.length >= 5 && (n.includes(an) || an.includes(n))) return h;
    }
  }
  return null;
}

export function buildMarketSearchQuery(itemName: string, handler: MarketHandler): string {
  return `${itemName} ${handler.searchLabel} preço`.trim().slice(0, 150);
}

export interface MarketSearchKeys {
  serperApiKey?: string;
  tavilyApiKey?: string;
  nvidiaApiKey?: string;
  geminiApiKey?: string;
}

export interface MarketSearchHit {
  price: number;
  name?: string;
  url?: string;
  method: string;
}

// #43 — -0731 retorna 410 Gone
const NVIDIA_EXTRACT_MODEL = "deepseek-ai/deepseek-v4-flash";
const NVIDIA_FALLBACK_MODEL = "z-ai/glm-5.3-flash";
const NVIDIA_MAX_RETRIES = 2;
const NVIDIA_RETRY_DELAY_MS = 2_000;
const SEARCH_TIMEOUT_MS = 20_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("search timeout")), ms)),
  ]);
}

async function fetchSnippet(query: string, keys: MarketSearchKeys): Promise<string> {
  let snippet = "";
  if (keys.tavilyApiKey) {
    try {
      const res = await withTimeout(
        fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: keys.tavilyApiKey,
            query,
            search_depth: "basic",
            max_results: 3,
            include_answer: true,
            language: "pt",
          }),
        }),
        SEARCH_TIMEOUT_MS
      );
      const j = await res.json();
      const answer = j.answer && typeof j.answer === "string" ? j.answer : "";
      const results = Array.isArray(j.results) ? j.results.slice(0, 3) : [];
      snippet = (
        answer +
        " " +
        results.map((x: any) => `${x.title || ""} ${x.content || ""}`).join(" ")
      ).trim();
      if (snippet) safeLog(`[market-search] Tavily ok (${snippet.length} chars)`);
    } catch (e: any) {
      safeLog(`[market-search] Tavily falhou: ${e.message || e}`);
    }
  }
  if (!snippet && keys.serperApiKey) {
    try {
      const res = await withTimeout(
        fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": keys.serperApiKey },
          body: JSON.stringify({ q: query, gl: "br", hl: "pt-br", num: 8 }),
        }),
        SEARCH_TIMEOUT_MS
      );
      const j = await res.json();
      const results = Array.isArray(j.organic) ? j.organic.slice(0, 5) : [];
      snippet = results.map((x: any) => `${x.title || ""} ${x.snippet || ""}`).join(" ");
      if (snippet) safeLog(`[market-search] Serper ok (${snippet.length} chars)`);
    } catch (e: any) {
      safeLog(`[market-search] Serper falhou: ${e.message || e}`);
    }
  }
  return snippet;
}

async function extractPriceWithNvidia(snippet: string, keys: MarketSearchKeys): Promise<MarketSearchHit | null> {
  if (!keys.nvidiaApiKey || snippet.length < 40) return null;
  const client = new OpenAI({
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: keys.nvidiaApiKey,
  });
  const models = [NVIDIA_EXTRACT_MODEL, NVIDIA_FALLBACK_MODEL];
  for (const model of models) {
    for (let attempt = 1; attempt <= NVIDIA_MAX_RETRIES; attempt++) {
      try {
        const resp = await client.chat.completions.create({
          model,
          messages: [
            {
              role: "system",
              content:
                'Extraia o nome do produto e o MENOR preço em reais (BRL). Retorne APENAS JSON válido: {"name":"","price":123.45}',
            },
            {
              role: "user",
              content: `Texto: ${snippet.slice(0, 3000)}\n\nJSON:`,
            },
          ],
          max_tokens: 300,
          temperature: 0,
        });
        const text = resp.choices[0].message?.content || "";
        const jm = text.match(/\{[\s\S]*\}/);
        if (jm) {
          const out = JSON.parse(jm[0].replace(/```json?\s*/gi, "").replace(/```\s*/g, ""));
          const price = sanitizePrice(Number(out.price));
          if (isValidPrice(price)) {
            return {
              price,
              name: out.name ? String(out.name) : undefined,
              method: "search-nvidia",
            };
          }
        }
        break;
      } catch (e: any) {
        safeLog(`[market-search] NVIDIA falhou (model=${model}, attempt=${attempt}): ${e.message || e}`);
        if (attempt < NVIDIA_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, NVIDIA_RETRY_DELAY_MS));
        }
      }
    }
  }
  return null;
}

async function extractPriceWithGemini(snippet: string, keys: MarketSearchKeys): Promise<MarketSearchHit | null> {
  if (!keys.geminiApiKey || snippet.length < 40) return null;
  try {
    const ai = new GoogleGenAI({ apiKey: keys.geminiApiKey });
    const response = await withTimeout(
      ai.models.generateContent({
        model: AI_MODELS.TEXT,
        contents: `Extraia o MENOR preço em reais (BRL) do produto no texto. Retorne APENAS JSON: {"name":"","price":123.45}\n\nTexto:\n${snippet.slice(0, 3000)}`,
        config: { responseMimeType: "application/json" },
      }),
      SEARCH_TIMEOUT_MS
    );
    const raw = response.text || "";
    const jm = raw.match(/\{[\s\S]*\}/);
    if (jm) {
      const out = JSON.parse(jm[0].replace(/```json?\s*/gi, "").replace(/```\s*/g, ""));
      const price = sanitizePrice(Number(out.price));
      if (isValidPrice(price)) {
        return {
          price,
          name: out.name ? String(out.name) : undefined,
          method: "search-gemini",
        };
      }
    }
  } catch (e: any) {
    safeLog(`[market-search] Gemini falhou: ${e.message || e}`);
  }
  return null;
}

/**
 * Busca "«item» «rede» preço" (Tavily → Serper) e extrai preço (NVIDIA → Gemini).
 * Retorna null quando não há keys de busca/LLM ou nenhum preço válido.
 */
export async function searchMarketPrice(
  itemName: string,
  handler: MarketHandler,
  keys: MarketSearchKeys
): Promise<MarketSearchHit | null> {
  const canSearch = !!(keys.serperApiKey || keys.tavilyApiKey);
  const canExtract = !!(keys.nvidiaApiKey || keys.geminiApiKey);
  if (!canSearch || !canExtract) return null;

  const query = buildMarketSearchQuery(itemName, handler);
  safeLog(`[market-search] query="${query}"`);
  const snippet = await fetchSnippet(query, keys);
  if (!snippet || snippet.length < 40) return null;

  const viaNvidia = await extractPriceWithNvidia(snippet, keys);
  if (viaNvidia) return viaNvidia;
  return extractPriceWithGemini(snippet, keys);
}
