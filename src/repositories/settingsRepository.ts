import { getDb } from "../database/db";

export interface SettingEntry {
  key: string;
  value: string;
}

export const SettingsRepository = {
  get(key: string): string | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM user_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  },

  getNumber(key: string): number | undefined {
    const v = this.get(key);
    return v ? Number(v) : undefined;
  },

  getBool(key: string): boolean {
    const v = this.get(key);
    return v === "true" || v === "1";
  },

  set(key: string, value: string | number | boolean): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(key, String(value));
  },

  getAll(): Record<string, string> {
    const db = getDb();
    const rows = db
      .prepare("SELECT key, value FROM user_settings")
      .all() as SettingEntry[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
};
