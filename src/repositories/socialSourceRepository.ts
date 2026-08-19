import { getDb } from "../database/db";

export interface SocialSource {
  id: string;
  channel: "whatsapp" | "instagram";
  name: string;
  url?: string;
  establishmentHint?: string;
  enabled?: boolean;
  lastCheckedAt?: string;
  createdAt: string;
}

export interface SocialSourceRow {
  id: string;
  channel: "whatsapp" | "instagram";
  name: string;
  url: string | null;
  establishment_hint: string | null;
  enabled: number;
  last_checked_at: string | null;
  created_at: string;
}

export function socialSourceRowToSource(row: SocialSourceRow): SocialSource {
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    url: row.url ?? undefined,
    establishmentHint: row.establishment_hint ?? undefined,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
  };
}

export const SocialSourceRepository = {
  getAll(enabledOnly = false): SocialSource[] {
    const sql = enabledOnly
      ? "SELECT * FROM social_sources WHERE enabled = 1 ORDER BY name"
      : "SELECT * FROM social_sources ORDER BY name";
    const rows = getDb().prepare(sql).all() as SocialSourceRow[];
    return rows.map(socialSourceRowToSource);
  },

  getById(id: string): SocialSource | undefined {
    const row = getDb()
      .prepare("SELECT * FROM social_sources WHERE id = ?")
      .get(id) as SocialSourceRow | undefined;
    return row ? socialSourceRowToSource(row) : undefined;
  },

  save(source: SocialSource): void {
    getDb()
      .prepare(
        `INSERT INTO social_sources (id, channel, name, url, establishment_hint, enabled, last_checked_at, created_at)
         VALUES (@id, @channel, @name, @url, @establishment_hint, @enabled, @last_checked_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           channel=excluded.channel, name=excluded.name, url=excluded.url,
           establishment_hint=excluded.establishment_hint, enabled=excluded.enabled,
           last_checked_at=excluded.last_checked_at`
      )
      .run({
        id: source.id,
        channel: source.channel,
        name: source.name,
        url: source.url ?? null,
        establishment_hint: source.establishmentHint ?? null,
        enabled: source.enabled === false ? 0 : 1,
        last_checked_at: source.lastCheckedAt ?? null,
        created_at: source.createdAt ?? new Date().toISOString(),
      });
  },

  setLastChecked(id: string): void {
    getDb()
      .prepare(
        "UPDATE social_sources SET last_checked_at = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), id);
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM social_sources WHERE id = ?").run(id);
  },
};
