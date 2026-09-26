// #55 — Casamento promoção ↔ item da lista de compras (módulo puro, sem
// repositórios — seguro para frontend, workers e testes).

import { normalizeText } from "./text";

const STOP = new Set([
  "de", "da", "do", "das", "dos", "para", "com", "e", "o", "a", "os", "as",
  "em", "no", "na", "nos", "nas", "por", "mais", "menos",
]);

/** Tokens significativos normalizados (sem acento, >2 letras, sem stopwords). */
export function promoTokens(s: string): string[] {
  return normalizeText(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * A promoção cobre o item quando TODOS os tokens do item aparecem no nome da
 * promoção (item "Leite Ninho" ⊆ promo "LEITE NINHO NINHO 400G") — ou o
 * inverso (promo curta dentro do nome longo do item).
 */
export function promoMatchesItem(promoName: string, itemName: string): boolean {
  const pt = promoTokens(promoName);
  const it = promoTokens(itemName);
  if (pt.length === 0 || it.length === 0) return false;
  const pset = new Set(pt);
  const iset = new Set(it);
  return it.every((w) => pset.has(w)) || pt.every((w) => iset.has(w));
}
