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
  "gamer",
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

  // #51 — antes: ordenava por TAMANHO de palavra → sopa
  // ("Térmica Console Pasta Cinza Cpu Gd900 preço brasil").
  // Agora: ordem natural do nome, mantendo SKUs/códigos de modelo mesmo que
  // fiquem fora do corte das 7 primeiras palavras significativas.
  const meaningful = tokens.filter((t) => !QUERY_STOPWORDS.has(t.toLowerCase()));
  const isSku = (t: string) => /\d/.test(t) && /[a-z]/i.test(t) && t.length >= 4;

  let parts = meaningful.slice(0, 7);
  const extraSkus = meaningful.filter((t) => isSku(t) && !parts.includes(t)).slice(0, 3);
  parts = [...parts, ...extraSkus].slice(0, 10);

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
    cooler: ["cooler", "ventilador", "watercooler", "aio", "heatsink", "散热器"],
    monitor: ["monitor", "tela", "display"],
  };

  const norm = productName.toLowerCase();
  for (const [key, keywords] of Object.entries(categoryMap)) {
    if (norm.includes(key) || keywords.some((k) => norm.includes(k))) {
      return [key, ...keywords.filter((k) => norm.includes(k))];
    }
  }
  return [];
}

function extractSpecs(productName: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const norm = productName.toLowerCase();

  // Fontes: wattage, certificação, modularidade
  const wattMatch = norm.match(/(\d{3,4})\s*w/i);
  if (wattMatch) specs.wattage = wattMatch[1] + "w";

  if (norm.includes("80 plus gold") || norm.includes("80 gold")) specs.certification = "80 plus gold";
  else if (norm.includes("80 plus bronze") || norm.includes("80 bronze")) specs.certification = "80 plus bronze";
  else if (norm.includes("80 plus platinum") || norm.includes("80 platinum")) specs.certification = "80 plus platinum";
  else if (norm.includes("80 plus") || norm.includes("80plus")) specs.certification = "80 plus";

  if (norm.includes("modular")) specs.modular = "modular";
  else if (norm.includes("semi-modular") || norm.includes("semi modular")) specs.modular = "semi-modular";
  else if (norm.includes("não modular") || norm.includes("nao modular") || norm.includes("fixed")) specs.modular = "fixed";

  // Gabinetes: formato
  if (norm.includes("e-atx") || norm.includes("eatx")) specs.formFactor = "e-atx";
  else if (norm.includes("atx")) specs.formFactor = "atx";
  else if (norm.includes("matx") || norm.includes("micro-atx") || norm.includes("micro atx")) specs.formFactor = "matx";
  else if (norm.includes("itx") || norm.includes("mini-itx") || norm.includes("mini itx")) specs.formFactor = "itx";

  // Processadores: socket, geração
  const socketMatch = norm.match(/(am[45]|lga\s*\d{4}|socket\s*\d+)/i);
  if (socketMatch) specs.socket = socketMatch[1].toLowerCase().replace(/\s/g, "");

  // Placas de vídeo: modelo GPU, VRAM
  const gpuMatch = norm.match(/(rtx|gtx|radeon|rx)\s*(\d{4}\s*(?:ti|super)?)\s*(\d+)\s*gb/i);
  if (gpuMatch) {
    specs.gpu = gpuMatch[1].toLowerCase() + " " + gpuMatch[2].toLowerCase();
    specs.vram = gpuMatch[3] + "gb";
  }

  // Coolers: socket, TDP, tamanho
  if (norm.includes("cooler") || norm.includes("ventilador") || norm.includes("watercooler") || norm.includes("aio")) {
    const coolerSocketMatch = norm.match(/(lga\s*\d{4}|am[45]|socket\s*\d+)/i);
    if (coolerSocketMatch) specs.coolerSocket = coolerSocketMatch[1].toLowerCase().replace(/\s/g, "");

    const tdpMatch = norm.match(/tdp\s*(\d+)/i);
    if (tdpMatch) specs.tdp = tdpMatch[1];

    const sizeMatch = norm.match(/\b(\d{3,4})\s*mm\b/i);
    if (sizeMatch) specs.fanSize = sizeMatch[1] + "mm";
  }

  return specs;
}

function specsMatch(specsA: Record<string, string>, specsB: Record<string, string>): boolean {
  const keys = ["wattage", "certification", "formFactor", "socket", "gpu", "coolerSocket", "tdp", "fanSize"];
  let matchCount = 0;
  let totalCompare = 0;

  for (const key of keys) {
    if (specsA[key] && specsB[key]) {
      totalCompare++;
      if (specsA[key] === specsB[key]) matchCount++;
    }
  }

  // Se ambas têm specs comparáveis, TODAS devem coincidir
  if (totalCompare >= 1) return matchCount === totalCompare;
  return false;
}

export function sameProduct(productName: string, pageTitle: string): boolean {
  if (!pageTitle) return false;
  const skus = extractModelTokens(productName);

  if (skus.length > 0) {
    const normalizedTitle = pageTitle.toLowerCase().replace(/[-\s]/g, '');
    if (!skus.every((s) => normalizedTitle.includes(s.toLowerCase()))) return false;
    if (titleSimilarity(productName, pageTitle) < TITLE_SIM_THRESHOLD) return false;

    const category = getCategoryKeywords(productName);
    if (category.length > 0) {
      const pageNorm = pageTitle.toLowerCase();
      if (!category.some((c) => pageNorm.includes(c))) return false;
    }

    return true;
  }

  // Fallback: match por specs (mesma categoria, mesmas especificações)
  const specsA = extractSpecs(productName);
  const specsB = extractSpecs(pageTitle);
  const categoryA = getCategoryKeywords(productName);
  const categoryB = getCategoryKeywords(pageTitle);

  // Se ambos têm a mesma categoria e specs compatíveis, aceitar
  if (categoryA.length > 0 && categoryB.length > 0) {
    const sameCategory = categoryA.some(c => categoryB.includes(c));
    if (sameCategory && specsMatch(specsA, specsB)) {
      return true;
    }
  }

  const tokens = normalize(productName)
    .split(" ")
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t) && !/\d/.test(t));

  const matchedTokens = tokens.filter((t) => pageTitle.toLowerCase().includes(t)).length;
  if (matchedTokens < 2) return false;

  // Se não tem specs nem model tokens, ser mais rigoroso (0.5 em vez de 0.3)
  const hasSpecs = Object.keys(specsA).length > 0 || Object.keys(specsB).length > 0;
  const threshold = hasSpecs ? 0.3 : 0.5;
  return titleSimilarity(productName, pageTitle) >= threshold;
}

// #46 — URL precisa ser a PÁGINA DIRETA do produto, não catálogo/busca/loja.
// Host confiável não basta (ex.: aliexpress.com/ , amazon.com.br/s?).
export function isProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!isTrustedHost(u.hostname)) return false;
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const qs = u.search.toLowerCase();

    // Home / raiz nunca é produto
    if (path === "/" || path === "") return false;

    // Parâmetros clássicos de busca → nunca produto
    if (/[?&](q|query|search|searchtext|keyword|field-keywords|k|s)=/.test(qs)) {
      return false;
    }

    // Caminhos de busca/catálogo/loja/oferta → nunca produto
    if (
      /\/(busca|search|categoria|category|collections?|ofertas|promocoes|wholesale|store|loja|lista|best-sellers|deal)(\/|$)/.test(path)
    ) {
      return false;
    }

    // AliExpress: exige /item/, /i/ ou /p/ (URLs diretas)
    if (/(^|\.)aliexpress\.com$/.test(host)) {
      return /\/(item|i|p)(\/|$)/.test(path);
    }

    // Amazon: exige /dp/, /gp/product/ ou /gp/aw/d/ (rejeita /s, /b, home)
    if (/(^|\.)amazon\./.test(host)) {
      return /\/(dp|gp\/product|gp\/aw\/d)(\/|$)/.test(path);
    }

    // Shopee: slug-i.sellerid.itemid ou /product/<id>/<id>
    if (/(^|\.)shopee\./.test(host)) {
      return /-i\.\d+\.\d+/.test(path) || /\/product\/\d+(\/\d+)?/.test(path);
    }

    // Mercado Livre: MLB-123456, MLB123456, /slug/p/MLB... ou /p/ — lista.* rejeitado
    if (/(^|\.)mercadolivre\./.test(host)) {
      return /\/(mlb|mpe|mco|mla|mlc|mlu)-?\d+/.test(path) || path.includes("/p/");
    }

    return true;
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
