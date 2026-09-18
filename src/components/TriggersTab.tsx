import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/cn";
import { ShieldAlert, Loader2, Plus, Trash2, Radio, Zap, TrendingDown, Bell, Hash, Package } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface TriggersTabProps {
  addToast: (message: string, type: ToastType, details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
  pollJob: (jobId: string, signal?: AbortSignal, intervalMs?: number, timeoutMs?: number, queue?: string) => Promise<any>;
}

interface Trigger {
  id: string;
  name: string;
  entityType: "product" | "keyword" | "promo";
  condition: "price_lte" | "price_drop_pct" | "contains" | "new_promo" | "price_trend";
  value: string;
  channels: string;
  enabled: boolean;
  lastFiredAt?: string;
  createdAt: string;
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

const CONDITION_INFO: Record<string, { label: string; desc: string; icon: React.ReactNode }> = {
  price_lte: { label: "PREÇO ≤", desc: "Produto com preço abaixo do valor", icon: <Package size={12} /> },
  price_drop_pct: { label: "QUEDA %", desc: "Preço caiu mais que X%", icon: <TrendingDown size={12} /> },
  price_trend: { label: "TENDÊNCIA", desc: "Preço em queda consecutiva", icon: <TrendingDown size={12} /> },
  contains: { label: "CONTÉM", desc: "Promoção contém palavra-chave", icon: <Hash size={12} /> },
  new_promo: { label: "NOVA PROMO", desc: "Qualquer nova promoção detectada", icon: <Zap size={12} /> },
};

export function TriggersTab({ addToast, playSound, pollJob }: TriggersTabProps) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [evaluating, setEvaluating] = useState(false);

  const [newName, setNewName] = useState("");
  const [newEntity, setNewEntity] = useState<"product" | "keyword" | "promo">("keyword");
  const [newCondition, setNewCondition] = useState<Trigger["condition"]>("contains");
  const [newValue, setNewValue] = useState("");
  const [newChannels, setNewChannels] = useState("discord");

  const toast = (message: string, type: ToastType, details?: string) =>
    addToast(message, type, details);

  const loadTriggers = async () => {
    setLoading(true);
    try {
      const data = await apiJson("/api/triggers");
      setTriggers(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTriggers();
  }, []);

  const addTrigger = async () => {
    if (!newName.trim() || !newValue.trim()) return;
    try {
      await apiJson("/api/triggers", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          entityType: newEntity,
          condition: newCondition,
          value: newValue,
          channels: newChannels,
        }),
        headers: { "Content-Type": "application/json" },
      });
      toast("TRIGGER CRIADO", "success");
      setShowForm(false);
      setNewName("");
      setNewValue("");
      loadTriggers();
    } catch (err: any) {
      toast("FALHA AO CRIAR TRIGGER", "error", String(err?.message || err));
    }
  };

  const toggleTrigger = async (id: string) => {
    try {
      await apiJson(`/api/triggers/${id}/toggle`, { method: "POST" });
      loadTriggers();
    } catch (err: any) {
      toast("FALHA", "error", String(err?.message || err));
    }
  };

  const deleteTrigger = async (id: string) => {
    try {
      await apiJson(`/api/triggers/${id}`, { method: "DELETE" });
      toast("TRIGGER REMOVIDO", "info");
      loadTriggers();
    } catch (err: any) {
      toast("FALHA", "error", String(err?.message || err));
    }
  };

  const evaluateTriggers = async () => {
    setEvaluating(true);
    try {
      const { jobId } = await apiJson("/api/triggers/evaluate", { method: "POST" });
      await pollJob(jobId, undefined, 2000, 60_000, "social");
      toast("TRIGGERS AVALIADOS", "info");
      loadTriggers();
    } catch (err: any) {
      toast("FALHA", "error", String(err?.message || err));
    } finally {
      setEvaluating(false);
    }
  };

  const enabledCount = triggers.filter((t) => t.enabled).length;
  const firedCount = triggers.filter((t) => t.lastFiredAt).length;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <SectionTitle icon={<ShieldAlert size={20} />}>TRIGGERS — ALERTAS CONFIGURÁVEIS</SectionTitle>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { playSound("click"); evaluateTriggers(); }}
            disabled={evaluating}
            className="hud-button flex items-center gap-2 text-[10px] disabled:opacity-50"
          >
            {evaluating ? <Loader2 size={12} className="animate-spin" /> : <Radio size={12} />}
            {evaluating ? "AVALIANDO..." : "AVALIAR AGORA"}
          </button>
          <button
            onClick={() => { playSound("click"); setShowForm(!showForm); }}
            className="hud-button flex items-center gap-2"
          >
            <Plus size={14} /> NOVO TRIGGER
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="hud-border bg-black/40 p-3 text-center">
          <span className="text-xl font-mono font-bold text-crimson">{triggers.length}</span>
          <p className="text-[9px] font-mono text-crimson/50 mt-1">TOTAL</p>
        </div>
        <div className="hud-border bg-black/40 p-3 text-center">
          <span className="text-xl font-mono font-bold text-green-500">{enabledCount}</span>
          <p className="text-[9px] font-mono text-crimson/50 mt-1">ATIVOS</p>
        </div>
        <div className="hud-border bg-black/40 p-3 text-center">
          <span className="text-xl font-mono font-bold text-amber-500">{firedCount}</span>
          <p className="text-[9px] font-mono text-crimson/50 mt-1">DISPARADOS</p>
        </div>
      </div>

      {/* Form */}
      <AnimatePresence>
        {showForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="hud-border bg-black/40 p-5 overflow-hidden"
          >
            <h3 className="font-mono text-xs font-bold text-crimson/70 mb-3">NOVO TRIGGER</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-mono text-crimson/50">NOME</label>
                <input
                  className="hud-input"
                  placeholder="Ex: Arroz abaixo de R$20"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-mono text-crimson/50">TIPO</label>
                <select
                  className="hud-input"
                  value={newEntity}
                  onChange={(e) => {
                    const v = e.target.value as typeof newEntity;
                    setNewEntity(v);
                    if (v === "keyword") setNewCondition("contains");
                    else if (v === "product") setNewCondition("price_lte");
                    else setNewCondition("new_promo");
                  }}
                >
                  <option value="keyword">KEYWORD (contém texto)</option>
                  <option value="product">PRODUCT (preço / tendência)</option>
                  <option value="promo">PROMO (nova promoção)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-mono text-crimson/50">CONDIÇÃO</label>
                <select
                  className="hud-input"
                  value={newCondition}
                  onChange={(e) => setNewCondition(e.target.value as Trigger["condition"])}
                >
                  {newEntity === "keyword" && <option value="contains">CONTÉM (keyword)</option>}
                  {newEntity === "product" && (
                    <>
                      <option value="price_lte">PREÇO ≤ (valor absoluto)</option>
                      <option value="price_drop_pct">QUEDA % (queda percentual)</option>
                      <option value="price_trend">TENDÊNCIA (queda consecutiva)</option>
                    </>
                  )}
                  {newEntity === "promo" && <option value="new_promo">NOVA PROMO (qualquer)</option>}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-mono text-crimson/50">VALOR</label>
                <input
                  className="hud-input"
                  placeholder={
                    newCondition === "contains" ? "arroz,leite,café" :
                    newCondition === "price_lte" ? "19.90" :
                    newCondition === "price_drop_pct" ? "15" :
                    newCondition === "price_trend" ? "3" :
                    "true"
                  }
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                />
                <span className="text-[8px] font-mono text-crimson/30">
                  {newCondition === "price_trend" ? "Nº mínimo de quedas consecutivas" : ""}
                </span>
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <label className="text-[9px] font-mono text-crimson/50">CANAIS (separados por vírgula)</label>
                <input
                  className="hud-input"
                  placeholder="discord,telegram"
                  value={newChannels}
                  onChange={(e) => setNewChannels(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setShowForm(false)}
                className="hud-button text-[10px] text-crimson/50"
              >
                CANCELAR
              </button>
              <button
                onClick={() => { playSound("click"); addTrigger(); }}
                className="hud-button flex items-center gap-2"
              >
                <Plus size={14} /> CRIAR TRIGGER
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      {loading ? (
        <div className="hud-border bg-black/40 p-10 flex flex-col items-center gap-4">
          <Loader2 size={24} className="animate-spin text-crimson" />
          <span className="text-xs font-mono text-crimson/50">CARREGANDO...</span>
        </div>
      ) : triggers.length === 0 ? (
        <div className="hud-border p-10 text-center text-crimson/30 font-mono">
          NENHUM TRIGGER CONFIGURADO
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {triggers.map((t) => {
            const info = CONDITION_INFO[t.condition] || { label: t.condition, desc: "", icon: <Zap size={12} /> };
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="hud-border bg-black/40 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-crimson/70 font-bold">{t.name}</span>
                      {!t.enabled && (
                        <span className="text-[7px] font-mono text-crimson/30 border border-crimson/20 px-1">OFF</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-[8px] font-mono px-1.5 py-0.5 border",
                        t.entityType === "product" ? "border-blue-500/30 text-blue-500" :
                        t.entityType === "keyword" ? "border-green-500/30 text-green-500" :
                        "border-amber-500/30 text-amber-500"
                      )}>
                        {info.icon} {info.label}
                      </span>
                      <span className="text-[9px] font-mono text-crimson/40">
                        Valor: <span className="text-crimson/60">{t.value}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[8px] font-mono text-crimson/30">
                      <span>Canais: {t.channels}</span>
                      {t.lastFiredAt && (
                        <span>Último disparo: {new Date(t.lastFiredAt).toLocaleString("pt-BR")}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { playSound("click"); toggleTrigger(t.id); }}
                      className={cn(
                        "text-[9px] font-mono px-2 py-1 border",
                        t.enabled ? "border-green-500/30 text-green-500" : "border-crimson/30 text-crimson/40"
                      )}
                    >
                      {t.enabled ? "ON" : "OFF"}
                    </button>
                    <button
                      onClick={() => { playSound("click"); deleteTrigger(t.id); }}
                      className="text-crimson/50 hover:text-crimson transition-colors p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
