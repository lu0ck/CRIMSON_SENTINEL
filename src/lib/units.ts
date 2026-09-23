// Unidades canônicas da lista de compras (#23).

export const ITEM_UNITS = ["KG", "MG", "G", "L", "ML", "UN"] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

// Normaliza texto livre para a unidade canônica (uppercase).
// Valores desconhecidos ou vazios → undefined (repo grava NULL).
export function normalizeUnit(raw?: string | null): ItemUnit | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toUpperCase();
  return (ITEM_UNITS as readonly string[]).includes(key) ? (key as ItemUnit) : undefined;
}
