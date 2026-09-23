import { getDb } from "../database/db";
import type { Establishment } from "../types";
import {
  type EstablishmentRow,
  establishmentRowToEstablishment,
} from "./types";
import { normalizeText } from "../lib/text";

export const EstablishmentRepository = {
  getAll(): Establishment[] {
    const rows = getDb()
      .prepare("SELECT * FROM establishments ORDER BY name")
      .all() as EstablishmentRow[];
    return rows.map(establishmentRowToEstablishment);
  },

  getById(id: string): Establishment | undefined {
    const row = getDb()
      .prepare("SELECT * FROM establishments WHERE id = ?")
      .get(id) as EstablishmentRow | undefined;
    return row ? establishmentRowToEstablishment(row) : undefined;
  },

  getByIds(ids: string[]): Establishment[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(`SELECT * FROM establishments WHERE id IN (${placeholders})`)
      .all(...ids) as EstablishmentRow[];
    return rows.map(establishmentRowToEstablishment);
  },

  save(est: Establishment): void {
    getDb()
      .prepare(
        `INSERT INTO establishments (id, name, chain, category, lat, lng, address, city, state, postal_code, osm_id, price_url, source, whatsapp_number, instagram_handle)
         VALUES (@id, @name, @chain, @category, @lat, @lng, @address, @city, @state, @postal_code, @osm_id, @price_url, @source, @whatsapp_number, @instagram_handle)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, chain=excluded.chain, category=excluded.category,
           lat=excluded.lat, lng=excluded.lng, address=excluded.address,
           city=excluded.city, state=excluded.state, postal_code=excluded.postal_code,
           osm_id=excluded.osm_id, price_url=excluded.price_url,
           source=excluded.source, whatsapp_number=excluded.whatsapp_number,
           instagram_handle=excluded.instagram_handle`
      )
      .run({
        id: est.id,
        name: est.name,
        chain: est.chain ?? null,
        category: est.category ?? null,
        lat: est.lat,
        lng: est.lng,
        address: est.address ?? null,
        city: est.city ?? null,
        state: est.state ?? null,
        postal_code: est.postalCode ?? null,
        osm_id: est.osmId ?? null,
        price_url: est.priceUrl ?? null,
        source: est.source ?? "manual",
        whatsapp_number: est.whatsappNumber ?? null,
        instagram_handle: est.instagramHandle ?? null,
      });
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM establishments WHERE id = ?").run(id);
  },

  findDuplicatePairs(): DuplicatePair[] {
    const all = this.getAll();
    const pairs = new Map<string, DuplicatePair>();
    const put = (keep: Establishment, remove: Establishment, matchType: DuplicatePair["matchType"], reason: string) => {
      if (keep.id === remove.id) return;
      const [k, r] = keep.id < remove.id ? [keep, remove] : [remove, keep];
      const key = k.id + "::" + r.id;
      if (!pairs.has(key)) {
        pairs.set(key, {
          keepId: k.id,
          keepName: k.name,
          removeId: r.id,
          removeName: r.name,
          matchType,
          reason,
        });
      }
    };
    // 3 passadas de grupos; a 1ª que casar define o matchType mais forte (osm > whatsapp > name).
    const osmGroups = new Map<string, Establishment[]>();
    const waGroups = new Map<string, Establishment[]>();
    const nameGroups = new Map<string, Establishment[]>();
    for (const e of all) {
      if (e.osmId) osmGroups.set(String(e.osmId), [...(osmGroups.get(String(e.osmId)) ?? []), e]);
      if (e.whatsappNumber) {
        const digits = e.whatsappNumber.replace(/[^\d]/g, "");
        if (digits) waGroups.set(digits, [...(waGroups.get(digits) ?? []), e]);
      }
      const n = normalizeName(e.name);
      if (n) nameGroups.set(n, [...(nameGroups.get(n) ?? []), e]);
    }
    for (const [osmId, list] of osmGroups) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) put(list[i], list[j], "osm", `Mesmo OSM id (${osmId})`);
    }
    for (const [num, list] of waGroups) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) put(list[i], list[j], "whatsapp", `Mesmo WhatsApp (${num})`);
    }
    for (const [n, list] of nameGroups) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const keep = list[i];
        put(list[i], list[j], "name", `Mesmo nome: "${normalizeName(keep.name)}"`);
      }
    }
    return [...pairs.values()];
  },

  merge(keepId: string, removeIds: string[]): MergeResult {
    const db = getDb();
    if (!this.getById(keepId)) throw new Error("Estabelecimento a manter não encontrado");
    if (removeIds.includes(keepId)) throw new Error("keepId não pode estar em removeIds");
    if (removeIds.some((id) => !this.getById(id))) throw new Error("Estabelecimento a remover não encontrado");
    const placeholders = removeIds.map(() => "?").join(", ");
    const tx = db.transaction(() => {
      var repointedObservations = db
        .prepare(`UPDATE price_observations SET establishment_id = ? WHERE establishment_id IN (${placeholders})`)
        .run(keepId, ...removeIds).changes;
      var repointedPromotions = db
        .prepare(`UPDATE promotions SET establishment_id = ? WHERE establishment_id IN (${placeholders})`)
        .run(keepId, ...removeIds).changes;
      var repointedStops = db
        .prepare(`UPDATE route_stops SET establishment_id = ? WHERE establishment_id IN (${placeholders})`)
        .run(keepId, ...removeIds).changes;
      var deleted = db
        .prepare(`DELETE FROM establishments WHERE id IN (${placeholders})`)
        .run(...removeIds).changes;
      // Limpeza pós-mescla: remove duplicatas exatas que sobraram no alvo.
      var dedupedPromotions = db
        .prepare(`DELETE FROM promotions WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM promotions
          GROUP BY establishment_id, product_name, IFNULL(regular_price, ''), promo_price, currency, source
        )`).run().changes;
      var dedupedObservations = db
        .prepare(`DELETE FROM price_observations WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM price_observations
          GROUP BY establishment_id, shopping_list_item_id, product_id, price, currency, observed_at, source
        )`).run().changes;
      return { repointedObservations, repointedPromotions, repointedStops, deleted, dedupedPromotions, dedupedObservations };
    });
    return tx();
  },
};

function normalizeName(name: string): string {
  // #27 — delega para text.normalizeText (fonte única)
  return normalizeText(name ?? "");
}

export interface DuplicatePair {
  keepId: string;
  keepName: string;
  removeId: string;
  removeName: string;
  matchType: "name" | "osm" | "whatsapp";
  reason: string;
}

export interface MergeResult {
  repointedObservations: number;
  repointedPromotions: number;
  repointedStops: number;
  deleted: number;
  dedupedPromotions: number;
  dedupedObservations: number;
}
