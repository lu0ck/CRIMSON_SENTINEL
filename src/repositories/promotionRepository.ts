import { getDb } from "../database/db";
import type { Promotion } from "../types";
import { type PromotionRow, promotionRowToPromotion } from "./types";

export const PromotionRepository = {
  getAll(filters?: {
    activeOnly?: boolean;
    establishmentId?: string;
    onlyFlash?: boolean;
    onlyActiveOrFlash?: boolean;
    orderBy?: "detected" | "discount";
  }): Promotion[] {
    let sql = "SELECT * FROM promotions";
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters?.activeOnly) {
      where.push("is_active = 1");
    }
    if (filters?.onlyFlash) {
      where.push("is_flash = 1");
    }
    // B3: catálogo de ativas = expires_at futuro OR end_date futuro OR is_flash=1 OR sem data (estimado)
    if (filters?.onlyActiveOrFlash) {
      where.push(
        "(is_flash = 1 OR (expires_at IS NOT NULL AND expires_at > datetime('now')) OR (end_date IS NOT NULL AND end_date > datetime('now')) OR (expires_at IS NULL AND end_date IS NULL))"
      );
    }
    if (filters?.establishmentId) {
      where.push("establishment_id = ?");
      params.push(filters.establishmentId);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    // B3: ordenação por desconto ( calculado se regular_price > 0) ou detected_at
    const orderBy = filters?.orderBy === "discount"
      ? "ORDER BY (CASE WHEN regular_price IS NOT NULL AND regular_price > 0 THEN (regular_price - promo_price) / regular_price ELSE 0 END) DESC, detected_at DESC"
      : "ORDER BY detected_at DESC";
    sql += " " + orderBy;
    const rows = getDb().prepare(sql).all(...params) as PromotionRow[];
    return rows.map(promotionRowToPromotion);
  },

  getById(id: string): Promotion | undefined {
    const row = getDb()
      .prepare("SELECT * FROM promotions WHERE id = ?")
      .get(id) as PromotionRow | undefined;
    return row ? promotionRowToPromotion(row) : undefined;
  },

  save(promo: Promotion): void {
    // B3: calcular discount_pct automaticamente se regularPrice existir
    const discountPct =
      promo.discountPct ??
      (promo.regularPrice && promo.regularPrice > 0
        ? ((promo.regularPrice - promo.promoPrice) / promo.regularPrice) * 100
        : null);
    getDb()
      .prepare(
        `INSERT INTO promotions (id, establishment_id, product_name, regular_price, promo_price, currency, start_date, end_date, source, source_url, raw_text, detected_at, is_active, product_id, discount_pct, is_flash, expires_at)
         VALUES (@id, @establishment_id, @product_name, @regular_price, @promo_price, @currency, @start_date, @end_date, @source, @source_url, @raw_text, @detected_at, @is_active, @product_id, @discount_pct, @is_flash, @expires_at)
         ON CONFLICT(id) DO UPDATE SET
           establishment_id=excluded.establishment_id, product_name=excluded.product_name,
           regular_price=excluded.regular_price, promo_price=excluded.promo_price,
           currency=excluded.currency, start_date=excluded.start_date, end_date=excluded.end_date,
           source=excluded.source, source_url=excluded.source_url, raw_text=excluded.raw_text,
           detected_at=excluded.detected_at, is_active=excluded.is_active,
           product_id=excluded.product_id, discount_pct=excluded.discount_pct,
           is_flash=excluded.is_flash, expires_at=excluded.expires_at`
      )
      .run({
        id: promo.id,
        establishment_id: promo.establishmentId,
        product_name: promo.productName,
        regular_price: promo.regularPrice ?? null,
        promo_price: promo.promoPrice,
        currency: promo.currency ?? "BRL",
        start_date: promo.startDate ?? null,
        end_date: promo.endDate ?? null,
        source: promo.source ?? "manual",
        source_url: promo.sourceUrl ?? null,
        raw_text: promo.rawText ?? null,
        detected_at: promo.detectedAt ?? new Date().toISOString(),
        is_active: promo.isActive === undefined || promo.isActive === null || promo.isActive ? 1 : 0,
        product_id: promo.productId ?? null,
        discount_pct: discountPct,
        is_flash: promo.isFlash ? 1 : 0,
        expires_at: promo.expiresAt ?? null,
      });
  },

  expire(id: string): void {
    getDb()
      .prepare("UPDATE promotions SET is_active = 0 WHERE id = ?")
      .run(id);
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM promotions WHERE id = ?").run(id);
  },
};
