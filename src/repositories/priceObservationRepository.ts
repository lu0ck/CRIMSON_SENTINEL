import { getDb } from "../database/db";
import type { PriceObservation } from "../types";
import {
  type PriceObservationRow,
  priceObservationRowToPriceObservation,
} from "./types";

export const PriceObservationRepository = {
  getAll(filters?: { shoppingListItemId?: string; establishmentId?: string; productId?: string }): PriceObservation[] {
    let sql = "SELECT * FROM price_observations";
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters?.shoppingListItemId) {
      where.push("shopping_list_item_id = ?");
      params.push(filters.shoppingListItemId);
    }
    if (filters?.establishmentId) {
      where.push("establishment_id = ?");
      params.push(filters.establishmentId);
    }
    if (filters?.productId) {
      where.push("product_id = ?");
      params.push(filters.productId);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY observed_at DESC";
    const rows = getDb().prepare(sql).all(...params) as PriceObservationRow[];
    return rows.map(priceObservationRowToPriceObservation);
  },

  create(obs: PriceObservation): PriceObservation {
    const info = getDb()
      .prepare(
        `INSERT INTO price_observations
          (shopping_list_item_id, product_id, establishment_id, price, currency, observed_at, source, notes, valid_until)
         VALUES (@shopping_list_item_id, @product_id, @establishment_id, @price, @currency, @observed_at, @source, @notes, @valid_until)`
      )
      .run({
        shopping_list_item_id: obs.shoppingListItemId ?? null,
        product_id: obs.productId ?? null,
        establishment_id: obs.establishmentId,
        price: obs.price,
        currency: obs.currency ?? "BRL",
        observed_at: obs.observedAt ?? new Date().toISOString(),
        source: obs.source ?? "manual",
        notes: obs.notes ?? null,
        valid_until: obs.validUntil ?? null,
      });
    return { ...obs, id: Number(info.lastInsertRowid) };
  },

  getByShoppingItems(itemsIds: string[]): PriceObservation[] {
    if (itemsIds.length === 0) return [];
    const placeholders = itemsIds.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(
        `SELECT * FROM price_observations WHERE shopping_list_item_id IN (${placeholders}) ORDER BY observed_at DESC`
      )
      .all(...itemsIds) as PriceObservationRow[];
    return rows.map(priceObservationRowToPriceObservation);
  },
};
