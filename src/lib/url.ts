// Normalização de URL e geração de ID de produto — FONTE ÚNICA DE VERDADE.
// Antes da FASE 3 esta lógica existia DUPLICADA em server.ts (backend) e
// App.tsx (frontend), com listas de tracking params divergentes (o frontend
// tinha gad_source/gad_campaignid e o backend não tinha `tag`/`th` da Amazon).
// Isso gerava IDs diferentes para a mesma URL dependendo de quem processava.
// Ambos os lados agora importam estas funções do mesmo módulo.

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "affiliate",
  "src",
  "source",
  "fbclid",
  "gclid",
  "msclkid",
  "cmp",
  "abtest",
  "promo",
  "category",
  "gad_source",
  "gad_campaignid",
  "gclid",
  "msclkid",
  "fbclid",
  // Parâmetros de rastreio de affiliate/loja
  "tag",
  "th",
  "psc",
  "smid",
  "smile",
  "linkCode",
];

const PRODUCT_ID_PATTERNS: { regex: RegExp; format: (m: RegExpMatchArray) => string }[] = [
  { regex: /\/produto\/(\d+)/, format: (m) => `/produto/${m[1]}` }, // Terabyte, Pichau
  { regex: /\/dp\/([A-Z0-9]+)/, format: (m) => `/dp/${m[1]}` }, // Amazon
  { regex: /\/MLB-(\d+)/, format: (m) => `/MLB-${m[1]}` }, // Mercado Livre
  { regex: /\/p\/([a-z0-9]+)/i, format: (m) => `/p/${m[1]}` }, // Magalu
  { regex: /\/product\/(\d+)/, format: (m) => `/product/${m[1]}` }, // Generic
  { regex: /\/(\d+)\/p/, format: (m) => `/${m[1]}/p` }, // Alternative
  { regex: /\/sku\/([A-Z0-9]+)/i, format: (m) => `/sku/${m[1]}` }, // Kabum
];

// Forma canônica: origem + caminho canônico do produto, SEM query string e SEM
// hash. A query é totalmente descartada porque qualquer parâmetro que sobreviva
// à limpeza de tracking (ex: `tag`/`th` da Amazon) criaria produtos duplicados.
export function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);

    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = "";

    for (const { regex, format } of PRODUCT_ID_PATTERNS) {
      const match = parsed.pathname.match(regex);
      if (match) {
        return `${parsed.origin}${format(match)}`;
      }
    }

    const cleanPath = parsed.pathname.replace(/\/$/, "") || "/";
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return url;
  }
}

export function generateProductId(url: string): string {
  const normalized = normalizeProductUrl(url);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
