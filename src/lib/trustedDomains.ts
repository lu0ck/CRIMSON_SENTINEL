// Domínios confiáveis para comparação de preços (FASE 12).
// FONTE ÚNICA: usada pelo scanWorker (worker Compare) e pelos fallbacks
// síncronos do server.ts quando o Redis está offline. Lista alinhada com o
// system instruction do handleCompare (PROIBIDO Shopee/AliExpress).

export const TRUSTED_DOMAINS = [
  "mercadolivre.com.br",
  "amazon.com.br",
  "kabum.com.br",
  "pichau.com.br",
  "terabyteshop.com.br",
  "magazineluiza.com.br",
  "casasbahia.com.br",
  "pontofrio.com.br",
  "extra.com.br",
  "fastshop.com.br",
  "girafa.com.br",
  "carrefour.com.br",
  "americanas.com.br",
];

// Prefixos curtos que casam com o hostname (ex: "amazon.com.br" → "amzon",
// que era usado no filtro antigo). Mantidos por compatibilidade com a checagem
// via `host.includes(t)`.
export const TRUSTED_HOST_MATCHERS = [
  "mercadolivre",
  "mercadolivre.com.br",
  "amazon",
  "amazon.com.br",
  "magazineluiza",
  "magalu",
  "kabum",
  "terabyteshop",
  "terabyte",
  "pichau",
  "casasbahia",
  "casas bahia",
  "pontofrio",
  "extra",
  "americanas",
  "americanas.com.br",
  "fastshop",
  "girafa",
  "carrefour",
];

// Verifica se um hostname pertence a um domínio confiável.
export function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TRUSTED_HOST_MATCHERS.some((t) => host.includes(t));
}