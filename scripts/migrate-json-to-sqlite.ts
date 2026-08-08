import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb, DB_PATH } from "../src/database/db";
import type { AppData } from "../src/types";
import { AppDataRepository } from "../src/repositories/appDataRepository";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findDataJson(): string {
  const candidates = [
    path.resolve(__dirname, "../data.json"),           // scripts/../data.json
    path.join(process.cwd(), "data.json"),             // cwd
    path.join(process.cwd(), "data", "data.json"),     // cwd/data
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const sourceFile = findDataJson();

if (!fs.existsSync(sourceFile)) {
  console.log("[migrate] Nenhum data.json encontrado. Nada a migrar.");
  process.exit(0);
}

console.log("[migrate] Lendo:", sourceFile);
const raw = fs.readFileSync(sourceFile, "utf-8");
const data = JSON.parse(raw) as AppData & { notifications?: unknown[] };

if (!data.profiles && !data.lists && !data.products) {
  console.log("[migrate] data.json vazio ou formato inválido. Nada a migrar.");
  process.exit(0);
}

const db = getDb();
console.log("[migrate] Banco:", DB_PATH);

const stats = {
  profiles: data.profiles?.length ?? 0,
  lists: data.lists?.length ?? 0,
  products: data.products?.length ?? 0,
};

const tx = db.transaction(() => {
  AppDataRepository.saveAll({
    profiles: data.profiles ?? [],
    lists: data.lists ?? [],
    products: data.products ?? [],
  });
});

tx();
console.log("[migrate] Migração completa:", JSON.stringify(stats));

const backupFile = `${sourceFile}.bak-${Date.now()}`;
fs.renameSync(sourceFile, backupFile);
console.log("[migrate] Backup do data.json original em:", backupFile);
