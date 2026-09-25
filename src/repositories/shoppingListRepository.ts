import { getDb } from "../database/db";
import type { ShoppingListItem } from "../types";
import { normalizeUnit } from "../lib/units";
import {
  type ShoppingListItemRow,
  shoppingListItemRowToShoppingListItem,
} from "./types";

export const DEFAULT_LIST_ID = "list-geral";

// #40 — ordem: alta → media → baixa → sem prioridade, depois nome
const PRIORITY_ORDER_SQL = `ORDER BY CASE priority
    WHEN 'alta' THEN 0
    WHEN 'media' THEN 1
    WHEN 'baixa' THEN 2
    ELSE 3
  END, name`;

// #45 — modos de ordenação da LISTA DE COMPRAS
export type ShoppingListSortBy =
  | "prioridade"
  | "preco_asc"
  | "preco_desc"
  | "az"
  | "za"
  | "manual";

export const SHOPPING_LIST_SORT_MODES: ShoppingListSortBy[] = [
  "prioridade",
  "preco_asc",
  "preco_desc",
  "az",
  "za",
  "manual",
];

export function normalizeSortBy(v: unknown): ShoppingListSortBy {
  const s = String(v ?? "").toLowerCase().trim();
  return (SHOPPING_LIST_SORT_MODES as string[]).includes(s)
    ? (s as ShoppingListSortBy)
    : "prioridade";
}

// Melhor preço observado (MIN de price_observations) — subquery por item
const BEST_PRICE_SUBQUERY = `(SELECT MIN(o.price) FROM price_observations o WHERE o.shopping_list_item_id = shopping_list_items.id)`;

function orderByFor(sortBy: ShoppingListSortBy): string {
  switch (sortBy) {
    // sem observação → fim da lista (NULL por último) em ambos os sentidos
    case "preco_asc":
      return `ORDER BY ${BEST_PRICE_SUBQUERY} IS NULL, ${BEST_PRICE_SUBQUERY} ASC, name`;
    case "preco_desc":
      return `ORDER BY ${BEST_PRICE_SUBQUERY} IS NULL, ${BEST_PRICE_SUBQUERY} DESC, name`;
    case "az":
      return "ORDER BY name COLLATE NOCASE ASC";
    case "za":
      return "ORDER BY name COLLATE NOCASE DESC";
    case "manual":
      return "ORDER BY (sort_order IS NULL), sort_order ASC, name";
    default:
      return PRIORITY_ORDER_SQL;
  }
}

export type ShoppingListPriority = "alta" | "media" | "baixa";

export function normalizePriority(
  v: unknown
): ShoppingListPriority | null {
  const p = String(v ?? "").toLowerCase().trim();
  if (p === "alta" || p === "media" || p === "baixa") return p;
  // aliases comuns em import CSV
  if (p === "high" || p === "alta") return "alta";
  if (p === "medium" || p === "media" || p === "média") return "media";
  if (p === "low" || p === "baixa") return "baixa";
  return null;
}

export const ShoppingListRepository = {
  getAll(listId?: string, sortBy: ShoppingListSortBy = "prioridade"): ShoppingListItem[] {
    const db = getDb();
    const order = orderByFor(sortBy);
    const rows = (
      listId
        ? db
            .prepare(
              `SELECT * FROM shopping_list_items WHERE list_id = ? ${order}`
            )
            .all(listId)
        : db.prepare(`SELECT * FROM shopping_list_items ${order}`).all()
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
    const db = getDb();
    const listId = item.listId || DEFAULT_LIST_ID;
    // #45 — item existente mantém a posição manual (COALESCE); item novo entra no fim
    const existing = db
      .prepare("SELECT sort_order FROM shopping_list_items WHERE id = ?")
      .get(item.id) as { sort_order: number | null } | undefined;
    let sortOrder: number | null = null;
    if (item.sortOrder !== undefined && item.sortOrder !== null) {
      sortOrder = item.sortOrder;
    } else if (existing) {
      sortOrder = existing.sort_order;
    } else {
      const max = db
        .prepare(
          "SELECT MAX(sort_order) AS m FROM shopping_list_items WHERE list_id = ?"
        )
        .get(listId) as { m: number | null };
      sortOrder = max && max.m !== null ? max.m + 1 : 0;
    }
    db.prepare(
      `INSERT INTO shopping_list_items (id, name, quantity, unit, category, checked, target_price, product_id, list_id, priority, sort_order)
       VALUES (@id, @name, @quantity, @unit, @category, @checked, @target_price, @product_id, @list_id, @priority, @sort_order)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, quantity=excluded.quantity, unit=excluded.unit,
         category=excluded.category, checked=excluded.checked,
         target_price=excluded.target_price, product_id=excluded.product_id,
         list_id=excluded.list_id, priority=excluded.priority,
         sort_order=COALESCE(excluded.sort_order, shopping_list_items.sort_order)`
    ).run({
      id: item.id,
      name: item.name,
      quantity: item.quantity ?? 1,
      unit: normalizeUnit(item.unit) ?? null,
      category: item.category ?? null,
      checked: item.checked ? 1 : 0,
      target_price: item.targetPrice ?? null,
      product_id: item.productId ?? null,
      list_id: listId,
      priority: normalizePriority(item.priority),
      sort_order: sortOrder,
    });
  },

  // #45 — grava a "ordem de compra": sort_order = índice da sequência enviada
  reorder(listId: string, ids: string[]): number {
    const db = getDb();
    const tx = db.transaction(() => {
      const stmt = db.prepare(
        "UPDATE shopping_list_items SET sort_order = ? WHERE id = ? AND list_id = ?"
      );
      let n = 0;
      ids.forEach((id, idx) => {
        n += stmt.run(idx, id, listId).changes;
      });
      return n;
    });
    return tx();
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
