import { SettingsRepository } from "../repositories/settingsRepository";

// Toggle do Instagram em runtime (sem .env / restart).
// Prioridade: user_settings.instagram_enabled (definido via painel social) >
// .env INSTAGRAM_ENABLED (legado). Sem setting salvo, preserva o comportamento
// anterior: default desligado, liga só se INSTAGRAM_ENABLED=true no ambiente.
export function isInstagramEnabled(): boolean {
  const stored = SettingsRepository.get("instagram_enabled");
  if (stored !== undefined) {
    return stored === "true" || stored === "1";
  }
  return process.env.INSTAGRAM_ENABLED === "true";
}