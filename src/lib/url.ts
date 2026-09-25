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
  // #48 — rastreio AliExpress (spm/scm): presença deles não muda a oferta
  "spm",
  "scm",
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

// #48 — chave de OFERTA: forma canônica + query LIMPA e ordenada.
// normalizeProductUrl descarta a query inteira (evita duplicar por tracking);
// aqui preservamos a query RELEVANTE para distinguir vendas/ofertas diferentes
// do mesmo produto (ex.: mesmo item AliExpress com outro vendedor na query).
// Mesma oferta com params em ordem diferente → mesma chave.
export function canonicalOfferUrl(url: string): string {
  try {
    const parsed = new URL(ensureHttps(url));
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = "";
    const pairs = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const query = pairs
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const base = normalizeProductUrl(ensureHttps(url));
    return query ? `${base}?${query}` : base;
  } catch {
    return url;
  }
}

// #48 — sufixo estável p/ id de item de oferta separada (`${baseId}~${suffix}`).
export function hashOfferSuffix(url: string): string {
  const key = canonicalOfferUrl(url);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// #27 — helpers de URL ad-hoc unificados (antes em server.ts + scraper.ts).

/** Garante protocolo http(s); se ausente, prefixa https://. */
export function ensureHttps(url: string): string {
  const s = String(url ?? "").trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return "https://" + s;
}

/** Detecta URL de busca (não é página de produto). */
export function isSearchUrl(url: string): boolean {
  return /\/busca\/|\/search\?|\/s\?|q=|search=/i.test(url);
}
