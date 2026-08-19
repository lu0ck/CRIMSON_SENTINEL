// Wrapper Node para o microserviço Python instagrapi. Acessa endpoints HTTP
// em http://127.0.0.1:8721 (porta configurável via env).
// Veja python_instagram/README.md para誓言 sobre conta secundária e ToS.

import { safeLog } from "../lib/safeLog";

const BASE_URL =
  process.env.INSTAGRAM_SERVICE_URL ||
  `http://127.0.0.1:${process.env.INSTAGRAM_SERVICE_PORT ?? 8721}`;

export interface InstagramStoryItem {
  id: string;
  pk: string;
  type: string;
  taken_at: string;
  caption_text: string;
  media_url?: string | null;
}

// Verifica se o microserviço Python está online. Não-bloqueante.
export async function instagramServiceHealth(): Promise<{
  ok: boolean;
  sessionLoaded: boolean;
  username?: string;
}> {
  try {
    const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, sessionLoaded: false };
    const d = (await r.json()) as any;
    return { ok: true, sessionLoaded: !!d.session_loaded, username: d.username };
  } catch (err: any) {
    safeLog(`[instagram-client] health falhou — serviço não está rodando? ${err.message}`);
    return { ok: false, sessionLoaded: false };
  }
}

// Dispara /login no microserviço. Salva sessão em disco.
export async function instagramLogin(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/login`, { method: "POST" });
    return r.ok;
  } catch (err: any) {
    safeLog(`[instagram-client] /login falhou: ${err.message}`);
    return false;
  }
}

// Busca stories ativos de um handle. Se download=true, baixa as mídias em /tmp
// (necessário para passar imagens ao Gemini vision).
export async function fetchStories(
  handle: string,
  opts: { download?: boolean; timeoutMs?: number } = {}
): Promise<InstagramStoryItem[]> {
  const url = `${BASE_URL}/stories/${encodeURIComponent(handle)}${
    opts.download ? "?download=true" : ""
  }`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const r = await fetch(url, { signal: controller.signal as any });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`instagram service: ${r.status} ${txt}`);
    }
    return (await r.json()) as InstagramStoryItem[];
  } finally {
    clearTimeout(t);
  }
}

// Lê um arquivo baixado (de /tmp) e retorna buffer. Usado para passar ao
// Gemini vision com upload inline.
export async function readStoryMedia(
  mediaUrl: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const fs = await import("fs");
    if (!fs.existsSync(mediaUrl)) return null;
    const buffer = fs.readFileSync(mediaUrl);
    const ext = mediaUrl.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "mp4" ? "video/mp4" : ext === "png" ? "image/png" : "image/jpeg";
    return { buffer, mimeType };
  } catch {
    return null;
  }
}
