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
//   - Configure throttle (scan_per_contact_min = 20m) — nunca em loops apertados.
//   - Manter a sessão persistida evita re-logins repetidos (gatilho principal de ban).
//   - Habilite apenas via .env: WHATSAPP_ENABLED=true + SOCIAL_MONITORING_ENABLED=true
//
// O usuário deste projeto ACEITA todos os riscos acima. A integração foi feita
// isolada para ser fácil de desligar: basta WHATSAPP_ENABLED=false (default).
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
  // Sessão persistida em disco sob DATA_DIR (criado por db.ts)
  const { Client, LocalAuth } = await import("whatsapp-web.js");
  sessionInstance = new Client({
    authStrategy: new LocalAuth({ dataPath: undefined }), // default .wwebjs_auth
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
  await sessionInstance.initialize();
}

// Tenta buscar o texto do Status de um contato. whatsapp-web.js não expõe
// diretamente um getter de Status — usamos workaround parseando o	display
// do "status message" se acessível. Retorna [] se nada disponível.
export async function fetchContactStatuses(whatsappNumbers: string[]): Promise<
  { whatsappNumber: string; statusText?: string; capturedAt: string }[]
> {
  if (!sessionInstance) throw new Error("WhatsApp sessão não inicializada");
  const results: { whatsappNumber: string; statusText?: string; capturedAt: string }[] = [];
  for (const num of whatsappNumbers) {
    try {
      // Cada número precisa ser formatado como "numero@c.us"
      const chatId = num.replace(/[^\d]/g, "") + "@c.us";
      // Tentativa de leitura do Status via getContacts/getChats
      const chats = await sessionInstance.getChats();
      const statusChat = chats.find((c: any) => c.id && c.id._serialized === "status@broadcast");
      if (!statusChat) continue;
      const messages = await statusChat.fetchMessages({ limit: 50 });
      // Filtrar mensagens do contato específico (autor do Status)
      const fromContact = messages.filter(
        (m: any) => m.author && m.author.replace(/[^\d]/g, "") === num.replace(/[^\d]/g, "")
      );
      for (const m of fromContact.slice(0, 5)) {
        const text = (m.body || "").toString().trim();
        if (text) {
          results.push({ whatsappNumber: num, statusText: text, capturedAt: new Date().toISOString() });
        }
      }
    } catch (err: any) {
      safeLog(`[whatsapp] erro lendo Status de ${num}: ${err.message}`);
    }
  }
  return results;
}

export async function isWhatsappReady(): Promise<boolean> {
  return !!sessionInstance && (await sessionInstance.getState?.()) === "CONNECTED";
}
