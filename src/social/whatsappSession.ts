// ⚠️ AVISO IMPORTANTE — LEIA ANTES DE USAR ⚠️
//
// Este módulo usa a biblioteca NÃO-OFICIAL `whatsapp-web.js` que se conecta
// ao WhatsApp via automação do navegador (Puppeteer). Isso VIOLA os Termos de
// Serviço do WhatsApp e pode resultar em BANIMENTO PERMANENTE do número usado.
//
// RISCOS:
//   1. Bloqueio temporário ou banimento definitivo do número.
//   2. Perda de acesso à conta WhatsApp associada (mensagens, grupos, contatos).
//   3. Em casos extremos, suspensão da conta associada ao mesmo telefone (Facebook/Instagram/Meta).
//
// REGRAS OBRIGATÓRIAS para reduzir risco:
//   - Use SEMPRE um número secundário dedicado (chip pré-pago separado).
//   - NUNCA use seu número pessoal ou vinculado a contas profissionais.
//   - Manter a sessão persistida evita re-logins repetidos (gatilho principal de ban).
//   - Habilite apenas via painel social: whatsapp_enabled=true + social_monitoring_enabled=true
//
// O usuário deste projeto ACEITA todos os riscos acima. A integração foi feita
// isolada para ser fácil de desligar: basta whatsapp_enabled=false (default).
// =============================================================================

import { safeLog } from "../lib/safeLog";

// Lazy import — só carrega o whatsapp-web.js se de fato formos inicializar.
// Assim não quebra o worker quando a flag está desligada.
let ClientCtor: typeof import("whatsapp-web.js").default | null = null;
let qrcode: typeof import("qrcode-terminal") | null = null;

export async function loadWhatsAppLibs(): Promise<void> {
  if (ClientCtor && qrcode) return;
  try {
    const wa = await import("whatsapp-web.js");
    ClientCtor = wa.default;
    qrcode = await import("qrcode-terminal");
  } catch (err: any) {
    safeLog(`[whatsapp] lib não disponível: ${err.message}. Rode: npm install whatsapp-web.js qrcode-terminal`);
    throw err;
  }
}

// Event handlers — expondo via callbacks para o worker/sys master ouvir
export interface WhatsappSessionEvents {
  onQr: (qrText: string) => void;
  onAuthenticated: () => void;
  onReady: () => void;
  onAuthFailure: (msg: string) => void;
  onDisconnected: () => void;
  onGroupMessage?: (msg: {
    groupName: string;
    groupId: string;
    sender: string;
    text: string;
    receivedAt: string;
  }) => void;
  // Conversa direta (@c.us): texto ou imagem de flyer de promoção.
  onDirectMessage?: (msg: {
    chatId: string;
    sender: string;
    text?: string;
    imageBase64?: string;
    imageMimeType?: string;
    receivedAt: string;
  }) => void;
}

let sessionInstance: any = null;
let lastQr: string | null = null;
let lastQrAnsi: string | null = null;

export function getLastQr(): string | null {
  return lastQr;
}

export function getLastQrAnsi(): string | null {
  return lastQrAnsi;
}

export async function startWhatsappSession(events: WhatsappSessionEvents): Promise<void> {
  if (sessionInstance) return;
  await loadWhatsAppLibs();
  if (!ClientCtor || !qrcode) throw new Error("WhatsApp libs não carregadas");
  const wa = await import("whatsapp-web.js");
  const mod = wa.default || wa;
  const { Client, LocalAuth } = mod;
  sessionInstance = new Client({
    authStrategy: new LocalAuth({ dataPath: undefined }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });
  sessionInstance.on("qr", (qr: string) => {
    lastQr = qr;
    safeLog("[whatsapp] QR recebido — escaneie via endpoint GET /api/social/whatsapp/qr");
    qrcode!.generate(qr, { small: true }, (out: string) => {
      lastQrAnsi = out;
      safeLog("\n" + out);
    });
    events.onQr(qr);
  });
  sessionInstance.on("authenticated", () => {
    safeLog("[whatsapp] autenticado");
    lastQr = null;
    lastQrAnsi = null;
    events.onAuthenticated();
  });
  sessionInstance.on("ready", () => {
    safeLog("[whatsapp] pronto, sessão ativa");
    events.onReady();
  });
  sessionInstance.on("auth_failure", (msg: string) => {
    safeLog(`[whatsapp] FALHA de auth: ${msg}`);
    events.onAuthFailure(msg);
  });
  sessionInstance.on("disconnected", () => {
    safeLog("[whatsapp] desconectado — reset sessão");
    sessionInstance = null;
    lastQr = null;
    lastQrAnsi = null;
    events.onDisconnected();
  });

  // Message listener — mensagens de grupo e conversas diretas são repassadas.
  // Imagens (flyers de promoção) são baixadas automaticamente via downloadMedia.
  sessionInstance.on("message_create", async (msg: any) => {
    try {
      if (!msg.from || msg.fromMe) return;
      const isGroup = msg.from.endsWith("@g.us");
      const isDirect = msg.from.endsWith("@c.us");
      if (!isGroup && !isDirect) return;
      if (!events.onGroupMessage && !events.onDirectMessage) return;

      const receivedAt = new Date(msg.timestamp * 1000).toISOString();
      const text = (msg.body || "").toString();

      // Baixa mídia se houver (imagem/documento com flyer).
      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;
      if (msg.hasMedia && (msg.type === "image" || msg.type === "sticker" || msg.type === "document")) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            imageBase64 = media.data; // já vem em base64
            imageMimeType = media.mimetype || "image/jpeg";
            safeLog(`[whatsapp] mídia baixada de ${msg.from}: ${imageMimeType}`);
          }
        } catch (err: any) {
          safeLog(`[whatsapp] falha ao baixar mídia de ${msg.from}: ${err.message}`);
        }
      }

      // Ignora mensagens sem texto E sem mídia
      if (!text && !imageBase64) return;

      if (isGroup && events.onGroupMessage) {
        const chat = await msg.getChat();
        const contact = await msg.getContact();
        events.onGroupMessage({
          groupName: chat.name || msg.from,
          groupId: msg.from,
          sender: contact.pushname || contact.number || msg.author || "desconhecido",
          text,
          receivedAt,
        });
      } else if (isDirect && events.onDirectMessage) {
        const contact = await msg.getContact();
        events.onDirectMessage({
          chatId: msg.from,
          sender: contact.pushname || contact.number || msg.from,
          text: text || undefined,
          imageBase64,
          imageMimeType,
          receivedAt,
        });
      }
    } catch (err: any) {
      safeLog(`[whatsapp] erro no message listener: ${err.message}`);
    }
  });

  await sessionInstance.initialize();
}

export async function isWhatsappReady(): Promise<boolean> {
  return !!sessionInstance && (await sessionInstance.getState?.()) === "CONNECTED";
}

export async function fetchWhatsAppGroups(): Promise<{ id: string; name: string; members: number }[]> {
  if (!sessionInstance) return [];
  try {
    const chats = await sessionInstance.getChats();
    return chats
      .filter((c: any) => c.id && c.id._serialized?.endsWith("@g.us"))
      .map((c: any) => ({
        id: c.id._serialized,
        name: c.name || "Grupo sem nome",
        members: c.groupMetadata?.participants?.length ?? 0,
      }));
  } catch (err: any) {
    safeLog(`[whatsapp] erro listando grupos: ${err.message}`);
    return [];
  }
}

// #35 — envio dedicado para o chat do operador (@c.us). Mesma sessão do read
// path (singleton); NUNCA envia para grupos (@g.us) / broadcast. Envio separado
// da leitura de promoções (mesma sessão, chamada dedicada).
export async function sendWhatsappMessage(
  chatId: string,
  content: string
): Promise<{ ok: true; chatId: string }> {
  const id = (chatId || "").trim();
  if (!id) throw new Error("chatId vazio");
  if (id.endsWith("@g.us") || id.includes("broadcast")) {
    throw new Error("somente chat do operador (@c.us) — grupos/broadcast bloqueados");
  }
  if (!id.endsWith("@c.us")) {
    throw new Error("chatId inválido — esperado formato 5511999999999@c.us");
  }
  if (!content || !content.trim()) throw new Error("conteúdo vazio");
  if (!sessionInstance) throw new Error("sessão WhatsApp não iniciada — gere QR no painel social");
  const ready = await isWhatsappReady();
  if (!ready) throw new Error("sessão WhatsApp não conectada — aguarde ready ou relogue o QR");

  try {
    await sessionInstance.sendMessage(id, content);
    safeLog(`[whatsapp] mensagem enviada para operador ${id} (${content.length} chars)`);
    return { ok: true, chatId: id };
  } catch (err: any) {
    safeLog(`[whatsapp] falha ao enviar para ${id}: ${err.message}`);
    throw new Error(`falha ao enviar WhatsApp: ${err.message}`);
  }
}
