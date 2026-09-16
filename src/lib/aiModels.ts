// Modelos de IA — FONTE ÚNICA (FASE 12).
// Antes: models espalhados com variações (scanWorker usava gemini-3-flash-preview,
// server.ts fallback usava gemini-3.6-flash). Agora um só lugar para manter.

export const AI_MODELS = {
  // Compare / Analyze / Local-Insights (texto + googleSearch)
  TEXT: "gemini-3-flash-preview",
  // Extração de produto via URL context (gemini.ts)
  URL_CONTEXT: "gemini-3.6-flash",
  // Visão (Instagram Stories / imagens)
  VISION: "gemini-2.0-flash",
  // LM Studio local fallback
  LOCAL_LLM: "qwen",
} as const;

export type AiModelKey = keyof typeof AI_MODELS;