import { getDb } from "../database/db";
import type { PromotionSite } from "../types";
import {
  type PromotionSiteRow,
  promotionSiteRowToPromotionSite,
} from "./types";

export const PromotionSiteRepository = {
  getAll(): PromotionSite[] {
    const rows = getDb()
      .prepare("SELECT * FROM promotion_sites ORDER BY name")
      .all() as PromotionSiteRow[];
    return rows.map(promotionSiteRowToPromotionSite);
  },

  getById(id: string): PromotionSite | undefined {
    const row = getDb()
      .prepare("SELECT * FROM promotion_sites WHERE id = ?")
      .get(id) as PromotionSiteRow | undefined;
    return row ? promotionSiteRowToPromotionSite(row) : undefined;
  },

  save(site: PromotionSite): void {
    getDb()
      .prepare(
        `INSERT INTO promotion_sites (id, name, url, category, enabled, last_checked_at, created_at)
         VALUES (@id, @name, @url, @category, @enabled, @last_checked_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, url=excluded.url, category=excluded.category,
           enabled=excluded.enabled, last_checked_at=excluded.last_checked_at`
      )
      .run({
        id: site.id,
        name: site.name,
        url: site.url,
        category: site.category ?? null,
        enabled: site.enabled !== false ? 1 : 0,
        last_checked_at: site.lastCheckedAt ?? null,
        created_at: site.createdAt || new Date().toISOString(),
      });
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM promotion_sites WHERE id = ?").run(id);
  },
};
