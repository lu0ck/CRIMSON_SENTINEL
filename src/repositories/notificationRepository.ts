import { getDb } from "../database/db";

export interface NotificationLogEntry {
  id: number;
  entityType: string;
  entityId: string;
  channel: string;
  title: string;
  message: string;
  details?: string | null;
  sentAt: string;
}

export interface NotificationLogRow {
  id: number;
  entity_type: string;
  entity_id: string;
  channel: string;
  title: string;
  message: string;
  details: string | null;
  sent_at: string;
}

function rowToEntry(row: NotificationLogRow): NotificationLogEntry {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    channel: row.channel,
    title: row.title,
    message: row.message,
    details: row.details ?? null,
    sentAt: row.sent_at,
  };
}

export const NotificationRepository = {
  // Um alerta para (entityType, entityId) já foi enviado dentro do cooldown?
  hasSentWithin(entityType: string, entityId: string, cooldownHours: number): boolean {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT 1 FROM notification_log
         WHERE entity_type = ? AND entity_id = ?
           AND sent_at >= datetime('now', ?)
         LIMIT 1`
      )
      .get(entityType, entityId, `-${cooldownHours} hours`) as { 1: number } | undefined;
    return !!row;
  },

  record(entry: Omit<NotificationLogEntry, "id" | "sentAt">): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO notification_log (entity_type, entity_id, channel, title, message, details)
       VALUES (@entity_type, @entity_id, @channel, @title, @message, @details)`
    ).run({
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      channel: entry.channel,
      title: entry.title,
      message: entry.message,
      details: entry.details ?? null,
    });
  },

  getAll(limit = 50): NotificationLogEntry[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM notification_log ORDER BY id DESC LIMIT ?")
      .all(limit) as NotificationLogRow[];
    return rows.map(rowToEntry);
  },

  getByProfile(profileId: string, limit = 50): NotificationLogEntry[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT n.* FROM notification_log n
         INNER JOIN products p ON n.entity_id = p.id
         WHERE p.profile_id = ?
         ORDER BY n.id DESC LIMIT ?`
      )
      .all(profileId, limit) as NotificationLogRow[];
    return rows.map(rowToEntry);
  },

  deleteByEntity(entityType: string, entityId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM notification_log WHERE entity_type = ? AND entity_id = ?").run(
      entityType,
      entityId
    );
  },

  getScanLog(limit = 20): NotificationLogEntry[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM notification_log
         WHERE entity_type IN ('compare', 'social', 'scrape')
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as NotificationLogRow[];
    return rows.map(rowToEntry);
  },
};
