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

  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

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
