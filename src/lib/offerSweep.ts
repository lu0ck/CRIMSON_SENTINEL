// ============================================================
// #55 — Varredura de promoções do estabelecimento.
// A página de ofertas (priceUrl SEM {term}, ex.: Tático /gyn/ofertas/) é
// renderizada 1× e extraída como ARRAY de promoções — DeepSeek (visão →
// texto) primeiro, Gemini (visão → texto) como fallback (#54).
// Salva em `promotions` com validade (SWEEP_TTL_HOURS, padrão 24h): durante
// a vigência o scan usa a promo no lugar da re-busca (promo-cache) e ao
// adicionar um produto na lista o sistema responde "onde está mais barato".
// ============================================================

import { chromium } from "playwright-extra";
import type { Establishment, Promotion } from "../types";
import { PromotionRepository } from "../repositories/promotionRepository";
import { isValidPrice, sanitizePrice } from "./price";
import { normalizeText } from "./text";
import { safeLog } from "./safeLog";
import {
  deepseekText,
  deepseekVision,
  extractJsonArray,
  resolveDeepSeekKey,
} from "./aiProviders";
import { promoMatchesItem } from "./promoMatch";
import { AI_MODELS } from "./aiModels";

export interface SweptOffer {
  name: string;
  price: number;
  regularPrice?: number;
}

export interface SweepKeys {
  deepseekApiKey?: string;
  geminiApiKey?: string;
}

/** Validade padrão das promoções varridas (Tático renova ofertas diárias). */
const SWEEP_TTL_HOURS = Number(process.env.SWEEP_TTL_HOURS || 24);
const SWEEP_MAX_OFFERS = 200;

const SWEEP_PROMPT =
  "Esta é uma página de ofertas/promoções de supermercado. Extraia TODAS as promoções visíveis. " +
  "Responda APENAS com JSON array válido, sem markdown: " +
  '[{"name":"NOME DO PRODUTO","price":12.34,"regularPrice":45.6}] ' +
  "- price = preço promocional em BRL (obrigatório); regularPrice = preço normal (opcional, só se visível). " +
  "Inclua apenas produtos com preço claramente visível; máximo 150 itens.";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** priceUrl sem {term} = página de ofertas (sweep aplicável). */
export function isOffersPageUrl(priceUrl: string | undefined | null): boolean {
  return !!priceUrl && !priceUrl.includes("{term}");
}

// ---------------------------------------------------------------------------
// Render: Playwright 1× → texto + screenshot
// ---------------------------------------------------------------------------
async function renderOffersPage(url: string): Promise<{ text: string; png: string | null } | null> {
  let browser: any = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 960 },
      locale: "pt-BR",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    // lazy-load: varre a página p/ materializar cards de produto
    for (let y = 1; y <= 5; y++) {
      await page.evaluate(`window.scrollTo(0, ${y * 900})`);
      await page.waitForTimeout(700);
    }
    await page.evaluate(`window.scrollTo(0, 0)`);
    await page.waitForTimeout(500);

    const shot: any = await page.screenshot({ type: "png" });
    const png = Buffer.isBuffer(shot) ? shot.toString("base64") : shot.data || null;
    const text = (await page.evaluate(`document.body.innerText.slice(0, 12000)`).catch(() => "")) as string;
    await browser.close();
    browser = null;
    if (!text && !png) return null;
    return { text: text || "", png: png || null };
  } catch (e: any) {
    safeLog(`[sweep] render falhou em ${url}: ${e?.message || e}`);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Extração (DeepSeek → Gemini; visão → texto)
// ---------------------------------------------------------------------------
export function sanitizeOffers(raw: any[] | null | undefined): SweptOffer[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, SweptOffer>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const name = String((r as any).name || (r as any).productName || "").trim();
    const rawPrice = (r as any).price ?? (r as any).promoPrice;
    // tolera número, "12,90" e "R$ 12,90"
    const n = typeof rawPrice === "string" ? Number(rawPrice.replace(/[^\d,.-]/g, "").replace(",", ".")) : Number(rawPrice);
    const price = sanitizePrice(n);
    if (name.length < 4 || !isValidPrice(price)) continue;
    const regular = Number((r as any).regularPrice || 0);
    const key = normalizeText(name);
    const prev = byKey.get(key);
    if (!prev || price < prev.price) {
      byKey.set(key, { name, price, regularPrice: regular > price ? regular : undefined });
    }
    if (byKey.size >= SWEEP_MAX_OFFERS) break;
  }
  return [...byKey.values()];
}

async function extractViaGemini(keys: SweepKeys, png: string | null, text: string): Promise<SweptOffer[]> {
  if (!keys.geminiApiKey) return [];
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: keys.geminiApiKey });

    if (png) {
      try {
        const r = await ai.models.generateContent({
          model: AI_MODELS.VISION,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: png } },
                { text: SWEEP_PROMPT },
              ],
            },
          ],
          config: { responseMimeType: "application/json" },
        });
        const offers = sanitizeOffers(extractJsonArray(r.text || ""));
        if (offers.length > 0) {
          safeLog(`[sweep] Gemini vision: ${offers.length} promoções`);
          return offers;
        }
      } catch (e: any) {
        safeLog(`[sweep] Gemini vision falhou: ${e?.message || e}`);
      }
    }

    if (text) {
      try {
        const r = await ai.models.generateContent({
          model: AI_MODELS.TEXT,
          contents: `${SWEEP_PROMPT}\n\nTEXTO DA PÁGINA:\n"""${text}"""`,
          config: { responseMimeType: "application/json" },
        });
        const offers = sanitizeOffers(extractJsonArray(r.text || ""));
        if (offers.length > 0) {
          safeLog(`[sweep] Gemini text: ${offers.length} promoções`);
          return offers;
        }
      } catch (e: any) {
        safeLog(`[sweep] Gemini text falhou: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    safeLog(`[sweep] Gemini indisponível: ${e?.message || e}`);
  }
  return [];
}

/** Renderiza a página de ofertas e devolve o array de promoções (null = nada extraído). */
export async function sweepEstablishmentOffers(
  establishment: Establishment,
  keys: SweepKeys
): Promise<SweptOffer[] | null> {
  if (!isOffersPageUrl(establishment.priceUrl)) return null;

  const rendered = await renderOffersPage(establishment.priceUrl!);
  if (!rendered) return null;

  const dsKey = resolveDeepSeekKey(keys.deepseekApiKey, process.env.DEEPSEEK_API_KEY);
  if (dsKey) {
    if (rendered.png) {
      const viaVision = sanitizeOffers(
        extractJsonArray(await deepseekVision({ base64: rendered.png, mimeType: "image/png" }, SWEEP_PROMPT, { apiKey: dsKey, maxTokens: 4000 }))
      );
      if (viaVision.length > 0) {
        safeLog(`[sweep] DeepSeek vision: ${viaVision.length} promoções em ${establishment.name}`);
        return viaVision;
      }
    }
    if (rendered.text) {
      const viaText = sanitizeOffers(
        extractJsonArray(await deepseekText(`${SWEEP_PROMPT}\n\nTEXTO DA PÁGINA:\n"""${rendered.text}"""`, { apiKey: dsKey, maxTokens: 4000 }))
      );
      if (viaText.length > 0) {
        safeLog(`[sweep] DeepSeek text: ${viaText.length} promoções em ${establishment.name}`);
        return viaText;
      }
    }
  }

  const viaGemini = await extractViaGemini(keys, rendered.png, rendered.text);
  if (viaGemini.length > 0) return viaGemini;

  safeLog(`[sweep] nenhuma promoção extraída em ${establishment.name} (sem chave ou IA falhou)`);
  return null;
}

// ---------------------------------------------------------------------------
// Persistência — id determinístico (sweep-est|hash) reativa/atualiza a linha
// ---------------------------------------------------------------------------
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function saveSweptOffers(establishment: Establishment, offers: SweptOffer[]): { saved: number } {
  const expiresAt = new Date(Date.now() + SWEEP_TTL_HOURS * 3600_000).toISOString();
  const kept = new Set<string>();
  let saved = 0;

  for (const o of offers) {
    const key = normalizeText(o.name);
    if (!key) continue;
    kept.add(key);
    PromotionRepository.save({
      id: `sweep-${hashId(`${establishment.id}|${key}`)}`,
      establishmentId: establishment.id,
      productName: o.name,
      regularPrice: o.regularPrice,
      promoPrice: o.price,
      source: "sweep",
      sourceUrl: establishment.priceUrl,
      detectedAt: new Date().toISOString(),
      isActive: true,
      expiresAt,
    });
    saved++;
  }

  // página é a fonte da verdade: sweep anterior que sumiu → inativa
  for (const p of PromotionRepository.getAll({ establishmentId: establishment.id })) {
    if (p.source === "sweep" && p.isActive && !kept.has(normalizeText(p.productName))) {
      PromotionRepository.save({ ...p, isActive: false });
    }
  }

  return { saved };
}

// ---------------------------------------------------------------------------
// Promo-cache: promoção vigente desta loja que cobre o item (menor preço)
// ---------------------------------------------------------------------------
export function findActivePromo(establishmentId: string, itemName: string): Promotion | undefined {
  const nowIso = new Date().toISOString();
  const itemKey = normalizeText(itemName);
  let bestExact: Promotion | undefined;
  let bestLoose: Promotion | undefined;
  for (const p of PromotionRepository.getAll({ establishmentId })) {
    if (!p.isActive) continue;
    // cache exige validade explícita no futuro (expires_at; endDate vale até o fim do dia)
    const validUntil = p.expiresAt || (p.endDate ? `${p.endDate}T23:59:59.999Z` : undefined);
    if (!validUntil || validUntil <= nowIso) continue;
    if (!promoMatchesItem(p.productName, itemName)) continue;
    // nome exato do item vence variante próxima ("Queijo Minas" ≠ promo Mussarela)
    const exact = normalizeText(p.productName) === itemKey;
    const slot = exact ? bestExact : bestLoose;
    if (!slot || p.promoPrice < slot.promoPrice) {
      if (exact) bestExact = p;
      else bestLoose = p;
    }
  }
  return bestExact || bestLoose;
}
