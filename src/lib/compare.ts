import { isTrustedHost, TRUSTED_HOST_MATCHERS } from "./trustedDomains";

const TITLE_SIM_THRESHOLD = 0.4;

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[-\/|()[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const QUERY_STOPWORDS = new Set([
  "preto", "white", "branco", "black", "gamer",
  "sem", "com", "para", "fans", "vidro", "temperado",
  "atx", "e-atx", "mid", "tower", "miniatx", "matx", "full", "rgb", "argb",
  "pfc", "ativo", "modular", "certificado", "desktop", "servidor", "preco",
  "preço", "valor", "brasil", "lojas", "descricao", "descrição", "kit", "base",
  "usb", "hdmi", "dp", "display", "port", "serial", "paralela", "lan", "rede",
  "sem-fio", "wireless", "bluetooth", "wifi", "sata", "nvme", "pcie", "m.2",
]);

export function buildSearchQuery(productName: string): string {
  const cleaned = productName
    .replace(/[,\/\|()[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter((t) => t.length >= 3);

  const skus = tokens
    .filter(
      (t) => /\d/.test(t) && t.length >= 4 && !/^\d+[a-z]+$/i.test(t)
    )
    .sort((a, b) => b.length - a.length);

  const distinctive = tokens
    .filter((t) => !QUERY_STOPWORDS.has(t.toLowerCase()) && !/\d/.test(t))
    .sort((a, b) => b.length - a.length);

  let parts: string[] = [];
  parts.push(...distinctive.slice(0, 5));
  parts.push(...skus.slice(0, 3));
  parts = parts.slice(0, 8);

  if (parts.length === 0) {
    parts = tokens.slice(0, 8);
  }

  return `${parts.join(" ")} preço brasil`.trim().slice(0, 120);
}

function titleSimilarity(a: string, b: string): number {
  const ta = new Set(
    normalize(a)
      .split(" ")
      .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t))
  );
  const tb = new Set(
    normalize(b)
      .split(" ")
      .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t))
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}

export function extractModelTokens(name: string): string[] {
  return [
    ...new Set(
      normalize(name)
        .split(" ")
        .filter(
          (t) =>
            t.length >= 4 &&
            /[a-z]/.test(t) &&
            /\d/.test(t) &&
            !/^\d+[a-z]+$/i.test(t)
        )
    ),
  ];
}

function getCategoryKeywords(productName: string): string[] {
  const categoryMap: Record<string, string[]> = {
    gabinete: ["gabinete", "case", "mid-tower", "full-tower", "mini-itx"],
    fonte: ["fonte", "power supply", "psu", "atx"],
    processador: ["processador", "cpu", "xeon", "ryzen", "core", "i3", "i5", "i7", "i9", "athlon"],
    placa: ["placa", "gpu", "rtx", "gtx", "radeon", "rx"],
  };

  const norm = productName.toLowerCase();
  for (const [key, keywords] of Object.entries(categoryMap)) {
    if (norm.includes(key) || keywords.some((k) => norm.includes(k))) {
      return [key, ...keywords.filter((k) => norm.includes(k))];
    }
  }
  return [];
}

export function sameProduct(productName: string, pageTitle: string): boolean {
  if (!pageTitle) return false;
  const skus = extractModelTokens(productName);

  if (skus.length > 0) {
    if (!skus.every((s) => pageTitle.toLowerCase().includes(s))) return false;
    if (titleSimilarity(productName, pageTitle) < TITLE_SIM_THRESHOLD) return false;

    const category = getCategoryKeywords(productName);
    if (category.length > 0) {
      const pageNorm = pageTitle.toLowerCase();
      if (!category.some((c) => pageNorm.includes(c))) return false;
    }

    return true;
  }

  const tokens = normalize(productName)
    .split(" ")
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t) && !/\d/.test(t));

  const matchedTokens = tokens.filter((t) => pageTitle.toLowerCase().includes(t)).length;
  if (matchedTokens < 2) return false;
  return titleSimilarity(productName, pageTitle) >= 0.3;
}

export function isProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return isTrustedHost(u.hostname);
  } catch {
    return false;
  }
}

export function filterAndDedupe(
  results: Array<{ url: string; title: string; price: number }>,
  productName?: string
): Array<{ url: string; title: string; price: number }> {
  const seenUrl = new Set<string>();
  const out: Array<{ url: string; title: string; price: number }> = [];

  for (const r of results) {
    let keyUrl: string;
    try {
      const u = new URL(r.url);
      keyUrl = u.hostname + u.pathname;
    } catch {
      keyUrl = r.url;
    }
    if (seenUrl.has(keyUrl)) continue;

    if (productName && r.title && !sameProduct(productName, r.title)) {
      continue;
    }

    out.push(r);
    seenUrl.add(keyUrl);
  }

  return out;
}
