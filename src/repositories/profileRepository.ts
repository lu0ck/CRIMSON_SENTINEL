import { getDb } from "../database/db";
import type { Profile } from "../types";
import { type ProfileRow, profileRowToProfile } from "./types";

export const ProfileRepository = {
  getAll(): Profile[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM profiles").all() as ProfileRow[];
    return rows.map(profileRowToProfile);
  },

  getById(id: string): Profile | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(id) as ProfileRow | undefined;
    return row ? profileRowToProfile(row) : undefined;
  },

  saveAll(profiles: Profile[]): void {
    const db = getDb();
    const tx = db.transaction((items: Profile[]) => {
      for (const p of items) {
        db.prepare(
          `INSERT INTO profiles (id, name, avatar, email, discord_webhook, telegram_token, telegram_chat_id, gmail_user, gmail_pass, gemini_api_key, lm_studio_url, nvidia_api_key, serper_api_key, tavily_api_key, use_advanced_scraping, refresh_interval)
           VALUES (@id, @name, @avatar, @email, @discord_webhook, @telegram_token, @telegram_chat_id, @gmail_user, @gmail_pass, @gemini_api_key, @lm_studio_url, @nvidia_api_key, @serper_api_key, @tavily_api_key, @use_advanced_scraping, @refresh_interval)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, avatar=excluded.avatar, email=excluded.email,
             discord_webhook=excluded.discord_webhook, telegram_token=excluded.telegram_token,
             telegram_chat_id=excluded.telegram_chat_id, gmail_user=excluded.gmail_user,
             gmail_pass=excluded.gmail_pass, gemini_api_key=excluded.gemini_api_key,
             lm_studio_url=excluded.lm_studio_url, nvidia_api_key=excluded.nvidia_api_key,
             serper_api_key=excluded.serper_api_key, tavily_api_key=excluded.tavily_api_key,
             use_advanced_scraping=excluded.use_advanced_scraping,
             refresh_interval=excluded.refresh_interval`
        ).run({
          id: p.id,
          name: p.name,
          avatar: p.avatar ?? null,
          email: p.email ?? null,
          discord_webhook: p.discordWebhook ?? null,
          telegram_token: p.telegramToken ?? null,
          telegram_chat_id: p.telegramChatId ?? null,
          gmail_user: p.gmailUser ?? null,
          gmail_pass: p.gmailPass ?? null,
          gemini_api_key: p.geminiApiKey ?? null,
          lm_studio_url: p.lmStudioUrl ?? null,
          nvidia_api_key: p.nvidiaApiKey ?? null,
          serper_api_key: p.serperApiKey ?? null,
          tavily_api_key: p.tavilyApiKey ?? null,
          use_advanced_scraping: p.useAdvancedScraping ? 1 : 0,
          refresh_interval: p.refreshInterval ?? null,
        });
      }
    });
    tx(profiles);
  },

  deleteAll(): void {
    const db = getDb();
    db.exec("DELETE FROM profiles");
  },
};
