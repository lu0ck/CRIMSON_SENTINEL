import { getDb } from "../database/db";
import type { ShoppingListItem } from "../types";
import {
  type ShoppingListItemRow,
  shoppingListItemRowToShoppingListItem,
} from "./types";

export const ShoppingListRepository = {
  getAll(): ShoppingListItem[] {
    const rows = getDb()
      .prepare("SELECT * FROM shopping_list_items ORDER BY name")
      .all() as ShoppingListItemRow[];
    return rows.map(shoppingListItemRowToShoppingListItem);
  },

  getById(id: string): ShoppingListItem | undefined {
    const row = getDb()
      .prepare("SELECT * FROM shopping_list_items WHERE id = ?")
      .get(id) as ShoppingListItemRow | undefined;
    return row ? shoppingListItemRowToShoppingListItem(row) : undefined;
  },

  getByIds(ids: string[]): ShoppingListItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = getDb()
      .prepare(`SELECT * FROM shopping_list_items WHERE id IN (${placeholders})`)
      .all(...ids) as ShoppingListItemRow[];
    return rows.map(shoppingListItemRowToShoppingListItem);
  },

  save(item: ShoppingListItem): void {
    getDb()
      .prepare(
        `INSERT INTO shopping_list_items (id, name, quantity, unit, category, checked, target_price, product_id)
         VALUES (@id, @name, @quantity, @unit, @category, @checked, @target_price, @product_id)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, quantity=excluded.quantity, unit=excluded.unit,
           category=excluded.category, checked=excluded.checked,
           target_price=excluded.target_price, product_id=excluded.product_id`
      )
      .run({
        id: item.id,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit: item.unit ?? null,
        category: item.category ?? null,
        checked: item.checked ? 1 : 0,
        target_price: item.targetPrice ?? null,
        product_id: item.productId ?? null,
      });
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM shopping_list_items WHERE id = ?").run(id);
  },
};
