import { getDb } from "../database/db";
import type { ShoppingListItem } from "../types";
import { normalizeUnit } from "../lib/units";
import {
  type ShoppingListItemRow,
  shoppingListItemRowToShoppingListItem,
} from "./types";

export const DEFAULT_LIST_ID = "list-geral";

export const ShoppingListRepository = {
  getAll(listId?: string): ShoppingListItem[] {
    const db = getDb();
    const rows = (
      listId
        ? db
            .prepare(
              "SELECT * FROM shopping_list_items WHERE list_id = ? ORDER BY name"
            )
            .all(listId)
        : db.prepare("SELECT * FROM shopping_list_items ORDER BY name").all()
    ) as ShoppingListItemRow[];
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
        `INSERT INTO shopping_list_items (id, name, quantity, unit, category, checked, target_price, product_id, list_id)
         VALUES (@id, @name, @quantity, @unit, @category, @checked, @target_price, @product_id, @list_id)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, quantity=excluded.quantity, unit=excluded.unit,
           category=excluded.category, checked=excluded.checked,
           target_price=excluded.target_price, product_id=excluded.product_id,
           list_id=excluded.list_id`
      )
      .run({
        id: item.id,
        name: item.name,
        quantity: item.quantity ?? 1,
        unit: normalizeUnit(item.unit) ?? null,
        category: item.category ?? null,
        checked: item.checked ? 1 : 0,
        target_price: item.targetPrice ?? null,
        product_id: item.productId ?? null,
        list_id: item.listId || DEFAULT_LIST_ID,
      });
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM shopping_list_items WHERE id = ?").run(id);
  },

  deleteByList(listId: string): number {
    const r = getDb()
      .prepare("DELETE FROM shopping_list_items WHERE list_id = ?")
      .run(listId);
    return r.changes;
  },
};

// ---- Listas nomeadas (#36) ------------------------------------------------
export interface ShoppingListRow {
  id: string;
  name: string;
  created_at: string;
}

export const ShoppingListsRepository = {
  getAll(): { id: string; name: string; createdAt?: string }[] {
    const rows = getDb()
      .prepare("SELECT * FROM shopping_lists ORDER BY name")
      .all() as ShoppingListRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
    }));
  },

  getById(id: string) {
    const row = getDb()
      .prepare("SELECT * FROM shopping_lists WHERE id = ?")
      .get(id) as ShoppingListRow | undefined;
    return row
      ? { id: row.id, name: row.name, createdAt: row.created_at }
      : undefined;
  },

  save(list: { id?: string; name: string }) {
    const id =
      list.id ||
      `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = list.name.trim();
    if (!name) throw new Error("nome da lista vazio");
    getDb()
      .prepare(
        `INSERT INTO shopping_lists (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name`
      )
      .run(id, name);
    return this.getById(id)!;
  },

  delete(id: string): void {
    // Itens vão junto (apaga lista aberta inteira)
    ShoppingListRepository.deleteByList(id);
    getDb().prepare("DELETE FROM shopping_lists WHERE id = ?").run(id);
  },
};
