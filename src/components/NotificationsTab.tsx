import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Bell, ShieldAlert, Store, ShoppingCart, Percent, Loader2 } from "lucide-react";
import type { NotificationLogEntry } from "../repositories/notificationRepository";

interface NotificationsTabProps {
  addToast: (message: string, type?: "success" | "error" | "info", details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
}

async function apiJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const entityMeta = (entityType: string) => {
  switch (entityType) {
    case "product":
      return { icon: <Store size={14} />, label: "E-COMMERCE", color: "text-crimson" };
    case "shopping_item":
      return { icon: <ShoppingCart size={14} />, label: "LISTA LOCAL", color: "text-green-500" };
    case "promotion":
      return { icon: <Percent size={14} />, label: "PROMOÇÃO", color: "text-amber-500" };
    default:
      return { icon: <Bell size={14} />, label: entityType.toUpperCase(), color: "text-crimson" };
  }
};

export function NotificationsTab({ addToast, playSound }: NotificationsTabProps) {
  const [notifications, setNotifications] = useState<NotificationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiJson("/api/notifications?limit=50");
      setNotifications(data);
    } catch (err: any) {
      addToast("FALHA AO CARREGAR NOTIFICAÇÕES", "error", String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-mono font-bold glow-text flex items-center gap-3">
          <Bell size={24} />
          CENTRAL DE ALERTAS
        </h1>
        <span className="text-xs font-mono text-crimson/50 tracking-widest">
          {notifications.length} REGISTROS
        </span>
      </div>

      {loading ? (
        <div className="hud-border bg-black/40 p-10 flex flex-col items-center gap-4">
          <Loader2 size={24} className="animate-spin text-crimson" />
          <span className="text-xs font-mono text-crimson/50">CARREGANDO LOG DE ALERTAS...</span>
        </div>
      ) : notifications.length === 0 ? (
        <div className="hud-border bg-black/40 p-10 text-center">
          <ShieldAlert size={32} className="mx-auto mb-4 text-crimson/30" />
          <div className="text-crimson/40 font-mono italic">NENHUM ALERTA ENVIADO AINDA</div>
          <div className="text-[10px] font-mono text-crimson/30 mt-2">
            OS ALERTAS APARECEM AQUI QUANDO UM PRODUTO ATINGE O PREÇO-ALVO, UMA OBSERVAÇÃO LOCAL
            ENTRA NO ALVO OU UMA PROMOÇÃO ATIVA É CADASTRADA.
          </div>
        </div>
      ) : (
        <div className="hud-border bg-black/40 p-6 flex flex-col gap-3">
          {notifications.map((n, idx) => {
            const meta = entityMeta(n.entityType);
            return (
              <motion.div
                key={n.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="border-b border-crimson/10 pb-3 last:border-b-0"
              >
                <div className="flex items-center gap-3 mb-1">
                  <span className={`${meta.color} flex items-center gap-1.5 text-[10px] font-mono tracking-widest`}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <span className="text-[10px] font-mono text-crimson/30">
                    {new Date(n.sentAt.replace(" ", "T")).toLocaleString("pt-BR")}
                  </span>
                </div>
                <div className="text-xs font-mono font-bold text-crimson">{n.title}</div>
                <pre className="text-[11px] font-mono text-crimson/60 whitespace-pre-wrap mt-1 font-sans">
                  {n.message}
                </pre>
              </motion.div>
            );
          })}
        </div>
      )}

      <button
        className="hud-button text-xs py-2 px-4"
        onClick={() => {
          playSound("click");
          load();
        }}
      >
        ATUALIZAR LOG
      </button>
    </div>
  );
}
