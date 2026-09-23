// Normalização de texto — FONTE ÚNICA DE VERDADE (#27).
// Antes da #27 a mesma regra (NFD, sem acentos, minúsculas) existia
// copiada em socialParse, localInsights, routeOptimizer e establishmentRepository.

/** Minúsculas, sem acentos, só a-z0-9 e espaços — para comparação/dedup. */
export function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "a,b , c" → ["a","b","c"] — canais de trigger, keywords, etc. */
export function splitCsv(value: string): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Slug curto seguro para IDs/filenames (ASCII, sem acentos). */
export function slugify(s: string): string {
  return normalizeText(s)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
}
