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
  "preto", "white", "branco", "black", "gamer", "gabinete", "fonte",
  "processador", "placa", "sem", "com", "para", "fans", "vidro", "temperado",
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
  parts.push(...distinctive.slice(0, 3));
  parts.push(...skus.slice(0, 2));
  parts = parts.slice(0, 4);

  if (parts.length === 0) {
    parts = tokens.slice(0, 4);
  }

  return `${parts.join(" ")} preço brasil`.trim().slice(0, 90);
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

export function sameProduct(productName: string, pageTitle: string): boolean {
  const skus = extractModelTokens(productName);

  if (skus.length > 0) {
    return (
      skus.every((s) => pageTitle.toLowerCase().includes(s)) &&
      titleSimilarity(productName, pageTitle) >= TITLE_SIM_THRESHOLD
    );
  }

  const tokens = normalize(productName)
    .split(" ")
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t) && !/\d/.test(t));

  return (
    titleSimilarity(productName, pageTitle) >= TITLE_SIM_THRESHOLD &&
    tokens.filter((t) => pageTitle.toLowerCase().includes(t)).length >= 2
  );
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

    if (productName && out.length > 0 && !sameProduct(productName, r.title)) {
      continue;
    }

    out.push(r);
    seenUrl.add(keyUrl);
  }

  return out;
}
