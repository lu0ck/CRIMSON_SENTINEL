import { getDb } from "../database/db";
import type { Product } from "../types";
import {
  type ProductRow,
  type PriceHistoryRow,
  productRowToProduct,
} from "./types";

export const ProductRepository = {
  getAll(): Product[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM products").all() as ProductRow[];
    return rows.map((r) => {
      const history = db
        .prepare("SELECT * FROM price_history WHERE product_id = ? ORDER BY date")
        .all(r.id) as PriceHistoryRow[];
      return productRowToProduct(r, history);
    });
  },

  getByProfile(profileId: string): Product[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM products WHERE profile_id = ?")
      .all(profileId) as ProductRow[];
    return rows.map((r) => {
      const history = db
        .prepare("SELECT * FROM price_history WHERE product_id = ? ORDER BY date")
        .all(r.id) as PriceHistoryRow[];
      return productRowToProduct(r, history);
    });
  },

  getById(id: string): Product | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM products WHERE id = ?")
      .get(id) as ProductRow | undefined;
    if (!row) return undefined;
    const history = db
      .prepare("SELECT * FROM price_history WHERE product_id = ? ORDER BY date")
      .all(id) as PriceHistoryRow[];
    return productRowToProduct(row, history);
  },

  save(product: Product): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO products (id, url, name, current_price, previous_price, currency, available, image_url, last_updated, list_id, profile_id, target_price, last_scrape_method, comparison_results)
       VALUES (@id, @url, @name, @current_price, @previous_price, @currency, @available, @image_url, @last_updated, @list_id, @profile_id, @target_price, @last_scrape_method, @comparison_results)
       ON CONFLICT(id) DO UPDATE SET
         url=excluded.url, name=excluded.name, current_price=excluded.current_price,
         previous_price=excluded.previous_price, currency=excluded.currency,
         available=excluded.available, image_url=excluded.image_url,
         last_updated=excluded.last_updated, list_id=excluded.list_id,
         profile_id=excluded.profile_id, target_price=excluded.target_price,
         last_scrape_method=excluded.last_scrape_method,
         comparison_results=excluded.comparison_results`
    ).run({
      id: product.id,
      url: product.url,
      name: product.name,
      current_price: product.currentPrice,
      previous_price: product.previousPrice,
      currency: product.currency,
      available: product.available ? 1 : 0,
      image_url: product.imageUrl ?? null,
      last_updated: product.lastUpdated,
      list_id: product.listId || null,
      profile_id: product.profileId,
      target_price: product.targetPrice ?? null,
      last_scrape_method: product.lastScrapeMethod ?? null,
      comparison_results: product.comparisonResults
        ? JSON.stringify(product.comparisonResults)
        : null,
    });

    this.syncPriceHistory(product.id, product.priceHistory);
  },

  saveAll(products: Product[]): void {
    const db = getDb();
    const tx = db.transaction((items: Product[]) => {
      for (const p of items) this.save(p);
    });
    tx(products);
  },

  syncPriceHistory(productId: string, history: { date: string; price: number }[]): void {
    const db = getDb();
    db.prepare("DELETE FROM price_history WHERE product_id = ?").run(productId);
    const stmt = db.prepare(
      "INSERT INTO price_history (product_id, price, date) VALUES (?, ?, ?)"
    );
    for (const h of history) {
      stmt.run(productId, h.price, h.date);
    }
  },

  delete(id: string): void {
    const db = getDb();
    db.prepare("DELETE FROM products WHERE id = ?").run(id);
  },

  deleteAll(): void {
    const db = getDb();
    db.exec("DELETE FROM products");
    db.exec("DELETE FROM price_history");
  },
};
