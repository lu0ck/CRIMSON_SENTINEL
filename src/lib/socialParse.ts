import type { Establishment } from "../types";
import { PromotionRepository } from "../repositories/promotionRepository";
import { EstablishmentRepository } from "../repositories/establishmentRepository";

// ---------------------------------------------------------------------------
// FASE 8 — parsing de texto social (WhatsApp/Instagram) em promoções.
// Determinístico por padrão; enriquecido por Gemini quando há API key.
// ---------------------------------------------------------------------------

export interface ParsedPromo {
  productName: string;
  promoPrice: number;
  regularPrice?: number;
  establishmentId?: string;
  establishmentName?: string;
  discountPct?: number;
}

// Normaliza para comparação (minúsculas, sem acentos).
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Limpa nome do produto: remove prefixo/sufixo de conectivos ("por apenas"),
// separadores e números soltos.
export function cleanProductName(name: string): string {
  return name
    .replace(/^[-–—:|*·\s]+/, "")
    .replace(/\s*[-–—:|*·]+\s*$/, "")
    .replace(/\b(por\s+apenas|por\s+só|por\s+somente|por|a\s+partir\s+de|só|somente|apenas)\s*$/i, "")
    .replace(/\s*[-–—:|*·]+\s*$/, "")
    .replace(/^(oferta\s+relâmpago|oferta\s+relampago|super\s+oferta|promoção|promocao|megapromoção|megapromocao|imperdível|imperdivel|só\s+hoje|black\s+friday|desconto)\s*[:!.\-]*\s*/gi, "")
    .replace(/^[-–—:|*·\s]+/, "")
    .replace(/\s+[-–—:|*·]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "R$ 23,90" / "R$23.90" / "23,90" → número
export function parsePrice(raw: string): number | null {
  const m = raw
    .replace(/\s/g, "")
    .match(/(\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,3}(?:\.\d{3})*\.\d{2}|\d+)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// Encontra o estabelecimento cujo nome aparece no texto (por nome normalizado).
// Usa establishmentHint se o texto não nomear nenhum estabelecimento cadastrado.
export function matchEstablishment(
  text: string,
  hint?: string,
  establishments?: Establishment[]
): Establishment | undefined {
  const all = establishments ?? EstablishmentRepository.getAll();
  const t = normalize(text);
  let found: Establishment | undefined;

  for (const e of all) {
    const n = normalize(e.name);
    if (n.length >= 3 && t.includes(n)) {
      if (!found || n.length > normalize(found.name).length) found = e;
    }
  }
  if (!found && hint) {
    const h = normalize(hint);
    for (const e of all) {
      const n = normalize(e.name);
      if (n.length >= 3 && (h.includes(n) || n.includes(h))) return e;
    }
  }
  return found;
}

// Extrai promoções de um texto via regex. Heurísticas:
//  - "de R$ X por R$ Y" → regular=X, promo=Y
//  - "X% OFF" / "desconto" junto de preço
//  - linha com "R$ Y" no fim → promo=Y, nome = texto antes
export function parsePromosFromText(text: string): ParsedPromo[] {
  const out: ParsedPromo[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ");

    // padrão "de R$ X por R$ Y"
    const dePor = line.match(/de\s*R\$\s*([\d.,\s]+?)\s*(?:por|por\s+apenas|por\s+só|por\s+somente)\s*R\$\s*([\d.,]+)/i);
    if (dePor) {
      const regular = parsePrice(dePor[1]);
      const promo = parsePrice(dePor[2]);
      if (promo) {
        const productName = cleanProductName(line.replace(dePor[0], "").trim());
        out.push({
          productName,
          promoPrice: promo,
          regularPrice: regular ?? undefined,
        });
        continue;
      }
    }

    // único preço na linha → nome é o texto antes do preço
    const prices = [...line.matchAll(/R\$\s*([\d.,]+)/gi)].map((m) => m.index ?? 0);
    if (prices.length === 1) {
      const idx = prices[0];
      const promo = parsePrice(line.slice(idx).replace(/^R\$\s*/i, ""));
      if (promo) {
        const productName = cleanProductName(line.slice(0, idx));
        if (productName.length >= 3) {
          out.push({ productName, promoPrice: promo });
        }
      }
      continue;
    }

    // múltiplos preços: último é o promocional (flyers listam oferta por último)
    if (prices.length >= 2) {
      const firstIdx = prices[prices.length - 2];
      const lastIdx = prices[prices.length - 1];
      const promo = parsePrice(line.slice(lastIdx).replace(/^R\$\s*/i, ""));
      const regular = parsePrice(line.slice(firstIdx).replace(/^R\$\s*/i, "").match(/([\d.,]+)/)?.[0] ?? "");
      const productName = cleanProductName(line.slice(0, firstIdx));
      if (promo && productName.length >= 3) {
        out.push({ productName, promoPrice: promo, regularPrice: regular });
      }
    }
  }

  // remove duplicados por (nome, preço)
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${normalize(p.productName)}|${p.promoPrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Aplica match de estabelecimento + preço regular nos promos.
// Também remove o nome do estabelecimento (quando identificado) do nome do
// produto, para evitar prefixos como "MERCADO BOM PREÇO: Óleo de Soja".
export function enrichParsedPromos(
  promos: ParsedPromo[],
  text: string,
  hint?: string
): ParsedPromo[] {
  const establishments = EstablishmentRepository.getAll();
  return promos.map((p) => {
    const est = matchEstablishment(text || p.productName, hint, establishments);
    if (est) {
      p.establishmentId = est.id;
      p.establishmentName = est.name;
      p.productName = cleanProductName(
        p.productName.replace(new RegExp(est.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
      );
    }
    if (p.regularPrice && p.promoPrice < p.regularPrice) {
      p.discountPct = Math.round(((p.regularPrice - p.promoPrice) / p.regularPrice) * 100);
    }
    return p;
  });
}

// ---------------------------------------------------------------------------
// Enriquecimento com Gemini (opcional) — quando não há API key, retorna o
// resultado determinístico sem alterações.
// ---------------------------------------------------------------------------

export function buildSocialParsePrompt(text: string): string {
  return `Você é o núcleo SENTINEL de monitoramento social de preços.

Analise o texto abaixo (capturado de WhatsApp/Instagram) e extraia TODAS as promoções de supermercado/loja mencionadas.

REGRAS:
1. Para cada promoção retorne: productName (nome do produto), promoPrice (preço promocional), regularPrice (preço original, se citado), establishmentName (nome do estabelecimento, se citado).
2. Preços SEMPRE como número (ex: 23.90).
3. Ignore textos sem preço ou sem produto.
4. Retorne APENAS um JSON válido: array de objetos.

TEXTO:
"""${text.slice(0, 4000)}"""`;
}

export async function parsePromosFromTextWithAI(
  text: string,
  apiKey?: string,
  hint?: string
): Promise<{ promos: ParsedPromo[]; method: "gemini" | "deterministic" }> {
  let promos = parsePromosFromText(text);

  if (apiKey) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: buildSocialParsePrompt(text),
        config: { responseMimeType: "application/json" },
      });
      const parsed = JSON.parse(response.text || "[]");
      if (Array.isArray(parsed) && parsed.length > 0) {
        promos = parsed
          .map((p: any) => ({
            productName: String(p.productName || "").trim(),
            promoPrice: Number(p.promoPrice),
            regularPrice: p.regularPrice ? Number(p.regularPrice) : undefined,
            establishmentName: p.establishmentName ? String(p.establishmentName).trim() : undefined,
          }))
          .filter((p: any) => p.productName && p.promoPrice > 0);
      }
    } catch (err: any) {
      // fallback silencioso para o determinístico
    }
  }

  return { promos: enrichParsedPromos(promos, text, hint), method: apiKey ? "gemini" : "deterministic" };
}

// Dedup: não recadastra promoção ativa do mesmo produto no mesmo estabelecimento.
export function isDuplicatePromo(promo: ParsedPromo): boolean {
  if (!promo.establishmentId) return false;
  const existing = PromotionRepository.getAll({ activeOnly: true });
  const n = normalize(promo.productName);
  return existing.some(
    (e) =>
      e.establishmentId === promo.establishmentId &&
      normalize(e.productName) === n
  );
}
