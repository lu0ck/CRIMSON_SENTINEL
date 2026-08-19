import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Radio,
  Loader2,
  Plus,
  Trash2,
  Send,
  ScanLine,
  Store,
  MessageSquare,
  Instagram,
  CheckCircle2,
  ShieldAlert,
  Clock,
  QrCode,
  LogIn,
} from "lucide-react";

type ToastType = "success" | "error" | "info";

interface SocialTabProps {
  addToast: (message: string, type: ToastType, details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
  pollJob: (jobId: string, signal?: AbortSignal, intervalMs?: number, timeoutMs?: number, queue?: string) => Promise<any>;
}

interface SocialSource {
  id: string;
  channel: "whatsapp" | "instagram";
  name: string;
  url?: string;
  establishmentHint?: string;
  enabled?: boolean;
  lastCheckedAt?: string;
}

async function apiJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-sm font-bold text-crimson glow-text tracking-widest flex items-center gap-2">
      {icon}
      {children}
    </h2>
  );
}

export function SocialTab({ addToast, playSound, pollJob }: SocialTabProps) {
  const [sources, setSources] = useState<SocialSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [scanning, setScanning] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [newChannel, setNewChannel] = useState<"whatsapp" | "instagram">("whatsapp");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newHint, setNewHint] = useState("");

  const [pasteText, setPasteText] = useState("");

  // Configuração do agendamento (FASE 9)
  const [intervalMs, setIntervalMs] = useState<number>(6 * 60 * 60 * 1000);
  const [nextSocialScanMinutes, setNextSocialScanMinutes] = useState<number | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);

  // ---- WhatsApp real (C2 — whatsapp-web.js) ----
  const [waEnabled, setWaEnabled] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [waQrAnsi, setWaQrAnsi] = useState<string | null>(null);
  const [waQrStatus, setWaQrStatus] = useState<string | null>(null);
  const [waQrLoading, setWaQrLoading] = useState(false);
  const [waScanning, setWaScanning] = useState(false);
  const [waToggling, setWaToggling] = useState(false);

  // ---- Instagram Stories (C3 — instagrapi) ----
  const [igEnabled, setIgEnabled] = useState(false);
  const [igOk, setIgOk] = useState(false);
  const [igSessionLoaded, setIgSessionLoaded] = useState(false);
  const [igUsername, setIgUsername] = useState<string | undefined>(undefined);
  const [igHealthLoading, setIgHealthLoading] = useState(true);
  const [igLoginLoading, setIgLoginLoading] = useState(false);
  const [igScanning, setIgScanning] = useState(false);

  // ---- Instagram credentials (sem .env) ----
  const [igHasCredentials, setIgHasCredentials] = useState(false);
  const [igUserInput, setIgUserInput] = useState("");
  const [igPassInput, setIgPassInput] = useState("");
  const [igSavingCreds, setIgSavingCreds] = useState(false);
  const [igShowPass, setIgShowPass] = useState(false);

  const toast = (message: string, type: ToastType, details?: string) =>
    addToast(message, type, details);

  const loadSocialSettings = async () => {
    try {
      const data = await apiJson("/api/social/settings");
      setIntervalMs(data.intervalMs);
    } catch {
      // settings indisponíveis — mantém default
    }
  };

  const loadStatus = async () => {
    try {
      const data = await apiJson("/api/status");
      setNextSocialScanMinutes(data.nextSocialScanMinutes ?? null);
    } catch {
      setNextSocialScanMinutes(null);
    }
  };

  const loadSources = async () => {
    setLoading(true);
    try {
      const data = await apiJson("/api/social/sources");
      setSources(data);
    } catch (err: any) {
      toast("FALHA AO CARREGAR FONTES SOCIAIS", "error", String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const loadWhatsAppStatus = async () => {
    try {
      const data = await apiJson("/api/social/whatsapp/status");
      setWaEnabled(!!data.enabled);
      setWaReady(!!data.ready);
    } catch {
      // flag desligada ou erro — mantém defaults
    }
  };

  const toggleWhatsApp = async (enabled: boolean) => {
    setWaToggling(true);
    try {
      await apiJson("/api/social/whatsapp/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setWaEnabled(enabled);
      toast(enabled ? "WHATSAPP ATIVADO" : "WHATSAPP DESATIVADO", "success");
    } catch (err: any) {
      toast("FALHA AO ALTERAR WHATSAPP", "error", String(err?.message || err));
    } finally {
      setWaToggling(false);
    }
  };

  const loadInstagramHealth = async () => {
    try {
      const data = await apiJson("/api/social/instagram/health");
      setIgEnabled(!!data.enabled);
      setIgOk(!!data.ok);
      setIgSessionLoaded(!!data.sessionLoaded);
      setIgUsername(data.username);
    } catch {
      // mantém defaults
    } finally {
      setIgHealthLoading(false);
    }
  };

  const loadIgCredentials = async () => {
    try {
      const data = await apiJson("/api/social/instagram/credentials");
      setIgHasCredentials(!!data.username);
      if (data.username) setIgUserInput(data.username);
    } catch {
      // ignora
    }
  };

  const saveIgCredentials = async () => {
    if (!igUserInput.trim() || !igPassInput.trim()) {
      toast("PREENCHA USUÁRIO E SENHA", "error");
      return;
    }
    setIgSavingCreds(true);
    try {
      await apiJson("/api/social/instagram/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: igUserInput.trim(), password: igPassInput.trim() }),
      });
      toast("INSTAGRAM CONFIGURADO", "success", "Serviço será iniciado automaticamente");
      setIgHasCredentials(true);
      setIgPassInput("");
      // Aguarda o serviço subir e re-verifica saúde
      setTimeout(() => loadInstagramHealth(), 4000);
    } catch (err: any) {
      toast("FALHA AO SALVAR", "error", String(err?.message || err));
    } finally {
      setIgSavingCreds(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadSocialSettings();
    loadStatus();
    loadWhatsAppStatus();
    loadIgCredentials();
    loadInstagramHealth();
    const t = setInterval(() => {
      loadStatus();
      loadWhatsAppStatus();
      loadInstagramHealth();
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const addSource = async () => {
    if (!newName.trim()) return;
    try {
      await apiJson("/api/social/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: newChannel,
          name: newName.trim(),
          url: newUrl.trim() || undefined,
          establishmentHint: newHint.trim() || undefined,
          enabled: true,
        }),
      });
      toast("FONTE SOCIAL ADICIONADA", "success");
      setNewName(""); setNewUrl(""); setNewHint("");
      setShowForm(false);
      loadSources();
    } catch (err: any) {
      toast("FALHA AO ADICIONAR FONTE", "error", String(err?.message || err));
    }
  };

  const removeSource = async (id: string) => {
    try {
      await apiJson(`/api/social/sources/${id}`, { method: "DELETE" });
      toast("FONTE REMOVIDA", "info");
      loadSources();
    } catch (err: any) {
      toast("FALHA AO REMOVER FONTE", "error", String(err?.message || err));
    }
  };

  const runCapture = async (payload: any) => {
    try {
      const { jobId } = await apiJson("/api/social/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await pollJob(jobId, undefined, 2000, 180_000, "social");
      return result;
    } catch (err: any) {
      throw err;
    }
  };

  const capturePasted = async () => {
    if (!pasteText.trim() || capturing) return;
    setCapturing(true);
    try {
      const result = await runCapture({ channel: "whatsapp", text: pasteText });
      const saved = result?.saved?.length || 0;
      const dup = result?.skippedDuplicates?.length || 0;
      toast(`CAPTURA: ${saved} PROMOÇÃO(ÕES)`, saved > 0 ? "success" : "info", dup ? `${dup} duplicada(s)` : undefined);
      setPasteText("");
    } catch (err: any) {
      toast("FALHA NA CAPTURA", "error", String(err?.message || err));
    } finally {
      setCapturing(false);
    }
  };

  const scanAll = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const { jobId } = await apiJson("/api/social/scan-all", { method: "POST" });
      const result = await pollJob(jobId, undefined, 2000, 180_000, "social");
      toast(`SCAN CONCLUÍDO — ${result?.sources || 0} FONTE(S)`, "info");
    } catch (err: any) {
      toast("FALHA NO SCAN", "error", String(err?.message || err));
    } finally {
      setScanning(false);
    }
  };

  const generateWhatsAppQr = async () => {
    if (waQrLoading) return;
    setWaQrLoading(true);
    setWaQrAnsi(null);
    setWaQrStatus(null);
    try {
      // Poll até o QR estar pronto (máx 15s)
      let attempts = 0;
      let data: any = null;
      while (attempts < 15) {
        data = await apiJson("/api/social/whatsapp/qr");
        if (data.status === "qr" || data.status === "ready" || data.status === "pending_no_session") break;
        if (data.status === "pending") {
          setWaQrStatus("Iniciando sessão WhatsApp...");
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;
          continue;
        }
        break;
      }
      if (!data) {
        toast("FALHA AO GERAR QR", "error", "Timeout aguardando sessão");
        return;
      }
      setWaQrAnsi(data.qrAnsi ?? null);
      setWaQrStatus(data.message ?? null);
      if (data.status === "qr") {
        playSound("scan");
        toast("QR DO WHATSAPP GERADO", "info", "Escaneie com o WhatsApp do número secundário");
      } else if (data.status === "ready") {
        setWaReady(true);
        toast("WHATSAPP JÁ AUTENTICADO", "success");
      } else if (data.status === "pending") {
        setWaQrStatus("QR não disponível ainda. Tente novamente em alguns segundos.");
      }
      loadWhatsAppStatus();
    } catch (err: any) {
      toast("FALHA AO GERAR QR", "error", String(err?.message || err));
    } finally {
      setWaQrLoading(false);
    }
  };

  const scanWhatsApp = async () => {
    if (waScanning) return;
    setWaScanning(true);
    try {
      const { jobId } = await apiJson("/api/social/whatsapp/scan", { method: "POST" });
      const result = await pollJob(jobId, undefined, 2000, 180_000, "social");
      const n = Number(result?.saved ?? 0);
      toast(`SCAN WHATSAPP CONCLUÍDO — ${n} PROMOÇÃO(ÕES)`, n > 0 ? "success" : "info");
      loadWhatsAppStatus();
    } catch (err: any) {
      toast("FALHA NO SCAN WHATSAPP", "error", String(err?.message || err));
    } finally {
      setWaScanning(false);
    }
  };

  const loginInstagram = async () => {
    if (igLoginLoading) return;
    setIgLoginLoading(true);
    try {
      const data = await apiJson("/api/social/instagram/login", { method: "POST" });
      if (data.status === "ok") {
        toast("LOGIN INSTAGRAM OK", "success", "Sessão autenticada com sucesso");
      } else {
        toast("LOGIN INSTAGRAM FALHOU", "error", "Verifique o usuário e senha configurados");
      }
      loadInstagramHealth();
    } catch (err: any) {
      toast("FALHA NO LOGIN INSTAGRAM", "error", String(err?.message || err));
    } finally {
      setIgLoginLoading(false);
    }
  };

  const scanInstagram = async () => {
    if (igScanning) return;
    setIgScanning(true);
    try {
      const { jobId } = await apiJson("/api/social/instagram/scan", { method: "POST" });
      const result = await pollJob(jobId, undefined, 2000, 180_000, "social");
      const n = Number(result?.saved ?? 0);
      toast(`SCAN INSTAGRAM CONCLUÍDO — ${n} PROMOÇÃO(ÕES)`, n > 0 ? "success" : "info");
      loadInstagramHealth();
    } catch (err: any) {
      toast("FALHA NO SCAN INSTAGRAM", "error", String(err?.message || err));
    } finally {
      setIgScanning(false);
    }
  };

  const updateInterval = async (ms: number) => {
    setSavingInterval(true);
    try {
      await apiJson("/api/social/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMs: ms }),
      });
      setIntervalMs(ms);
      toast(`SCAN SOCIAL A CADA ${Math.round(ms / 60000)} MIN`, "success");
    } catch (err: any) {
      toast("FALHA AO SALVAR AGENDAMENTO", "error", String(err?.message || err));
    } finally {
      setSavingInterval(false);
    }
  };

  const fmtNextScan = (mins: number | null) => {
    if (mins === null) return "SEM AGENDAMENTO";
    if (mins <= 0) return "AGORA";
    if (mins >= 1440) return `EM ${Math.round(mins / 1440)} DIAS`;
    if (mins >= 60) return `EM ${Math.floor(mins / 60)}H ${mins % 60}MIN`;
    return `EM ${mins} MIN`;
  };

  const channelIcon = (c: string) =>
    c === "instagram" ? <Instagram size={14} /> : <MessageSquare size={14} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-mono font-bold glow-text flex items-center gap-3">
          <Radio size={24} />
          MONITORAMENTO SOCIAL
        </h1>
        <span className="text-xs font-mono text-crimson/50 tracking-widest">
          WHATSAPP + INSTAGRAM
        </span>
      </div>

      {/* ===== FONTES CONFIGURADAS ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<Radio size={16} />}>FONTES MONITORADAS ({sources.length})</SectionTitle>
          <div className="flex items-center gap-3">
            {nextSocialScanMinutes !== null && (
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-crimson/50">
                <Clock size={12} />
                <span>PRÓXIMO SCAN {fmtNextScan(nextSocialScanMinutes)}</span>
              </div>
            )}
            <select
              className="hud-input w-auto! text-[10px] py-1 px-2"
              value={intervalMs}
              disabled={savingInterval}
              onChange={(e) => updateInterval(Number(e.target.value))}
              title="Frequência do scan automático"
            >
              <option value={60 * 60 * 1000}>SCAN A CADA 1H</option>
              <option value={6 * 60 * 60 * 1000}>SCAN A CADA 6H</option>
              <option value={12 * 60 * 60 * 1000}>SCAN A CADA 12H</option>
              <option value={24 * 60 * 60 * 1000}>SCAN A CADA 24H</option>
            </select>
            <button
              onClick={() => { playSound("click"); scanAll().catch(() => {}); }}
              disabled={scanning}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
            >
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
              {scanning ? "ESCANEANDO..." : "SCAN ALL"}
            </button>
            <button
              onClick={() => { playSound("click"); setShowForm(!showForm); }}
              className="hud-button flex items-center gap-2"
            >
              <Plus size={16} /> ADICIONAR FONTE
            </button>
          </div>
        </div>

        <AnimatePresence>
          {showForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="hud-border bg-black/40 p-5 mt-4 overflow-hidden"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50">CANAL</label>
                  <select
                    className="hud-input"
                    value={newChannel}
                    onChange={(e) => setNewChannel(e.target.value as any)}
                  >
                    <option value="whatsapp">WHATSAPP</option>
                    <option value="instagram">INSTAGRAM</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50">NOME</label>
                  <input
                    className="hud-input"
                    placeholder="Ex: Grupo Promoções do Bairro"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50">URL INSTAGRAM (OPCIONAL)</label>
                  <input
                    className="hud-input"
                    placeholder="https://instagram.com/..."
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50">ESTABELECIMENTO (OPCIONAL)</label>
                  <input
                    className="hud-input"
                    placeholder="Ex: Mercado Bom Preço"
                    value={newHint}
                    onChange={(e) => setNewHint(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={() => { playSound("click"); addSource(); }} className="hud-button">
                  SALVAR FONTE
                </button>
                <button onClick={() => setShowForm(false)} className="hud-button">CANCELAR</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {loading ? (
          <div className="hud-border bg-black/40 p-10 flex flex-col items-center gap-4 mt-4">
            <Loader2 size={24} className="animate-spin text-crimson" />
            <span className="text-xs font-mono text-crimson/50">CARREGANDO FONTES...</span>
          </div>
        ) : sources.length === 0 ? (
          <div className="hud-border p-10 text-center text-crimson/30 font-mono mt-4">
            NENHUMA FONTE CADASTRADA — ADICIONE UM GRUPO DE WHATSAPP OU PERFIL DO INSTAGRAM
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            {sources.map((s) => (
              <motion.div
                key={s.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="hud-border bg-black/40 p-4 flex items-start justify-between gap-4"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {channelIcon(s.channel)}
                    <span className="font-mono text-sm font-bold">{s.name.toUpperCase()}</span>
                    {s.enabled === false && <span className="text-[8px] font-mono text-crimson/40 border border-crimson/30 px-1">OFF</span>}
                  </div>
                  {s.url && (
                    <span className="text-[10px] font-mono text-crimson/50 truncate">{s.url}</span>
                  )}
                  {s.establishmentHint && (
                    <span className="text-[10px] font-mono text-crimson/40 flex items-center gap-1">
                      <Store size={10} /> {s.establishmentHint.toUpperCase()}
                    </span>
                  )}
                  {s.lastCheckedAt && (
                    <span className="text-[9px] font-mono text-crimson/30">
                      ÚLTIMO SCAN: {new Date(s.lastCheckedAt).toLocaleString("pt-BR")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => { playSound("click"); runCapture({ channel: s.channel, sourceId: s.id, url: s.url, profileId: undefined }).then((r) => {
                      const n = r?.saved?.length || 0;
                      toast(`CAPTURA ${s.name.toUpperCase()}: ${n} PROMOÇÃO(ÕES)`, n > 0 ? "success" : "info");
                    }).catch((e: any) => toast("FALHA NA CAPTURA", "error", String(e?.message || e))); }}
                    className="hud-button flex items-center gap-2"
                    title="Capturar agora"
                  >
                    <Send size={14} /> CAPTURAR
                  </button>
                  <button
                    onClick={() => { playSound("click"); removeSource(s.id); }}
                    className="text-crimson/50 hover:text-crimson transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* ===== CAPTURA DE TEXTO (WHATSAPP) ===== */}
      <section>
        <SectionTitle icon={<MessageSquare size={16} />}>CAPTURA MANUAL — COLE A MENSAGEM</SectionTitle>
        <div className="hud-border bg-black/40 p-5 mt-4 flex flex-col gap-3">
          <textarea
            className="hud-input w-full min-h-[120px] font-mono text-xs"
            placeholder={"Cole aqui a mensagem do grupo de promoções:\n\nCafé 500g de R$ 24,90 por R$ 17,90\nArroz 5kg por apenas R$ 22,90 (Mercado Bom Preço)\nLeite 1L - R$ 4,99 (30% OFF)"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="flex justify-end">
            <button
              onClick={() => { playSound("click"); capturePasted(); }}
              disabled={capturing || !pasteText.trim()}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
            >
              {capturing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {capturing ? "PROCESSANDO..." : "EXTRAIR PROMOÇÕES"}
            </button>
          </div>
        </div>
      </section>

      {/* ===== WHATSAPP REAL (C2 — whatsapp-web.js) ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<MessageSquare size={16} />}>WHATSAPP REAL — STATUS DOS CONTATOS</SectionTitle>
          <div className="flex items-center gap-2">
            <span className={cn("text-[9px] font-mono", waEnabled ? (waReady ? "text-green-500" : "text-amber-500") : "text-crimson/40")}>
              {waEnabled ? (waReady ? "● CONECTADO" : "○ NÃO AUTENTICADO") : "● DESLIGADO"}
            </span>
            {waEnabled && (
              <button
                onClick={() => { playSound("click"); toggleWhatsApp(false).catch(() => {}); }}
                disabled={waToggling}
                className="hud-button flex items-center gap-2 text-red-400 disabled:opacity-50"
              >
                DESATIVAR
              </button>
            )}
            <button
              onClick={() => { playSound("click"); generateWhatsAppQr().catch(() => {}); }}
              disabled={waQrLoading || !waEnabled}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
              title="Gera/atualiza o QR de conexão"
            >
              {waQrLoading ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}
              {waQrLoading ? "GERANDO..." : "GERAR QR"}
            </button>
            <button
              onClick={() => { playSound("click"); scanWhatsApp().catch(() => {}); }}
              disabled={waScanning || !waReady}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
            >
              {waScanning ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
              {waScanning ? "ESCANEANDO..." : "SCAN STATUS"}
            </button>
          </div>
        </div>

        <div className="hud-border bg-black/40 p-5 mt-4">
          {!waEnabled ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <MessageSquare size={14} className="text-crimson shrink-0 mt-0.5" />
                <p className="text-[10px] font-mono text-crimson/70 leading-relaxed">
                  Ative o WhatsApp para monitorar Status dos contatos cadastrados.
                  Use sempre um número secundário — existe risco de banimento.
                </p>
              </div>
              <button
                onClick={() => { playSound("click"); toggleWhatsApp(true).catch(() => {}); }}
                disabled={waToggling}
                className="hud-button self-start flex items-center gap-2 disabled:opacity-50"
              >
                {waToggling ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {waToggling ? "ATIVANDO..." : "ATIVAR WHATSAPP"}
              </button>
            </div>
          ) : waReady ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-green-500">
                <CheckCircle2 size={14} /> SESSÃO AUTENTICADA — PRONTO PARA SCAN DE STATUS
              </div>
              <p className="text-[9px] font-mono text-crimson/40">
                O SCAN LÊ OS STATUS DOS CONTATOS EM establishments.whatsapp_number E EXTRAI PROMOÇÕES
                (throttle configurável em user_settings.whatsapp_scan_per_contact_min).
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[10px] font-mono text-crimson/50 leading-relaxed">
                Abra o WhatsApp no celular (número secundário) → Configurações → Aparelhos conectados →
                Conectar aparelho → aponte a câmera para o QR abaixo.
              </p>
              {waQrAnsi ? (
                <div className="flex flex-col items-center gap-2">
                  <pre className="font-mono text-[6px] leading-[1.1] text-crimson whitespace-pre">{waQrAnsi}</pre>
                  <span className="text-[9px] font-mono text-crimson/40">ESCANEIE COM O WHATSAPP DO CELULAR</span>
                </div>
              ) : (
                <p className="text-[10px] font-mono text-crimson/40">{waQrStatus ?? "NENHUM QR DISPONÍVEL AINDA — CLIQUE EM GERAR QR"}</p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ===== INSTAGRAM STORIES (C3 — instagrapi) ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<Instagram size={16} />}>INSTAGRAM — STORIES COM PREÇO</SectionTitle>
          {igHasCredentials && (
            <div className="flex items-center gap-2">
              <span className={cn("text-[9px] font-mono", !igOk ? "text-red-500" : igSessionLoaded ? "text-green-500" : "text-amber-500")}>
                {!igOk ? "● INICIANDO" : igSessionLoaded ? "● CONECTADO" : "○ SEM SESSÃO"}
              </span>
              <button
                onClick={() => { playSound("click"); loginInstagram().catch(() => {}); }}
                disabled={igLoginLoading || !igOk}
                className="hud-button flex items-center gap-2 disabled:opacity-50"
              >
                {igLoginLoading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                {igLoginLoading ? "LOGGING..." : "LOGIN"}
              </button>
              <button
                onClick={() => { playSound("click"); scanInstagram().catch(() => {}); }}
                disabled={igScanning || !igOk || !igSessionLoaded}
                className="hud-button flex items-center gap-2 disabled:opacity-50"
              >
                {igScanning ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
                {igScanning ? "ESCANEANDO..." : "SCAN STORIES"}
              </button>
            </div>
          )}
        </div>

        <div className="hud-border bg-black/40 p-5 mt-4">
          {!igHasCredentials ? (
            /* Sem credenciais — formulário de configuração */
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <Instagram size={14} className="text-crimson shrink-0 mt-0.5" />
                <p className="text-[10px] font-mono text-crimson/70 leading-relaxed">
                  Configure sua conta secundária do Instagram para monitorar Stories com preços.
                  Use sempre uma conta dedicada — existe risco de banimento.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50 tracking-widest">USUÁRIO</label>
                  <input
                    type="text"
                    value={igUserInput}
                    onChange={(e) => setIgUserInput(e.target.value)}
                    placeholder="seu_usuario_secundario"
                    className="hud-input text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] font-mono text-crimson/50 tracking-widest">SENHA</label>
                  <div className="flex gap-1">
                    <input
                      type={igShowPass ? "text" : "password"}
                      value={igPassInput}
                      onChange={(e) => setIgPassInput(e.target.value)}
                      placeholder="••••••••"
                      className="hud-input text-xs flex-1"
                    />
                    <button
                      onClick={() => setIgShowPass(!igShowPass)}
                      className="hud-button px-2 text-[10px]"
                      title={igShowPass ? "Ocultar" : "Mostrar"}
                    >
                      {igShowPass ? "◉" : "○"}
                    </button>
                  </div>
                </div>
              </div>
              <button
                onClick={() => { playSound("click"); saveIgCredentials().catch(() => {}); }}
                disabled={igSavingCreds || !igUserInput.trim() || !igPassInput.trim()}
                className="hud-button self-start flex items-center gap-2 disabled:opacity-50"
              >
                {igSavingCreds ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {igSavingCreds ? "SALVANDO..." : "SALVAR E INICIAR"}
              </button>
            </div>
          ) : igHealthLoading ? (
            <div className="flex items-center gap-3 text-crimson/50 font-mono text-xs">
              <Loader2 size={14} className="animate-spin" /> VERIFICANDO SERVIÇO...
            </div>
          ) : !igOk ? (
            <div className="flex items-start gap-3">
              <Loader2 size={14} className="text-amber-500 animate-spin shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-amber-500/70 leading-relaxed">
                Serviço iniciando... caso não conecte em alguns segundos, reinicie o app.
              </p>
            </div>
          ) : !igSessionLoaded ? (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-mono text-amber-500/80">
                Serviço ativo. Clique em LOGIN para autenticar.
              </p>
              <p className="text-[9px] font-mono text-crimson/40">
                Usuário: @{igUserInput.toUpperCase() || igUsername?.toUpperCase()}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-green-500">
                <CheckCircle2 size={14} /> SESSÃO ATIVA {igUsername ? `— @${igUsername.toUpperCase()}` : ""}
              </div>
              <p className="text-[9px] font-mono text-crimson/40">
                O SCAN LÊ OS STORIES DOS HANDLES EM establishments.instagram_handle E EXTRAI PREÇOS VIA GEMINI VISION.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ===== AVISO DE CAPACIDADE ===== */}
      <div className="border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
        <ShieldAlert size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[10px] font-mono text-amber-500/70 leading-relaxed">
          SENTINEL CAPTURA PROMOÇÕES VIA TEXTO COLADO (WHATSAPP), STATUS REAIS (whatsapp-web.js, C2),
          STORIES (instagrapi + GEMINI VISION, C3) E CAPTIONS DE PERFIS PÚBLICOS. AS PROMOÇÕES
          DETECTADAS SÃO SALVAS NA ABA LOCAL E DISPARAM ALERTAS NOS CANAIS CONFIGURADOS. MÓDULOS C2/C3
          EXIGEM CONTA SECUNDÁRIA E PODEM RESULTAR EM BANIMENTO — USE COM DISCERNIMENTO.
        </p>
      </div>
    </div>
  );
}

function cn(...inputs: (string | false | null | undefined)[]) {
  return inputs.filter(Boolean).join(" ");
}
