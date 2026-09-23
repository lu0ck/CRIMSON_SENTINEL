// Preço BRL — FONTE ÚNICA DE VERDADE (#27).
// Antes da #27, isValidPrice/sanitizePrice/isScientificNotation viviam em
// scraper.ts e parseBrazilianPrice existia DUPLICADO (quase-idêntico) em
// scraper.ts e store-handlers.ts, com divergências em edge cases de 2 partes.

const MAX_PRICE = 10_000_000;

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

/**
 * "R$ 1.234,56" / "1.234,56" / "1234.56" / "1234" → número (0 se inválido).
 * Variante canônica: lógica de 2 partes do scraper (inclui `!hasDot && hasComma`)
 * + validação isValidPrice no parse multi-casas.
 */
export function parseBrazilianPrice(text: string): number {
  if (!text) return 0;

  if (isScientificNotation(text)) {
    console.warn("[PriceParser] Scientific notation detected, rejecting:", text);
    return 0;
  }

  const cleaned = text.replace(/[^\d.,]/g, "");
  if (!cleaned) return 0;

  const parts = cleaned.split(/[.,]/).filter((p) => p);
  if (parts.length === 0) return 0;
  if (parts.length === 1) return sanitizePrice(parseFloat(parts[0]) || 0);

  if (parts.length === 2) {
    const hasCommaDecimal =
      text.includes(",") && text.lastIndexOf(",") > text.lastIndexOf(".");
    if (hasCommaDecimal || (!text.includes(".") && text.includes(","))) {
      return sanitizePrice(parseFloat(parts[0]) + parseFloat(parts[1]) / 100);
    }
    return sanitizePrice(parseFloat(parts[0] + "." + parts[1]) || 0);
  }

  // 3+ partes: últimas 2 são centavos se houver vírgula após ponto (BR),
  // senão trata o último segmento como centavos (ex: 1.234.567,89).
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (hasComma && hasDot && lastComma > lastDot) {
    const intPart = parts.slice(0, -2).join("");
    const centsWhole = parts[parts.length - 2];
    const centsFrac = parts[parts.length - 1];
    const result =
      parseFloat(intPart + centsWhole) + parseFloat(centsFrac) / 100;
    if (!isValidPrice(result)) {
      console.warn("[PriceParser] Invalid price parsed:", result, "from:", text);
      return 0;
    }
    return sanitizePrice(result);
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
