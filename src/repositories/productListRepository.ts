import { getDb } from "../database/db";
import type { ProductList } from "../types";
import { type ProductListRow, productListRowToProductList } from "./types";

export const ProductListRepository = {
  getAll(): ProductList[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM product_lists").all() as ProductListRow[];
    return rows.map(productListRowToProductList);
  },

  getByProfile(profileId: string): ProductList[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM product_lists WHERE profile_id = ?")
      .all(profileId) as ProductListRow[];
    return rows.map(productListRowToProductList);
  },

  saveAll(lists: ProductList[]): void {
    const db = getDb();
    const tx = db.transaction((items: ProductList[]) => {
      const incomingIds = new Set(items.map((l) => l.id));
      const existing = db.prepare("SELECT id FROM product_lists").all() as { id: string }[];
      for (const row of existing) {
        if (!incomingIds.has(row.id)) {
          db.prepare("DELETE FROM product_lists WHERE id = ?").run(row.id);
        }
      }
      for (const l of items) {
        db.prepare(
          `INSERT INTO product_lists (id, name, description, profile_id, budget, created_at)
           VALUES (@id, @name, @description, @profile_id, @budget, @created_at)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, description=excluded.description,
             profile_id=excluded.profile_id, budget=excluded.budget`
        ).run({
          id: l.id,
          name: l.name,
          description: l.description ?? null,
          profile_id: l.profileId,
          budget: l.budget ?? null,
          created_at: l.createdAt,
        });
      }
    });
    tx(lists);
  },

  deleteAll(): void {
    const db = getDb();
    db.exec("DELETE FROM product_lists");
  },
};
