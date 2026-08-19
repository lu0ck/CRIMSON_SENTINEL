import { lookupCep, type CepResult } from "./cep";

// Geo/OSRM helpers (FASE 5). Distâncias em km.

export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

// Matriz de distâncias (km) usando distância em linha reta. Determinística e
// offline — usado como fallback quando o OSRM não está acessível.
export function haversineMatrixKm(points: GeoPoint[]): number[][] {
  const n = points.length;
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      m[i][j] = haversineKm(points[i], points[j]);
    }
  }
  return m;
}

// Matriz de distâncias real via OSRM (rota dirigindo). Retorna null se o
// servidor falhar (offline, limite de pontos, etc.) para o caller usar o
// fallback haversine. Coordenadas vão em lng,lat para o OSRM.
export async function osrmDistanceMatrixKm(
  points: GeoPoint[],
  opts: { server?: string; timeoutMs?: number } = {}
): Promise<number[][] | null> {
  if (points.length < 2) return null;
  const server = opts.server ?? "https://router.project-osrm.org";
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${server}/table/v1/driving/${coords}?annotations=distance`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const distances: number[][] | undefined = data?.distances;
    if (!distances) return null;
    // OSRM retorna em metros; converte para km.
    return distances.map((row) => row.map((v) => (v === null ? Infinity : v / 1000)));
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// B4 — Matriz de distâncias (km) E durations (min) via OSRM. Durations usadas
// para cálculo de tempo total, suggested departure e arrival time por parada.
export async function osrmDistanceDurationMatrix(
  points: GeoPoint[],
  opts: { server?: string; timeoutMs?: number } = {}
): Promise<{ distancesKm: number[][]; durationsMin: number[][] } | null> {
  if (points.length < 2) return null;
  const server = opts.server ?? "https://router.project-osrm.org";
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${server}/table/v1/driving/${coords}?annotations=distance,duration`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const distances: number[][] | undefined = data?.distances;
    const durations: number[][] | undefined = data?.durations;
    if (!distances || !durations) return null;
    return {
      distancesKm: distances.map((row) => row.map((v) => (v === null ? Infinity : v / 1000))),
      durationsMin: durations.map((row) => row.map((v) => (v === null ? Infinity : v / 60))),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Tenta OSRM e cai para haversine em caso de falha.
export async function buildDistanceMatrixKm(points: GeoPoint[]): Promise<number[][]> {
  const osrm = await osrmDistanceMatrixKm(points);
  return osrm ?? haversineMatrixKm(points);
}

// ---- B1 — Geocoding (Nominatim) + Descoberta de estabelecimentos (Overpass) ----

// Nominatim: converte endereço textual em lat/lng. Respeitar política de uso
// (1 req/s, User-Agent identificando o projeto). Gratuito.
export async function geocodeAddress(
  address: string,
  opts: { timeoutMs?: number } = {}
): Promise<GeoPoint & { displayName?: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim exige User-Agent identificando o app.
        "User-Agent": "CrimsonSentinel/1.0 (price tracker, single-user personal use)",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const arr = await res.json() as any[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const r = arr[0];
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), displayName: r.display_name };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Overpass API: descobre estabelecimentos do tipo "shop|supermarket" dentro
// de um raio em metros a partir de um centro. Retorna.addItemc com osm_id e
// atributos para popular `establishments` com source='discovered'.
// Política Overpass: rate-limit leve; usar um servidor de mirror se possível.
export interface DiscoveredEstablishment {
  osmId: number;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  brand?: string;
}

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

export async function overpassDiscoverEstablishments(
  center: GeoPoint,
  radiusMeters: number,
  opts: { timeoutMs?: number } = {}
): Promise<DiscoveredEstablishment[]> {
  // Query: shops/supermarkets/markets no raio. Limitamos categorias relevantes
  // a um "rastreador de preços de mercado" — supermercados, mercearias, hortifruti.
  const query = `
    [out:json][timeout:25];
    (
      node["shop"~"supermarket|convenience|greengrocer|bakery|butcher|beverages|alcohol"](around:${radiusMeters},${center.lat},${center.lng});
      way["shop"~"supermarket|convenience|greengrocer|bakery|butcher|beverages|alcohol"](around:${radiusMeters},${center.lat},${center.lng});
      node["amenity"="marketplace"](around:${radiusMeters},${center.lat},${center.lng});
    );
    out center tags geom;
  `.trim();

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  for (const server of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(server, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const elements: any[] = data?.elements ?? [];
      const discovered: DiscoveredEstablishment[] = [];
      for (const el of elements) {
        const tags = el?.tags ?? {};
        const name = tags.name || tags.brand || "_sem_nome_";
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (typeof lat !== "number" || typeof lng !== "number") continue;
        const shopVal = tags.shop || tags.amenity || "other";
        const phone = tags.phone || tags["contact:phone"] || tags["contact:whatsapp"];
        discovered.push({
          osmId: el.id,
          name,
          category: shopVal,
          lat,
          lng,
          address: tags["addr:street"] ? `${tags["addr:street"]} ${tags["addr:housenumber"] || ""}`.trim() : undefined,
          city: tags["addr:city"],
          state: tags["addr:state"],
          postalCode: tags["addr:postcode"],
          phone,
          brand: tags.brand,
        });
      }
      return discovered;
    } catch {
      // Tenta próximo mirror.
    }
  }
  clearTimeout(t);
  return [];
}

// ViaCEP + Nominatim: busca CEP, monta endereço e geocodifica para lat/lng.
export async function geocodeFromCep(
  cep: string,
  opts: { timeoutMs?: number } = {}
): Promise<(GeoPoint & { address: string; city: string; state: string; postalCode: string }) | null> {
  const cepData = await lookupCep(cep, opts);
  if (!cepData) return null;
  const address = `${cepData.logradouro}, ${cepData.bairro}, ${cepData.localidade} - ${cepData.uf}`;
  const geo = await geocodeAddress(address, opts);
  if (!geo) return null;
  return {
    lat: geo.lat,
    lng: geo.lng,
    address: geo.displayName ?? address,
    city: cepData.localidade,
    state: cepData.uf,
    postalCode: cepData.cep,
  };
}
