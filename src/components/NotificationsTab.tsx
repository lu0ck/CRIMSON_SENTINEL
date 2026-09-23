import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bell, ShieldAlert, Store, ShoppingCart, Percent, Loader2, XCircle, ChevronDown, ExternalLink } from "lucide-react";
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
    case "scrape":
      return { icon: <XCircle size={14} />, label: "SCRAPE", color: "text-red-500" };
    case "compare":
      return { icon: <Bell size={14} />, label: "COMPARAR", color: "text-crimson" };
    case "trigger":
      return { icon: <ShieldAlert size={14} />, label: "TRIGGER", color: "text-amber-500" };
    default:
      return { icon: <Bell size={14} />, label: entityType.toUpperCase(), color: "text-crimson" };
  }
};

interface DetailsPayload {
  searchItems?: { url: string; snippet: string }[];
  scrapedUrls?: string[];
  rejectedSameProduct?: number;
  rejectedNoData?: number;
  rejectedLowPrice?: number;
}

export function NotificationsTab({ addToast, playSound }: NotificationsTabProps) {
  const [notifications, setNotifications] = useState<NotificationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

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

  const parseDetails = (details?: string | null): DetailsPayload | null => {
    if (!details) return null;
    try {
      return JSON.parse(details);
    } catch {
      return null;
    }
  };

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
            ENTRA NO ALVO, UMA PROMOÇÃO ATIVA É CADASTRADA OU UM RASTREIO DE LINK FALHA.
          </div>
        </div>
      ) : (
        <div className="hud-border bg-black/40 p-6 flex flex-col gap-3">
          {notifications.map((n, idx) => {
            const meta = entityMeta(n.entityType);
            const isExpanded = expandedId === n.id;
            const details = parseDetails(n.details);
            const hasExpandableContent = details && (details.searchItems?.length || details.scrapedUrls?.length);

            return (
              <motion.div
                key={n.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                className={`border-b border-crimson/10 pb-3 last:border-b-0 ${hasExpandableContent ? "cursor-pointer hover:bg-crimson/5 rounded px-2 -mx-2 transition-colors" : ""}`}
                onClick={() => {
                  if (hasExpandableContent) {
                    playSound("click");
                    setExpandedId(isExpanded ? null : n.id);
                  }
                }}
              >
                <div className="flex items-center gap-3 mb-1">
                  <span className={`${meta.color} flex items-center gap-1.5 text-[10px] font-mono tracking-widest`}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <span className="text-[10px] font-mono text-crimson/30">
                    {new Date(n.sentAt.replace(" ", "T") + "Z").toLocaleString("pt-BR")}
                  </span>
                  {hasExpandableContent && (
                    <motion.span
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="text-crimson/30"
                    >
                      <ChevronDown size={12} />
                    </motion.span>
                  )}
                </div>
                <div className="text-xs font-mono font-bold text-crimson">{n.title}</div>
                <pre className="text-[11px] font-mono text-crimson/60 whitespace-pre-wrap mt-1 font-sans">
                  {n.message}
                </pre>

                <AnimatePresence>
                  {isExpanded && details && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 pt-3 border-t border-crimson/10 space-y-2">
                        {details.searchItems && details.searchItems.length > 0 && (
                          <div>
                            <div className="text-[10px] font-mono text-crimson/40 tracking-widest mb-1">
                              LINKS ENCONTRADOS ({details.searchItems.length})
                            </div>
                            <div className="flex flex-col gap-1">
                              {details.searchItems.map((item, i) => {
                                let hostname = item.url;
                                try { hostname = new URL(item.url).hostname; } catch {}
                                return (
                                  <a
                                    key={i}
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-start gap-2 text-[11px] font-mono text-crimson/50 hover:text-crimson transition-colors group"
                                  >
                                    <ExternalLink size={10} className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <div className="min-w-0">
                                      <span className="text-crimson/70 font-bold">{hostname}</span>
                                      {item.snippet && (
                                        <span className="text-crimson/30 ml-1">— {item.snippet.slice(0, 120)}{item.snippet.length > 120 ? "..." : ""}</span>
                                      )}
                                    </div>
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {details.scrapedUrls && details.scrapedUrls.length > 0 && (
                          <div>
                            <div className="text-[10px] font-mono text-crimson/40 tracking-widest mb-1">
                              URLs ESCAVADAS ({details.scrapedUrls.length})
                            </div>
                            <div className="flex flex-col gap-1">
                              {details.scrapedUrls.map((url, i) => {
                                let hostname = url;
                                try { hostname = new URL(url).hostname; } catch {}
                                return (
                                  <a
                                    key={i}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center gap-2 text-[11px] font-mono text-crimson/50 hover:text-crimson transition-colors group"
                                  >
                                    <ExternalLink size={10} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    <span className="text-crimson/70 font-bold">{hostname}</span>
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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
