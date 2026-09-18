import { getDb } from "../database/db";

export interface Trigger {
  id: string;
  name: string;
  entityType: "product" | "keyword" | "promo";
  condition: "price_lte" | "price_drop_pct" | "contains" | "new_promo";
  value: string;
  channels: string;
  enabled: boolean;
  lastFiredAt?: string;
  createdAt: string;
}

interface TriggerRow {
  id: string;
  name: string;
  entity_type: string;
  condition: string;
  value: string;
  channels: string;
  enabled: number;
  last_fired_at: string | null;
  created_at: string;
}

function rowToTrigger(row: TriggerRow): Trigger {
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type as Trigger["entityType"],
    condition: row.condition as Trigger["condition"],
    value: row.value,
    channels: row.channels,
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at ?? undefined,
    createdAt: row.created_at,
  };
}

export const TriggerRepository = {
  getAll(enabledOnly = false): Trigger[] {
    const sql = enabledOnly
      ? "SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at DESC"
      : "SELECT * FROM triggers ORDER BY created_at DESC";
    const rows = getDb().prepare(sql).all() as TriggerRow[];
    return rows.map(rowToTrigger);
  },

  getById(id: string): Trigger | undefined {
    const row = getDb()
      .prepare("SELECT * FROM triggers WHERE id = ?")
      .get(id) as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  },

  save(trigger: Trigger): void {
    getDb()
      .prepare(
        `INSERT INTO triggers (id, name, entity_type, condition, value, channels, enabled, last_fired_at, created_at)
         VALUES (@id, @name, @entity_type, @condition, @value, @channels, @enabled, @last_fired_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, entity_type=excluded.entity_type, condition=excluded.condition,
           value=excluded.value, channels=excluded.channels, enabled=excluded.enabled,
           last_fired_at=excluded.last_fired_at`
      )
      .run({
        id: trigger.id,
        name: trigger.name,
        entity_type: trigger.entityType,
        condition: trigger.condition,
        value: trigger.value,
        channels: trigger.channels,
        enabled: trigger.enabled ? 1 : 0,
        last_fired_at: trigger.lastFiredAt ?? null,
        created_at: trigger.createdAt,
      });
  },

  setLastFired(id: string): void {
    getDb()
      .prepare("UPDATE triggers SET last_fired_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM triggers WHERE id = ?").run(id);
  },

  logFire(triggerId: string, entityId?: string, matchedValue?: string): void {
    getDb()
      .prepare(
        "INSERT INTO trigger_fire_log (trigger_id, entity_id, matched_value) VALUES (?, ?, ?)"
      )
      .run(triggerId, entityId ?? null, matchedValue ?? null);
  },

  hasFiredRecently(triggerId: string, cooldownMs: number): boolean {
    const row = getDb()
      .prepare("SELECT last_fired_at FROM triggers WHERE id = ?")
      .get(triggerId) as { last_fired_at: string | null } | undefined;
    if (!row?.last_fired_at) return false;
    return Date.now() - new Date(row.last_fired_at).getTime() < cooldownMs;
  },
};
