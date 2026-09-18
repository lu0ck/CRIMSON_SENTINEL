import { getDb } from "../database/db";

export interface GroupMessage {
  id: number;
  source: "whatsapp" | "telegram";
  groupName: string;
  groupId?: string;
  sender?: string;
  text: string;
  mediaUrl?: string;
  receivedAt: string;
  processed: boolean;
}

interface GroupMessageRow {
  id: number;
  source: string;
  group_name: string;
  group_id: string | null;
  sender: string | null;
  text: string;
  media_url: string | null;
  received_at: string;
  processed: number;
}

function rowToMessage(row: GroupMessageRow): GroupMessage {
  return {
    id: row.id,
    source: row.source as "whatsapp" | "telegram",
    groupName: row.group_name,
    groupId: row.group_id ?? undefined,
    sender: row.sender ?? undefined,
    text: row.text,
    mediaUrl: row.media_url ?? undefined,
    receivedAt: row.received_at,
    processed: row.processed === 1,
  };
}

export const GroupMessageRepository = {
  save(msg: Omit<GroupMessage, "id">): number {
    const result = getDb()
      .prepare(
        `INSERT INTO group_messages (source, group_name, group_id, sender, text, media_url, received_at, processed)
         VALUES (@source, @group_name, @group_id, @sender, @text, @media_url, @received_at, @processed)`
      )
      .run({
        source: msg.source,
        group_name: msg.groupName,
        group_id: msg.groupId ?? null,
        sender: msg.sender ?? null,
        text: msg.text,
        media_url: msg.mediaUrl ?? null,
        received_at: msg.receivedAt,
        processed: msg.processed ? 1 : 0,
      });
    return result.lastInsertRowid as number;
  },

  getUnprocessed(limit = 50): GroupMessage[] {
    const rows = getDb()
      .prepare("SELECT * FROM group_messages WHERE processed = 0 ORDER BY received_at ASC LIMIT ?")
      .all(limit) as GroupMessageRow[];
    return rows.map(rowToMessage);
  },

  markProcessed(id: number): void {
    getDb().prepare("UPDATE group_messages SET processed = 1 WHERE id = ?").run(id);
  },

  getRecent(limit = 30): GroupMessage[] {
    const rows = getDb()
      .prepare("SELECT * FROM group_messages ORDER BY received_at DESC LIMIT ?")
      .all(limit) as GroupMessageRow[];
    return rows.map(rowToMessage);
  },

  deleteOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = getDb().prepare("DELETE FROM group_messages WHERE received_at < ?").run(cutoff);
    return result.changes;
  },
};
