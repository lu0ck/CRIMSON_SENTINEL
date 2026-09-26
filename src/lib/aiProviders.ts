// ============================================================
// #54 — Cadeia única de interpretação: DeepSeek → Gemini → NVIDIA → LM Studio
// DeepSeek = PRINCIPAL (texto e imagem), API OpenAI-compatible.
// Cada call-site tenta DeepSeek primeiro e, se null, segue a ordem antiga
// (Gemini → NVIDIA → LM) já existente naquele ponto.
// ============================================================
import OpenAI from "openai";

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
// #54 — modelos (env permite trocar sem deploy)
export const DEEPSEEK_TEXT_MODEL = process.env.DEEPSEEK_TEXT_MODEL || "deepseek-v4-flash";
export const DEEPSEEK_VISION_MODEL = process.env.DEEPSEEK_VISION_MODEL || "deepseek-v4-flash-vision-exp";
export const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 30_000);
export const DEEPSEEK_MAX_TOKENS = 2048;

/** Primeira chave não-vazia (perfil → env). */
export function resolveDeepSeekKey(...candidates: Array<string | undefined | null>): string | undefined {
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return undefined;
}

/** Log uniforme da cadeia: [aiChain] deepseek/text OK: 412 chars */
export function logAI(provider: string, ok: boolean, detail?: string): void {
  console.log(`[aiChain] ${provider} ${ok ? "OK" : "falhou"}${detail ? `: ${detail}` : ""}`);
}

let cachedClient: { key: string; client: OpenAI } | null = null;

function getClient(apiKey: string): OpenAI {
  if (cachedClient && cachedClient.key === apiKey) return cachedClient.client;
  const client = new OpenAI({
    baseURL: DEEPSEEK_BASE_URL,
    apiKey,
    timeout: DEEPSEEK_TIMEOUT_MS,
    maxRetries: 1,
  });
  cachedClient = { key: apiKey, client };
  return client;
}

export type DeepSeekTextOpts = {
  apiKey: string;
  system?: string;
  timeoutMs?: number;
  maxTokens?: number;
};

/** Interpretação de TEXTO via DeepSeek. null em erro/resposta vazia (caller tenta o próximo da cadeia). */
export async function deepseekText(prompt: string, opts: DeepSeekTextOpts): Promise<string | null> {
  if (!opts.apiKey) return null;
  try {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });
    const resp = await getClient(opts.apiKey).chat.completions.create(
      {
        model: DEEPSEEK_TEXT_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? DEEPSEEK_MAX_TOKENS,
        temperature: 0,
      },
      { timeout: opts.timeoutMs ?? DEEPSEEK_TIMEOUT_MS }
    );
    const text = (resp.choices?.[0]?.message?.content || "").trim();
    if (!text) {
      logAI("deepseek/text", false, "resposta vazia");
      return null;
    }
    logAI("deepseek/text", true, `${text.length} chars`);
    return text;
  } catch (e: any) {
    logAI("deepseek/text", false, e?.message || String(e));
    return null;
  }
}

export type DeepSeekVisionOpts = {
  apiKey: string;
  timeoutMs?: number;
  maxTokens?: number;
};

/** Interpretação de IMAGEM via DeepSeek (screenshot de produto). null em erro/resposta vazia. */
export async function deepseekVision(
  image: { base64: string; mimeType?: string },
  prompt: string,
  opts: DeepSeekVisionOpts
): Promise<string | null> {
  if (!opts.apiKey) return null;
  try {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: { url: `data:${image.mimeType || "image/png"};base64,${image.base64}` },
      },
    ];
    const resp = await getClient(opts.apiKey).chat.completions.create(
      {
        model: DEEPSEEK_VISION_MODEL,
        messages: [{ role: "user", content }],
        max_tokens: opts.maxTokens ?? DEEPSEEK_MAX_TOKENS,
        temperature: 0,
      },
      { timeout: opts.timeoutMs ?? DEEPSEEK_TIMEOUT_MS }
    );
    const text = (resp.choices?.[0]?.message?.content || "").trim();
    if (!text) {
      logAI("deepseek/vision", false, "resposta vazia");
      return null;
    }
    logAI("deepseek/vision", true, `${text.length} chars`);
    return text;
  } catch (e: any) {
    logAI("deepseek/vision", false, e?.message || String(e));
    return null;
  }
}

/** Extrai o primeiro objeto JSON válido de uma resposta de LLM (tolerante a ```json e texto ao redor). */
export function extractJsonObject(text: string | null | undefined): any | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0].replace(/```json?\s*/gi, "").replace(/```\s*/g, ""));
  } catch {
    return null;
  }
}
