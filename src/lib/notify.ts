import {
  sendDiscordNotification,
  sendTelegramNotification,
  sendEmailNotification,
} from "./notifications";
import type { Profile } from "../types";
import { NotificationRepository } from "../repositories/notificationRepository";
import { SettingsRepository } from "../repositories/settingsRepository";

// Envia uma notificação para todos os canais configurados do perfil
// (Discord, Telegram, e-mail). Falhas de um canal não afetam os outros.
export async function notifyProfileChannels(
  profile: Profile | undefined,
  subject: string,
  message: string
): Promise<void> {
  if (!profile) return;
  const jobs: Promise<unknown>[] = [];
  if (profile.discordWebhook) {
    jobs.push(sendDiscordNotification(profile.discordWebhook, message));
  }
  if (profile.telegramToken && profile.telegramChatId) {
    jobs.push(sendTelegramNotification(profile.telegramToken, profile.telegramChatId, message));
  }
  if (profile.gmailUser && profile.gmailPass && profile.email) {
    jobs.push(sendEmailNotification(profile.gmailUser, profile.gmailPass, profile.email, subject, message));
  }
  await Promise.allSettled(jobs);
}

// ---------------------------------------------------------------------------
// Alertas tipados (FASE 6) — cada um aplica dedup via notification_log e
// respeita o master switch notifications_enabled.
// ---------------------------------------------------------------------------

function alertsEnabled(): boolean {
  return SettingsRepository.getBool("notifications_enabled");
}

function cooldownHours(): number {
  return SettingsRepository.getNumber("notification_cooldown_hours") ?? 24;
}

// Um perfil "tem canal" se pelo menos um canal de notificação estiver configurado.
function hasChannels(profile: Profile): boolean {
  return !!(
    profile.discordWebhook ||
    (profile.telegramToken && profile.telegramChatId) ||
    (profile.gmailUser && profile.gmailPass && profile.email)
  );
}

interface AlertContext {
  entityType: string;
  entityId: string;
  subject: string;
  message: string;
}

// Envia para todos os perfis com canal configurado (fallback quando o alerta
// não é associado a um perfil específico, ex: itens/promoções locais).
// Aplica dedup via notification_log por (entityType, entityId).
async function notifyAllConfiguredProfilesWithDedup(ctx: AlertContext): Promise<number> {
  if (!alertsEnabled()) return 0;
  if (NotificationRepository.hasSentWithin(ctx.entityType, ctx.entityId, cooldownHours())) {
    return 0;
  }
  const { ProfileRepository } = await import("../repositories/profileRepository");
  const profiles = ProfileRepository.getAll().filter(hasChannels);
  if (profiles.length === 0) return 0;
  await Promise.allSettled(
    profiles.map((p) => notifyProfileChannels(p, ctx.subject, ctx.message))
  );
  NotificationRepository.record({
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    channel: "all",
    title: ctx.subject,
    message: ctx.message,
  });
  return profiles.length;
}

// Dedup + envio para um perfil específico. Retorna true se notificou.
async function sendAlertWithDedup(
  profile: Profile | undefined,
  ctx: AlertContext
): Promise<boolean> {
  if (!alertsEnabled()) return false;
  if (!profile || !hasChannels(profile)) return false;
  if (NotificationRepository.hasSentWithin(ctx.entityType, ctx.entityId, cooldownHours())) {
    return false;
  }
  await notifyProfileChannels(profile, ctx.subject, ctx.message);
  NotificationRepository.record({
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    channel: "all",
    title: ctx.subject,
    message: ctx.message,
  });
  return true;
}

// Alerta quando um produto de e-commerce atinge/ultrapassa o preço-alvo.
export async function alertProductTargetReached(
  profile: Profile | undefined,
  productName: string,
  productId: string,
  currentPrice: number,
  targetPrice: number
): Promise<boolean> {
  return sendAlertWithDedup(profile, {
    entityType: "product",
    entityId: productId,
    subject: `🎯 ALVO ATINGIDO: ${productName}`,
    message: `🛡️ [SENTINEL] O produto *${productName}* atingiu o preço-alvo!\n\n💵 Preço atual: R$ ${currentPrice}\n🎯 Alvo: R$ ${targetPrice}\n\nAproveite antes que suba de novo.`,
  });
}

// Alerta quando um item da lista de compras local atinge o preço-alvo em
// algum estabelecimento (via observação de preço).
export async function alertShoppingItemTargetReached(
  itemName: string,
  itemId: string,
  establishmentName: string,
  price: number,
  targetPrice: number
): Promise<number> {
  return notifyAllConfiguredProfilesWithDedup({
    entityType: "shopping_item",
    entityId: itemId,
    subject: `🎯 ALVO ATINGIDO: ${itemName}`,
    message: `🛒 [SENTINEL] O item *${itemName}* está dentro do alvo em ${establishmentName}!\n\n💵 Preço: R$ ${price}\n🎯 Alvo: R$ ${targetPrice}\n\nRota otimizada sugerida na aba LOCAL.`,
  });
}

// Alerta quando uma promoção ativa é cadastrada/detectada.
export async function alertActivePromotion(
  promotionId: string,
  productName: string,
  establishmentName: string,
  promoPrice: number,
  regularPrice?: number
): Promise<number> {
  const discount = regularPrice && regularPrice > 0 && promoPrice < regularPrice
    ? ` (${Math.round(((regularPrice - promoPrice) / regularPrice) * 100)}% OFF)`
    : "";
  return notifyAllConfiguredProfilesWithDedup({
    entityType: "promotion",
    entityId: promotionId,
    subject: `🔥 PROMOÇÃO: ${productName}`,
    message: `🏷️ [SENTINEL] Nova promoção em ${establishmentName}:\n\n📦 *${productName}*\n🔥 De R$ ${regularPrice ?? "—"} por R$ ${promoPrice}${discount}\n\nConfira na aba LOCAL.`,
  });
}

// C1 — Alerta imediato de flash promotion. Não usa dedup normal (24h); usa
// dedup curto de 1h por flash:<id> para permitir realertas se o preço cair
// mais em momentos distintos. Se flash_telegram_priority=true, só Telegram.
export async function alertFlashPromotion(
  promotion: {
    id: string;
    productName: string;
    promoPrice: number;
    regularPrice?: number;
  },
  establishmentName: string,
  reason?: string
): Promise<number> {
  if (!alertsEnabled()) return 0;
  // Dedup curto: 1h
  if (NotificationRepository.hasSentWithin("flash", promotion.id, 1)) return 0;

  const { ProfileRepository } = await import("../repositories/profileRepository");
  const profiles = ProfileRepository.getAll().filter(hasChannels);
  if (profiles.length === 0) return 0;

  const telegramOnly = SettingsRepository.getBool("flash_telegram_priority");
  const targetProfiles = telegramOnly
    ? profiles.filter((p) => p.telegramToken && p.telegramChatId)
    : profiles;
  if (targetProfiles.length === 0 && telegramOnly) return 0;

  const msg = `⚡ [SENTINEL] PROMOÇÃO RELÂMPAGO!\n\n📦 *${promotion.productName}*\n🔥 R$ ${promotion.promoPrice}${promotion.regularPrice ? ` (era R$ ${promotion.regularPrice})` : ""}\n📍 ${establishmentName}${reason ? `\n📉 Motivo: ${reason}` : ""}\n\n⚠️ Válido por ~24h ou até o fim do estoque.`;

  await Promise.allSettled(
    targetProfiles.map((p) =>
      telegramOnly && p.telegramToken && p.telegramChatId
        ? sendTelegramNotification(p.telegramToken, p.telegramChatId, msg)
        : notifyProfileChannels(p, `⚡ FLASH: ${promotion.productName}`, msg)
    )
  );
  NotificationRepository.record({
    entityType: "flash",
    entityId: promotion.id,
    channel: telegramOnly ? "telegram" : "all",
    title: `⚡ FLASH: ${promotion.productName}`,
    message: msg,
  });
  return targetProfiles.length;
}
