import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR =
  process.env.USER_DATA_PATH ||
  (process.env.NODE_ENV === "production" ? "/tmp" : path.resolve(__dirname, "../.."));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "crimson.db");

// Cache e cookies do scraper também vivem sob DATA_DIR (FASE 3), para o caminho
// não depender de process.cwd() do processo (api vs workers pm2 vs produção).
const CACHE_DIR = path.join(DATA_DIR, ".cache");
const COOKIE_DIR = path.join(DATA_DIR, ".cookies");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(COOKIE_DIR)) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("encoding = 'UTF-8'");

  // Migrações leves (FASE 11): tabelas existentes não ganham colunas novas via
  // CREATE TABLE IF NOT EXISTS, então aplicamos ALTER defensivo quando faltam.
  function ensureColumn(table: string, column: string, ddl: string): void {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`[db] migração: ${table}.${column} adicionada`);
    }
  }

  // #39 — pré-migração ANTES do schema: CREATE INDEX ... (list_id) em schema.sql
  // falha em bancos antigos se a coluna ainda não existir (CREATE TABLE IF NOT EXISTS
  // não altera tabela existente → getDb crashava com "no such column: list_id").
  const shoppingListItemsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shopping_list_items'")
    .get();
  if (shoppingListItemsExists) {
    ensureColumn("shopping_list_items", "product_id", "product_id TEXT");
    ensureColumn("shopping_list_items", "list_id", "list_id TEXT");
    db.prepare(
      `UPDATE shopping_list_items SET list_id = 'list-geral'
       WHERE list_id IS NULL OR list_id = ''`
    ).run();
  }

  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  // Migrações FASE 1 / A1 — colunas faltantes conforme plano original.
  // establishments: source (manual|discovered), contatos sociais
  ensureColumn("establishments", "price_url", "price_url TEXT");
  ensureColumn("establishments", "source", "source TEXT DEFAULT 'manual'");
  ensureColumn("establishments", "whatsapp_number", "whatsapp_number TEXT");
  ensureColumn("establishments", "instagram_handle", "instagram_handle TEXT");

  // price_observations: valid_until heurístico (FASE 5)
  ensureColumn("price_observations", "valid_until", "valid_until TEXT");

  // promotions: product_id (FK opcional), discount_pct, is_flash (FASE 6/8), expires_at distinto end_date
  ensureColumn("promotions", "product_id", "product_id TEXT");
  ensureColumn("promotions", "discount_pct", "discount_pct REAL");
  ensureColumn("promotions", "is_flash", "is_flash INTEGER DEFAULT 0");
  ensureColumn("promotions", "expires_at", "expires_at TEXT");

  // routes: vehicle_type, total_time_min, suggested_departure_at, travel_cost comcustível (FASE 7)
  ensureColumn("routes", "vehicle_type", "vehicle_type TEXT");
  ensureColumn("routes", "total_time_min", "total_time_min REAL");
  ensureColumn("routes", "suggested_departure_at", "suggested_departure_at TEXT");
  ensureColumn("routes", "travel_cost", "travel_cost REAL");
  ensureColumn("routes", "fuel_consumption_km_l", "fuel_consumption_km_l REAL");
  ensureColumn("routes", "fuel_price_per_l", "fuel_price_per_l REAL");

  // route_stops: arrival_time_estimate, quiet_score (FASE 7)
  ensureColumn("route_stops", "arrival_time_estimate", "arrival_time_estimate TEXT");
  ensureColumn("route_stops", "quiet_score", "quiet_score REAL");

  // shopping_list_items: FK opcional para products (FASE 5) + list_id (#36)
  // list_id/product_id já pré-migrados acima (#39) antes do CREATE INDEX no schema.
  ensureColumn("shopping_list_items", "product_id", "product_id TEXT");
  ensureColumn("shopping_list_items", "list_id", "list_id TEXT");
  // #40 — prioridade (alta|media|baixa|NULL). Sem índice (evita bug index-before-column #39).
  ensureColumn("shopping_list_items", "priority", "priority TEXT");
  // #45 — posição manual da "ordem de compra" (NULL = ainda não posicionada)
  ensureColumn("shopping_list_items", "sort_order", "sort_order INTEGER");
  // Seed + backfill: itens legados sem lista vão para "Geral"
  db.prepare(
    `UPDATE shopping_list_items SET list_id = 'list-geral'
     WHERE list_id IS NULL OR list_id = ''`
  ).run();

  // notification_log: details JSON para URLs/snippets (compare)
  ensureColumn("notification_log", "details", "details TEXT");

  // FASE 8+: habilitar social_monitoring por padrão em bancos antigos
  const smSetting = db.prepare("SELECT value FROM user_settings WHERE key = 'social_monitoring_enabled'").get() as { value: string } | undefined;
  if (smSetting && smSetting.value === "false") {
    db.prepare("UPDATE user_settings SET value = 'true' WHERE key = 'social_monitoring_enabled'").run();
    console.log("[db] migração: social_monitoring_enabled atualizado para true");
  }

  // FASE 12+ (analógico ao INSERT OR IGNORE do schema.sql): bancos antigos não
  // recebem as settings novas pelo CREATE TABLE IF NOT EXISTS — insere default.
  for (const [key, value] of [
    ["local_price_scan_interval_ms", "21600000"], // FASE 12: scan de preços locais (6h)
  ] as const) {
    db.prepare(
      `INSERT INTO user_settings (key, value, updated_at) SELECT ?, ?, datetime('now')
       WHERE NOT EXISTS (SELECT 1 FROM user_settings WHERE key = ?)`
    ).run(key, value, key);
  }

  dbInstance = db;

  console.log(`[db] SQLite inicializado: ${DB_PATH}`);
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log("[db] SQLite fechado");
  }
}

export { DB_PATH, DATA_DIR, CACHE_DIR, COOKIE_DIR };
