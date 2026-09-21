import { Worker, type Job } from "bullmq";
import { getRedis } from "../queue/connection";
import { QUEUE_NAMES, getSocialQueue } from "../queue/queues";
import type { SocialMonitorJobPayload } from "../queue/types";
import { safeLog } from "../lib/safeLog";
import { SettingsRepository } from "../repositories/settingsRepository";
import { SocialSourceRepository } from "../repositories/socialSourceRepository";
import { ProfileRepository } from "../repositories/profileRepository";
import { PromotionRepository } from "../repositories/promotionRepository";
import { EstablishmentRepository } from "../repositories/establishmentRepository";
import { recordInAppAlert } from "../lib/notify";
import { alertActivePromotion } from "../lib/notify";
import {
  parsePromosFromTextWithAI,
  enrichParsedPromos,
  isDuplicatePromo,
} from "../lib/socialParse";
import { AI_MODELS } from "../lib/aiModels";
import { isInstagramEnabled } from "../lib/instagramEnabled";

// FASE 8 — monitoramento social. Captura texto de WhatsApp (colado) ou captions
// do Instagram (via Playwright) e transforma em promoções (source whatsapp/instagram).

function genPromoId(source: string): string {
  return `social-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handleSocialCapture(job: Job<SocialMonitorJobPayload & { type: "social-capture" }>) {
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    safeLog(`[social-worker] desabilitado em user_settings, pulando job ${job.id}`);
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }

  const { channel, text, url, sourceId, profileId } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : undefined;
  const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const source = sourceId ? SocialSourceRepository.getById(sourceId) : undefined;
  const hint = source?.establishmentHint;

  let rawText = text?.trim() || "";
  let method = "deterministic";

  // Instagram: se não houver texto colado, tenta capturar captions da URL.
  if (!rawText && url && channel === "instagram") {
    try {
      rawText = await fetchInstagramCaptions(url);
      method = "playwright";
    } catch (err: any) {
      safeLog(`[social-worker] falha ao capturar Instagram ${url}: ${err.message}`);
    }
  }

  if (!rawText) {
    if (sourceId) SocialSourceRepository.setLastChecked(sourceId);
    return { captured: false, reason: "sem texto nem URL válida" };
  }

  const { promos } = await parsePromosFromTextWithAI(rawText, apiKey, hint);
  const enriched = enrichParsedPromos(promos, rawText, hint);

  const saved: any[] = [];
  const skippedDuplicates: any[] = [];

  for (const promo of enriched) {
    // Só cadastra promoções com estabelecimento identificado.
    if (!promo.establishmentId) {
      continue;
    }
    if (isDuplicatePromo(promo)) {
      skippedDuplicates.push(promo.productName);
      continue;
    }
    const id = genPromoId(channel);
    PromotionRepository.save({
      id,
      establishmentId: promo.establishmentId,
      productName: promo.productName,
      regularPrice: promo.regularPrice,
      promoPrice: promo.promoPrice,
      source: channel,
      sourceUrl: url,
      rawText: rawText.slice(0, 2000),
      detectedAt: new Date().toISOString(),
      isActive: true,
    });
    saved.push({ id, productName: promo.productName, promoPrice: promo.promoPrice });

    const est = promo.establishmentName ?? "estabelecimento";
    alertActivePromotion(id, promo.productName, est, promo.promoPrice, promo.regularPrice, url)
      .catch((e: any) => safeLog(`[social-worker] erro alerta promo: ${e}`));
  }

  if (sourceId) SocialSourceRepository.setLastChecked(sourceId);

  safeLog(`[social-worker] ${channel} — ${saved.length} promoções salvas, ${skippedDuplicates.length} duplicadas (método ${method})`);
  recordInAppAlert("social", `capture-${channel}-${Date.now()}`, "CAPTURA SOCIAL", `${channel.toUpperCase()}: ${saved.length} promo(s) detectada(s), ${skippedDuplicates.length} duplicada(s)`);
  return {
    captured: true,
    channel,
    method,
    saved,
    skippedDuplicates,
  };
}

// Busca captions de um perfil/posts públicos do Instagram via Playwright.
// Extrai o JSON embutido no HTML (_sharedData) com fallback para texto visível.
export async function fetchInstagramCaptions(url: string): Promise<string> {
  const chromium = await import("playwright");
  const browser = await chromium.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Tenta extrair o JSON __additionalDataLoaded (captions dos posts).
    const jsonText = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const s of scripts) {
        if (s.textContent && s.textContent.includes("caption")) {
          const m = s.textContent.match(/\{"caption".*$/);
          if (m) return m[0];
        }
      }
      return "";
    });

    if (jsonText) {
      const captions: string[] = [];
      const re = /"text":"((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(jsonText)) !== null) {
        captions.push(m[1].replace(/\\n/g, " ").replace(/\\"/g, '"'));
      }
      if (captions.length > 0) return captions.join("\n").slice(0, 6000);
    }

    // Fallback: texto visível da página (post único aberto).
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    if (bodyText.trim()) return bodyText.slice(0, 6000);

    return "";
  } finally {
    await browser.close();
  }
}

async function handleSocialScanAll(job: Job<SocialMonitorJobPayload & { type: "social-scan-all" }>) {
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    safeLog(`[social-worker] desabilitado em user_settings, pulando job ${job.id}`);
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }
  const sources = SocialSourceRepository.getAll(true);
  safeLog(`[social-worker] scan-all: ${sources.length} fontes ativas, enfileirando capturas`);

  const queue = getSocialQueue();
  let enqueued = 0;
  for (const source of sources) {
    try {
      await queue.add(
        "social-capture",
        {
          type: "social-capture",
          channel: source.channel,
          url: source.url,
          sourceId: source.id,
        } as SocialMonitorJobPayload
      );
      enqueued++;
    } catch (err: any) {
      safeLog(`[social-worker] falha ao enfileirar captura de ${source.name}: ${err.message}`);
    }
  }
  recordInAppAlert("social", `scan-all-${Date.now()}`, "SCAN CONCLUÍDO", `${sources.length} fonte(s) ativa(s), ${enqueued} captura(s) enfileirada(s)`);

  return { sources: sources.length, enqueued };
}

// C2 — scan de Status do WhatsApp via whatsapp-web.js. Lê os Status dos
// contatos salvos em establishments.whatsapp_number, extrai texto, passa
// para o socialParse (Gemini opcional) e grava promotions source='whatsapp'.
// Respeita throttle definido em user_settings.whatsapp_scan_per_contact_min.
async function handleWhatsappStatusScan(job: Job<SocialMonitorJobPayload & { type: "whatsapp-status-scan" }>) {
  if (!SettingsRepository.getBool("whatsapp_enabled")) {
    return { skipped: true, reason: "whatsapp desativado" };
  }
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }
  const { startWhatsappSession, fetchContactStatuses, isWhatsappReady } = await import("../social/whatsappSession.ts");

  if (!(await isWhatsappReady())) {
    safeLog("[social-worker] whatsapp: iniciando sessão (QR)");
    await startWhatsappSession({
      onQr: () => {},
      onAuthenticated: () => safeLog("[social-worker] whatsapp autenticado"),
      onReady: () => safeLog("[social-worker] whatsapp pronto"),
      onAuthFailure: (m) => safeLog(`[social-worker] whatsapp auth fail: ${m}`),
      onDisconnected: () => safeLog("[social-worker] whatsapp disconnected"),
    }).catch((err: any) => {
      safeLog(`[social-worker] whatsapp init falhou: ${err.message}`);
    });
    // Aguarda 2s para QR/autenticar; sustenta o job mesmo se não foi dessa vez.
    await new Promise((r) => setTimeout(r, 2000));
    if (!(await isWhatsappReady())) {
      return { skipped: true, reason: "Sessão não está pronta — escaneie o QR via /api/social/whatsapp/qr" };
    }
  }

  const allEstablishments = EstablishmentRepository.getAll();
  const withWhatsapp = allEstablishments.filter((e) => e.whatsappNumber);
  if (withWhatsapp.length === 0) {
    return { skipped: true, reason: "Nenhum estabelecimento com whatsapp_number cadastrado" };
  }
  const throttleMin = SettingsRepository.getNumber("whatsapp_scan_per_contact_min") ?? 20;
  const throttleMs = throttleMin * 60 * 1000;
  // Mapa de "última checagem" via social_sources (chaveado por establishment_hint)
  const socialSources = SocialSourceRepository.getAll() as any[];
  const lastCheckedByName = new Map<string, string>();
  for (const s of socialSources) {
    if (s.channel === "whatsapp" && s.establishmentHint) {
      lastCheckedByName.set(s.establishmentHint.toLowerCase(), s.lastCheckedAt);
    }
  }

  let captured = 0;
  let saved = 0;
  const profile = ProfileRepository.getAll()[0];
  const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  for (const est of withWhatsapp) {
    const last = lastCheckedByName.get(est.name.toLowerCase());
    if (last) {
      const age = Date.now() - new Date(last).getTime();
      if (age < throttleMs) {
        safeLog(`[social-worker] whatsapp throttled: ${est.name}, último check há ${Math.round(age / 60000)}min`);
        continue;
      }
    }

    try {
      const statuses = await fetchContactStatuses([est.whatsappNumber!]);
      for (const st of statuses) {
        if (!st.statusText) continue;
        captured++;
        const { promos } = await parsePromosFromTextWithAI(st.statusText, apiKey, est.name);
        const enriched = enrichParsedPromos(promos, st.statusText, est.name);
        for (const p of enriched) {
          if (!p.establishmentId) p.establishmentId = est.id;
          if (isDuplicatePromo(p)) continue;
          const id = genPromoId("whatsapp");
          PromotionRepository.save({
            id,
            establishmentId: p.establishmentId,
            productName: p.productName,
            regularPrice: p.regularPrice,
            promoPrice: p.promoPrice,
            source: "whatsapp",
            rawText: st.statusText.slice(0, 2000),
            detectedAt: st.capturedAt,
            isActive: true,
            isFlash: true,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
          saved++;
          alertActivePromotion(id, p.productName, est.name, p.promoPrice, p.regularPrice, est.priceUrl)
            .catch((e) => safeLog(`[social-worker] erro alerta whatsapp: ${e}`));
        }
      }
      // Throttle leve entre contatos — aguarda 5s para não sobrecarregar
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err: any) {
      safeLog(`[social-worker] erro whatsappStatus ${est.name}: ${err.message}`);
    }
  }
  recordInAppAlert("social", `whatsapp-status-${Date.now()}`, "WHATSAPP STATUS", `${saved} promo(s) salva(s) de ${withWhatsapp.length} contato(s)`);
  return { captured, saved, scanned: withWhatsapp.length };
}

// C3 — scan de Stories do Instagram via microserviço Python (instagrapi).
// 1 req por vez, throttle agressivo entre handles (30-60min, default 45).
// Baixa mídia e passa ao Gemini vision para extrair preços quando houver.
async function handleInstagramStoriesScan(
  job: Job<SocialMonitorJobPayload & { type: "instagram-stories-scan" }>
) {
  if (!isInstagramEnabled()) {
    return { skipped: true, reason: "instagram desativado no painel social" };
  }
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }

  const { instagramServiceHealth, instagramLogin, fetchStories, readStoryMedia } =
    await import("../social/instagramClient.ts");

  const health = await instagramServiceHealth();
  if (!health.ok) {
    return {
      skipped: true,
      reason:
        "Microserviço Python (instagrapi) não está rodando. Veja python_instagram/README.md.",
    };
  }
  if (!health.sessionLoaded) {
    safeLog("[social-worker] instagram: sessão não carregada, tentando /login");
    const ok = await instagramLogin();
    if (!ok) {
      return {
        skipped: true,
        reason:
          "Instagram sessão não autenticada. Defina IG_USERNAME/IG_PASSWORD no env do processo instagram-service e faça /login.",
      };
    }
  }

  const allEstablishments = EstablishmentRepository.getAll();
  const withHandle = allEstablishments.filter((e) => e.instagramHandle);
  if (withHandle.length === 0) {
    return { skipped: true, reason: "Nenhum estabelecimento com instagram_handle cadastrado" };
  }
  const throttleMin = SettingsRepository.getNumber("instagram_scan_per_handle_min") ?? 45;
  const throttleMs = throttleMin * 60 * 1000;

  const socialSources = SocialSourceRepository.getAll() as any[];
  const lastCheckedByName = new Map<string, string>();
  for (const s of socialSources) {
    if (s.channel === "instagram" && s.establishmentHint) {
      lastCheckedByName.set(s.establishmentHint.toLowerCase(), s.lastCheckedAt);
    }
  }

  let captured = 0;
  let saved = 0;
  const profile = ProfileRepository.getAll()[0];
  const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  for (const est of withHandle) {
    const last = lastCheckedByName.get(est.name.toLowerCase());
    if (last) {
      const age = Date.now() - new Date(last).getTime();
      if (age < throttleMs) {
        safeLog(
          `[social-worker] instagram throttled: ${est.name}, último check há ${Math.round(age / 60000)}min`
        );
        continue;
      }
    }

    try {
      // download=true para podermos passar imagem/vídeo ao Gemini vision
      const stories = await fetchStories(est.instagramHandle!, { download: !!apiKey, timeoutMs: 20_000 });
      for (const st of stories) {
        captured++;
        // 1. Tenta extrair preços do caption (texto)
        let text = st.caption_text || "";
        let method = "caption";

        // 2. Se houver mídia e Gemini key, passa a imagem para extrair preços
        if (apiKey && st.media_url) {
          try {
            const media = await readStoryMedia(st.media_url);
            if (media) {
              const base64 = media.buffer.toString("base64");
              const { GoogleGenAI } = await import("@google/genai");
              const ai = new GoogleGenAI({ apiKey });
              const inlineData = {
                inlineData: { data: base64, mimeType: media.mimeType },
              };
              const r = await ai.models.generateContent({
                model: AI_MODELS.VISION,
                contents: [
                  {
                    role: "user",
                    parts: [
                      inlineData,
                      {
                        text:
                          "Extraia produtos e preços desta imagem de story do Instagram. " +
                          'Responda como JSON array: [{"productName":"...","promoPrice":...,"regularPrice":...}],' +
                          " se nada relevante, retorne []. Inclua apenas preços claramente visíveis.",
                      },
                    ],
                  },
                ],
              });
              if (r.text) {
                text += "\n[GEMINI VISION] " + r.text;
                method = "gemini-vision";
              }
            }
          } catch (err: any) {
            safeLog(`[social-worker] instagram vision falhou para ${est.name}: ${err.message}`);
          }
        }

        if (!text.trim()) continue;
        const { promos } = await parsePromosFromTextWithAI(text, apiKey, est.name);
        const enriched = enrichParsedPromos(promos, text, est.name);
        for (const p of enriched) {
          if (!p.establishmentId) p.establishmentId = est.id;
          if (isDuplicatePromo(p)) continue;
          const id = genPromoId("instagram");
          PromotionRepository.save({
            id,
            establishmentId: p.establishmentId,
            productName: p.productName,
            regularPrice: p.regularPrice,
            promoPrice: p.promoPrice,
            source: "instagram",
            rawText: text.slice(0, 2000),
            detectedAt: st.taken_at || new Date().toISOString(),
            isActive: true,
            isFlash: true,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
          saved++;
          alertActivePromotion(id, p.productName, est.name, p.promoPrice, p.regularPrice, est.priceUrl)
            .catch((e) => safeLog(`[social-worker] erro alerta instagram: ${e}`));
        }
      }
      // Throttle leve entre handles — aguarda 5s para não sobrecarregar
      await new Promise((r) => setTimeout(r, 5000));
    } catch (err: any) {
      safeLog(`[social-worker] erro instagramStories ${est.name}: ${err.message}`);
    }
  }
  recordInAppAlert("social", `instagram-stories-${Date.now()}`, "INSTAGRAM STORIES", `${saved} promo(s) salva(s) de ${withHandle.length} perfil(is)`);
  return { captured, saved, scanned: withHandle.length, method: "instagrapi" };
}

// ---------------------------------------------------------------------------
// FRENTE 4 — Processamento de mensagens de grupo (WhatsApp/Telegram)
// ---------------------------------------------------------------------------

async function handleGroupMessageProcess(
  job: Job<SocialMonitorJobPayload & { type: "group-message-process" }>
) {
  if (!SettingsRepository.getBool("social_monitoring_enabled")) {
    return { skipped: true, reason: "social_monitoring_enabled=false" };
  }

  const { groupName, text, profileId, source } = job.data;
  const profile = profileId ? ProfileRepository.getById(profileId) : ProfileRepository.getAll()[0];
  const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

  const { promos } = await parsePromosFromTextWithAI(text, apiKey, groupName);
  const enriched = enrichParsedPromos(promos, text, groupName);

  const saved: any[] = [];
  const skippedDuplicates: any[] = [];

  for (const promo of enriched) {
    if (!promo.establishmentId) continue;
    if (isDuplicatePromo(promo)) {
      skippedDuplicates.push(promo.productName);
      continue;
    }
    const id = genPromoId(source);
    PromotionRepository.save({
      id,
      establishmentId: promo.establishmentId,
      productName: promo.productName,
      regularPrice: promo.regularPrice,
      promoPrice: promo.promoPrice,
      source,
      rawText: text.slice(0, 2000),
      detectedAt: new Date().toISOString(),
      isActive: true,
    });
    saved.push({ id, productName: promo.productName, promoPrice: promo.promoPrice });

    const est = promo.establishmentName ?? groupName;
    alertActivePromotion(id, promo.productName, est, promo.promoPrice, promo.regularPrice)
      .catch((e: any) => safeLog(`[social-worker] erro alerta grupo: ${e}`));
  }

  // Marcar mensagem como processada
  const { GroupMessageRepository } = await import("../repositories/groupMessageRepository.ts");
  GroupMessageRepository.markProcessed(job.data.messageId);

  safeLog(`[social-worker] grupo ${groupName} (${source}): ${saved.length} promoções, ${skippedDuplicates.length} duplicadas`);
  recordInAppAlert("social", `group-${groupName}-${Date.now()}`, "GRUPO", `${groupName}: ${saved.length} promo(s) detectada(s), ${skippedDuplicates.length} duplicada(s)`);
  return { captured: true, source, groupName, saved, skippedDuplicates };
}

// ---------------------------------------------------------------------------
// FRENTE 4 — Avaliação periódica de triggers
// ---------------------------------------------------------------------------

async function handleTriggerEvaluate(
  job: Job<SocialMonitorJobPayload & { type: "trigger-evaluate" }>
) {
  const { TriggerRepository } = await import("../repositories/triggerRepository.ts");
  const triggers = TriggerRepository.getAll(true);
  if (triggers.length === 0) return { evaluated: 0, fired: 0 };

  const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown entre disparos
  let fired = 0;

  for (const trigger of triggers) {
    if (TriggerRepository.hasFiredRecently(trigger.id, COOLDOWN_MS)) continue;

    let matched = false;
    let matchedValue = "";

    switch (trigger.condition) {
      case "price_lte": {
        const threshold = parseFloat(trigger.value);
        if (isNaN(threshold)) break;
        const products = (await import("../repositories/productRepository.ts")).ProductRepository.getAll();
        for (const p of products) {
          if (p.currentPrice != null && p.currentPrice <= threshold) {
            matched = true;
            matchedValue = `${p.name}: R$ ${p.currentPrice}`;
            break;
          }
        }
        break;
      }
      case "price_drop_pct": {
        const minDropPct = parseFloat(trigger.value);
        if (isNaN(minDropPct)) break;
        const products = (await import("../repositories/productRepository.ts")).ProductRepository.getAll();
        for (const p of products) {
          if (p.currentPrice != null && p.previousPrice != null && p.previousPrice > 0) {
            const dropPct = ((p.previousPrice - p.currentPrice) / p.previousPrice) * 100;
            if (dropPct >= minDropPct) {
              matched = true;
              matchedValue = `${p.name}: R$ ${p.previousPrice} → R$ ${p.currentPrice} (${dropPct.toFixed(1)}% queda)`;
              break;
            }
          }
        }
        break;
      }
      case "price_trend": {
        const minConsecutive = parseInt(trigger.value) || 3;
        const { getDb } = await import("../database/db.ts");
        const products = (await import("../repositories/productRepository.ts")).ProductRepository.getAll();
        for (const p of products) {
          const history = getDb()
            .prepare("SELECT price FROM price_history WHERE product_id = ? ORDER BY date DESC LIMIT ?")
            .all(p.id, minConsecutive + 1) as { price: number }[];
          if (history.length < minConsecutive + 1) continue;
          let consecutive = 0;
          for (let i = 0; i < history.length - 1; i++) {
            if (history[i].price < history[i + 1].price) {
              consecutive++;
            } else {
              break;
            }
          }
          if (consecutive >= minConsecutive) {
            matched = true;
            matchedValue = `${p.name}: ${consecutive} quedas consecutivas (R$ ${history[0].price} → R$ ${history[history.length - 1].price})`;
            break;
          }
        }
        break;
      }
      case "contains": {
        const keywords = trigger.value.toLowerCase().split(",").map((s) => s.trim());
        const recentPromos = (await import("../repositories/promotionRepository.ts")).PromotionRepository.getRecent?.(20) ?? [];
        for (const promo of recentPromos) {
          const name = promo.productName.toLowerCase();
          if (keywords.some((kw) => name.includes(kw))) {
            matched = true;
            matchedValue = promo.productName;
            break;
          }
        }
        break;
      }
      case "new_promo": {
        const recentPromos = (await import("../repositories/promotionRepository.ts")).PromotionRepository.getRecent?.(5) ?? [];
        if (recentPromos.length > 0) {
          matched = true;
          matchedValue = `${recentPromos.length} promoções recentes`;
        }
        break;
      }
    }

    if (matched) {
      TriggerRepository.setLastFired(trigger.id);
      TriggerRepository.logFire(trigger.id, undefined, matchedValue);
      fired++;

      // Enviar notificação
      const channels = trigger.channels.split(",").map((c) => c.trim());
      const profile = ProfileRepository.getAll()[0];
      const message = `🔔 TRIGGER "${trigger.name}" ATIVADO!\n\n📦 ${matchedValue}`;

      if (channels.includes("discord") && profile?.discordWebhook) {
        const { sendDiscordNotification } = await import("../lib/notifications.ts");
        sendDiscordNotification(profile.discordWebhook, message).catch(() => {});
      }
      if (channels.includes("telegram") && profile?.telegramToken && profile?.telegramChatId) {
        const { sendTelegramNotification } = await import("../lib/notifications.ts");
        sendTelegramNotification(profile.telegramToken, profile.telegramChatId, message).catch(() => {});
      }
    }
  }

  safeLog(`[social-worker] trigger-evaluate: ${triggers.length} triggers, ${fired} disparados`);
  return { evaluated: triggers.length, fired };
}

// ---------------------------------------------------------------------------
// FRENTE 4 — Converter promoção em produto rastreado
// ---------------------------------------------------------------------------

async function handleTrackFromPromo(
  job: Job<SocialMonitorJobPayload & { type: "track-from-promo" }>
) {
  const { promoId, listId, profileId } = job.data;
  const promo = (await import("../repositories/promotionRepository.ts")).PromotionRepository.getById?.(promoId);
  if (!promo) return { error: "promoção não encontrada" };

  const profile = profileId
    ? ProfileRepository.getById(profileId)
    : ProfileRepository.getAll()[0];
  if (!profile) return { error: "nenhum perfil configurado" };

  const est = (await import("../repositories/establishmentRepository.ts")).EstablishmentRepository.getById?.(promo.establishmentId);
  const productUrl = est?.priceUrl || promo.sourceUrl || "";

  const productId = `promo-${promoId}`;
  const { ProductRepository } = await import("../repositories/productRepository.ts");
  ProductRepository.save({
    id: productId,
    url: productUrl,
    name: promo.productName,
    currentPrice: promo.promoPrice,
    previousPrice: promo.regularPrice ?? promo.promoPrice,
    currency: "BRL",
    available: true,
    lastUpdated: new Date().toISOString(),
    listId: listId || "",
    profileId: profile.id,
    targetPrice: promo.promoPrice,
    priceHistory: [],
  });

  // Registrar preço inicial no histórico
  const { getDb } = await import("../database/db.ts");
  getDb()
    .prepare("INSERT INTO price_history (product_id, price, date) VALUES (?, ?, ?)")
    .run(productId, promo.promoPrice, new Date().toISOString().slice(0, 10));

  safeLog(`[social-worker] promo ${promoId} convertida em produto ${productId}`);
  return { productId, productName: promo.productName };
}

export function startSocialWorker() {
  const worker = new Worker<SocialMonitorJobPayload>(
    QUEUE_NAMES.SOCIAL,
    async (job) => {
      safeLog(`[social-worker] job ${job.id} type=${job.data.type}`);
      switch (job.data.type) {
        case "social-capture":
          return handleSocialCapture(job as Job<SocialMonitorJobPayload & { type: "social-capture" }>);
        case "social-scan-all":
          return handleSocialScanAll(job as Job<SocialMonitorJobPayload & { type: "social-scan-all" }>);
        case "whatsapp-status-scan":
          return handleWhatsappStatusScan(job as Job<SocialMonitorJobPayload & { type: "whatsapp-status-scan" }>);
        case "instagram-stories-scan":
          return handleInstagramStoriesScan(
            job as Job<SocialMonitorJobPayload & { type: "instagram-stories-scan" }>
          );
        case "group-message-process":
          return handleGroupMessageProcess(
            job as Job<SocialMonitorJobPayload & { type: "group-message-process" }>
          );
        case "trigger-evaluate":
          return handleTriggerEvaluate(
            job as Job<SocialMonitorJobPayload & { type: "trigger-evaluate" }>
          );
        case "track-from-promo":
          return handleTrackFromPromo(
            job as Job<SocialMonitorJobPayload & { type: "track-from-promo" }>
          );
      }
    },
    {
      connection: getRedis(),
      concurrency: 1,
      lockDuration: 3_600_000,
      stalledInterval: 120_000,
      maxStalledCount: 3,
    }
  );

  worker.on("completed", (job) => safeLog(`[social-worker] ${job.id} ok`));
  worker.on("failed", (job, err) => safeLog(`[social-worker] ${job?.id} falhou: ${err.message}`));
  console.log("[social-worker] rodando, escutando " + QUEUE_NAMES.SOCIAL);
  return worker;
}
