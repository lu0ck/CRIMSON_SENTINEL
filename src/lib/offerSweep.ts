// ============================================================
// #55 — Varredura de promoções do estabelecimento.
// A página de ofertas (priceUrl SEM {term}, ex.: Tático /gyn/ofertas/) é
// renderizada 1× com várias capturas de viewport (o encarte do Tático é
// 100% IMAGEM — sem texto de preço no DOM) e extraída como ARRAY de
// promoções: DeepSeek vision → Gemini vision → DeepSeek text → Gemini text
// → parser determinístico do texto (#54/#56).
// Salva em `promotions` com validade (SWEEP_TTL_HOURS, padrão 24h): durante
// a vigência o scan usa a promo no lugar da re-busca (promo-cache) e ao
// adicionar um produto na lista o sistema responde "onde está mais barato".
// ============================================================

import { chromium } from "playwright-extra";
import OpenAI from "openai";
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
  /** #57 — NVIDIA vision (sondado no catálogo: 11b/phi-3-vision) */
  nvidiaApiKey?: string;
  /** #57 — LM Studio local, último recurso (só se o servidor estiver no ar) */
  lmStudioUrl?: string;
}

/** Validade padrão das promoções varridas (Tático renova ofertas diárias). */
const SWEEP_TTL_HOURS = Number(process.env.SWEEP_TTL_HOURS || 24);
const SWEEP_MAX_OFFERS = 200;

// #58 — transcrição LITERAL: o llama-11b "leu" "Condicionador TRESemmé" como
// "Condominio Tresseme" (aproximou o nome em vez de transcrever) e errava
// dígitos de preço. Regra nova: descartar > inventar; conferir cada dígito.
const SWEEP_PROMPT =
  "Esta é uma captura de parte de um encarte/página de ofertas de supermercado " +
  "(as ofertas podem estar impressas em imagens de cartaz). Extraia TODAS as promoções visíveis NESTA captura. " +
  "REGRA DE OURO: transcreva o texto de cada produto EXATAMENTE como está impresso no cartaz " +
  "(marca, variedade, sabor, tamanho) — sem corrigir, sem aproximar, sem inventar ou adivinhar palavras. " +
  "Se não conseguir ler o nome OU o preço com clareza, NÃO inclua o item (melhor menos itens que itens errados). " +
  "Confira cada dígito do preço contra a imagem; preço promocional sempre com 2 casas decimais. " +
  "Responda APENAS com JSON array válido, sem markdown: " +
  '[{"name":"NOME DO PRODUTO EXATAMENTE COMO IMPRESSO","price":12.34,"regularPrice":45.6}] ' +
  "- price = preço promocional em BRL (obrigatório); regularPrice = preço normal (opcional, só se visível). " +
  "Inclua apenas produtos com preço claramente visível; máximo 40 itens.";

/** Máximo de capturas de viewport por varredura (encartes longos). */
const MAX_CAPTURES = 6;
const VIEWPORT_STEP = 900;

// #57 — VLM de geração da chave do operador (sondado 2026-09-26):
// - meta/llama-3.2-11b-vision-instruct → EXTRAÍ o encarte de verdade (ok);
// - microsoft/phi-3-vision → 404 "Not found for account" (não provisionado);
// - meta/llama-3.2-90b-vision → timeout 180s no free tier (lento demais).
// Lista mantida só p/ override via env NVIDIA_VISION_MODEL.
const NVIDIA_VISION_MODELS = [
  process.env.NVIDIA_VISION_MODEL,
  "meta/llama-3.2-11b-vision-instruct",
].filter(Boolean) as string[];

// #57 — proteções do LM local (GTX 960 2GB / 16 threads — varredura nunca pode
// virar scan de 40min): só as 2 primeiras capturas, saída curta, timeout 90s.
const LM_SWEEP_MAX_CAPTURES = 2;
const LM_SWEEP_MAX_TOKENS = 1500;
const LM_SWEEP_TIMEOUT_MS = 90_000;

// #57 — SDK GoogleGenAI sem timeout travou o smoke 6min em silêncio (429
// mascarava antes; com quota liberada a chamada pendurou). AbortSignal é
// client-only — cancela a espera sem cobrança do lado do servidor.
const GEMINI_SWEEP_TIMEOUT_MS = Number(process.env.GEMINI_SWEEP_TIMEOUT_MS || 45_000);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** priceUrl sem {term} = página de ofertas (sweep aplicável). */
export function isOffersPageUrl(priceUrl: string | undefined | null): boolean {
  return !!priceUrl && !priceUrl.includes("{term}");
}

// ---------------------------------------------------------------------------
// Render: Playwright 1× → N capturas de viewport (o encarte é imagem) + texto
// ---------------------------------------------------------------------------
interface OfferRender {
  /** screenshots viewport ao longo da página (ordenados topo → base) */
  captures: string[];
  /** innerText p/ páginas com texto real (fallback determinístico/IA-texto) */
  text: string;
}

async function renderOffersPage(url: string): Promise<OfferRender | null> {
  let browser: any = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 960 },
      // #58 — texto de cartaz em 1x saía borrado p/ VLM (dígitos errando);
      // 2x → PNG 2560x1920, transcrição muito mais confiável.
      deviceScaleFactor: 2,
      locale: "pt-BR",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);

    // altura total + lazy-load varrendo a página
    const pageHeight = (await page.evaluate(`document.body.scrollHeight`).catch(() => 960)) as number;
    const passes = Math.max(1, Math.min(MAX_CAPTURES, Math.ceil(pageHeight / VIEWPORT_STEP)));

    const captures: string[] = [];
    const grab = async () => {
      const shot: any = await page.screenshot({ type: "png" });
      const b64 = Buffer.isBuffer(shot) ? shot.toString("base64") : shot.data || null;
      if (b64) captures.push(b64);
    };

    await grab(); // topo
    for (let i = 1; i < passes; i++) {
      await page.evaluate(`window.scrollTo(0, ${i * VIEWPORT_STEP})`);
      await page.waitForTimeout(700);
      await grab();
    }

    const text = (await page.evaluate(`document.body.innerText.slice(0, 12000)`).catch(() => "")) as string;
    await browser.close();
    browser = null;
    if (captures.length === 0 && !text) return null;
    return { captures, text: text || "" };
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
// Extração — cadeia: DeepSeek vision → Gemini vision → DeepSeek text →
// Gemini text → parser determinístico (decisão do operador: IA → det)
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

/**
 * Parser determinístico p/ páginas com texto de preço real (o encarte do
 * Tático é imagem e cai fora aqui — vira último recurso das páginas textuais).
 * Heurística: linha com "R$ X,XX" → nome = linhas alfabéticas imediatamente acima.
 */
export function extractDetOffers(text: string): SweptOffer[] {
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: { name: string; price: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2})/);
    if (!m) continue;
    const price = sanitizePrice(Number(m[1].replace(/\./g, "").replace(",", ".")));
    if (!isValidPrice(price)) continue;
    // nome: até 2 linhas alfabéticas (len≥4) entre i-3..i-1, na ordem natural
    const nameParts: string[] = [];
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (/R\$/.test(lines[j])) break;
      if (!/[a-zA-ZÀ-ú]{4}/.test(lines[j])) continue;
      nameParts.unshift(lines[j]);
      if (nameParts.length >= 2) break;
    }
    const name = nameParts.join(" ").slice(0, 80);
    if (name.length >= 4) out.push({ name, price });
  }
  return sanitizeOffers(out);
}

async function visionDeepSeek(captures: string[], apiKey: string): Promise<SweptOffer[]> {
  const all: any[] = [];
  for (const png of captures) {
    try {
      const arr = extractJsonArray(
        await deepseekVision({ base64: png, mimeType: "image/png" }, SWEEP_PROMPT, { apiKey, maxTokens: 4000 })
      );
      if (arr) all.push(...arr);
    } catch (e: any) {
      safeLog(`[sweep] DeepSeek vision falhou numa captura: ${e?.message || e}`);
      break; // provider caiu → tenta próximo
    }
  }
  return sanitizeOffers(all);
}

async function visionGemini(captures: string[], apiKey: string): Promise<SweptOffer[]> {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const all: any[] = [];
    for (const png of captures) {
      try {
        const r = await ai.models.generateContent({
          model: AI_MODELS.VISION,
          contents: [
            { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: png } }, { text: SWEEP_PROMPT }] },
          ],
          config: { responseMimeType: "application/json", abortSignal: AbortSignal.timeout(GEMINI_SWEEP_TIMEOUT_MS) },
        });
        const arr = extractJsonArray(r.text || "");
        if (arr) all.push(...arr);
      } catch (e: any) {
        safeLog(`[sweep] Gemini vision falhou numa captura: ${e?.message || e}`);
        break;
      }
    }
    return sanitizeOffers(all);
  } catch (e: any) {
    safeLog(`[sweep] Gemini indisponível: ${e?.message || e}`);
    return [];
  }
}

// #57 — NVIDIA vision (OpenAI-compat integrate.api.nvidia.com, `image_url`
// data-URL): free tier medido ~92s/chamada (pico estourou 150s no smoke) →
// timeout 300s; TIMEOUT aborta o provider (senão 6 capturas × 300s = 30min).
const NVIDIA_SWEEP_TIMEOUT_MS = Number(process.env.NVIDIA_SWEEP_TIMEOUT_MS || 300_000);
async function nvidiaVision(captures: string[], apiKey: string): Promise<SweptOffer[]> {
  try {
    const client = new OpenAI({
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey,
      timeout: NVIDIA_SWEEP_TIMEOUT_MS,
      maxRetries: 0,
    });
    const all: any[] = [];
    let abort = false;
    for (const png of captures) {
      if (abort) break;
      for (const model of NVIDIA_VISION_MODELS) {
        try {
          const r = await client.chat.completions.create({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
                  { type: "text", text: SWEEP_PROMPT },
                ],
              },
            ],
            // #57 — 3000 p/ ~40 itens; truncagem ainda é salva pelo repair
            // do extractJsonArray (finish_reason=length é a regra no free tier)
            max_tokens: 3000,
            temperature: 0,
          });
          const arr = extractJsonArray(r.choices?.[0]?.message?.content || "");
          if (arr && arr.length > 0) {
            all.push(...arr);
            break; // modelo funcionou nesta captura
          }
        } catch (e: any) {
          const msg = String(e?.message || e);
          safeLog(`[sweep] NVIDIA vision ${model} falhou: ${msg.slice(0, 140)}`);
          if (/timed out|timeout|abort/i.test(msg)) {
            abort = true; // endpoint lento → não acumular timeouts
            break;
          }
        }
      }
    }
    return sanitizeOffers(all);
  } catch (e: any) {
    safeLog(`[sweep] NVIDIA vision indisponível: ${e?.message || e}`);
    return [];
  }
}

// #57 — LM Studio local, ÚLTIMO da cadeia (só se o servidor responder) —
// protegido p/ a máquina não estourar: 2 capturas, 1500 tokens, 90s/chamada.
async function lmStudioVision(captures: string[], lmUrl: string): Promise<SweptOffer[]> {
  try {
    const chk = await fetch(`${lmUrl}/models`, { signal: AbortSignal.timeout(2500) });
    if (!chk.ok) {
      safeLog(`[sweep] LM Studio respondeu ${chk.status} — pulando`);
      return [];
    }
    const md: any = await chk.json();
    const model = md?.data?.[0]?.id;
    if (!model) {
      safeLog(`[sweep] LM Studio sem modelo carregado — pulando`);
      return [];
    }
    safeLog(`[sweep] LM Studio vision (local): modelo ${model}, ${Math.min(captures.length, LM_SWEEP_MAX_CAPTURES)} captura(s)`);
    const client = new OpenAI({ baseURL: lmUrl, apiKey: "lm-studio", timeout: LM_SWEEP_TIMEOUT_MS, maxRetries: 0 });
    const all: any[] = [];
    for (const png of captures.slice(0, LM_SWEEP_MAX_CAPTURES)) {
      try {
        const r = await client.chat.completions.create({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
                { type: "text", text: SWEEP_PROMPT },
              ],
            },
          ],
          max_tokens: LM_SWEEP_MAX_TOKENS,
          temperature: 0,
        });
        const arr = extractJsonArray(r.choices?.[0]?.message?.content || "");
        if (arr) all.push(...arr);
      } catch (e: any) {
        safeLog(`[sweep] LM Studio vision falhou: ${String(e?.message || e).slice(0, 140)}`);
        break;
      }
    }
    return sanitizeOffers(all);
  } catch (e: any) {
    safeLog(`[sweep] LM Studio offline/indisponível: ${String(e?.message || e).slice(0, 120)}`);
    return [];
  }
}

async function textViaDeepSeek(text: string, apiKey: string): Promise<SweptOffer[]> {
  try {
    return sanitizeOffers(
      extractJsonArray(
        await deepseekText(`${SWEEP_PROMPT}\n\nTEXTO DA PÁGINA:\n"""${text}"""`, { apiKey, maxTokens: 4000 })
      )
    );
  } catch (e: any) {
    safeLog(`[sweep] DeepSeek text falhou: ${e?.message || e}`);
    return [];
  }
}

async function textViaGemini(text: string, apiKey: string): Promise<SweptOffer[]> {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const r = await ai.models.generateContent({
      model: AI_MODELS.TEXT,
      contents: `${SWEEP_PROMPT}\n\nTEXTO DA PÁGINA:\n"""${text}"""`,
      config: { responseMimeType: "application/json", abortSignal: AbortSignal.timeout(GEMINI_SWEEP_TIMEOUT_MS) },
    });
    return sanitizeOffers(extractJsonArray(r.text || ""));
  } catch (e: any) {
    safeLog(`[sweep] Gemini text falhou: ${e?.message || e}`);
    return [];
  }
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

  // 1) DeepSeek vision (todas as capturas → merge/dedupe)
  if (dsKey && rendered.captures.length > 0) {
    const viaVision = await visionDeepSeek(rendered.captures, dsKey);
    if (viaVision.length > 0) {
      safeLog(`[sweep] DeepSeek vision: ${viaVision.length} promoções (${rendered.captures.length} capturas) em ${establishment.name}`);
      return viaVision;
    }
  }

  // 2) Gemini vision
  if (keys.geminiApiKey && rendered.captures.length > 0) {
    const viaVision = await visionGemini(rendered.captures, keys.geminiApiKey);
    if (viaVision.length > 0) {
      safeLog(`[sweep] Gemini vision: ${viaVision.length} promoções (${rendered.captures.length} capturas) em ${establishment.name}`);
      return viaVision;
    }
  }

  // 3) #57 — NVIDIA vision (ordem da cadeia #54: depois do Gemini)
  if (keys.nvidiaApiKey && rendered.captures.length > 0) {
    const viaVision = await nvidiaVision(rendered.captures, keys.nvidiaApiKey);
    if (viaVision.length > 0) {
      safeLog(`[sweep] NVIDIA vision: ${viaVision.length} promoções (${rendered.captures.length} capturas) em ${establishment.name}`);
      return viaVision;
    }
  }

  // 4) DeepSeek text (páginas com texto real)
  if (dsKey && rendered.text) {
    const viaText = await textViaDeepSeek(rendered.text, dsKey);
    if (viaText.length > 0) {
      safeLog(`[sweep] DeepSeek text: ${viaText.length} promoções em ${establishment.name}`);
      return viaText;
    }
  }

  // 5) Gemini text
  if (keys.geminiApiKey && rendered.text) {
    const viaText = await textViaGemini(rendered.text, keys.geminiApiKey);
    if (viaText.length > 0) {
      safeLog(`[sweep] Gemini text: ${viaText.length} promoções em ${establishment.name}`);
      return viaText;
    }
  }

  // 6) #57 — LM Studio vision (local, último recurso antes do det; protegido)
  if (keys.lmStudioUrl && rendered.captures.length > 0) {
    const viaLocal = await lmStudioVision(rendered.captures, keys.lmStudioUrl);
    if (viaLocal.length > 0) {
      safeLog(`[sweep] LM Studio vision: ${viaLocal.length} promoções (local) em ${establishment.name}`);
      return viaLocal;
    }
  }

  // 7) Determinístico (só páginas com "R$ X,XX" no texto — encarte-imagem não tem)
  const det = extractDetOffers(rendered.text);
  if (det.length > 0) {
    safeLog(`[sweep] det text: ${det.length} promoções em ${establishment.name}`);
    return det;
  }

  safeLog(
    `[sweep] nenhuma promoção extraída em ${establishment.name} ` +
      `(${rendered.captures.length} capturas; sem chave ou IA falhou — texto sem preços p/ parser det)`
  );
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
