import { getDb } from "../database/db";
import type { Establishment } from "../types";
import {
  type EstablishmentRow,
  establishmentRowToEstablishment,
} from "./types";

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
};
