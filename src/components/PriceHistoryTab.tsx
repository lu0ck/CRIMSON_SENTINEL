import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  Database,
  MapPin,
  TrendingDown,
  TrendingUp,
  Minus,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface PricePoint {
  date: string;
  price: number;
  source?: string;
}

interface SeriesStats {
  current: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  changePct: number | null;
  count: number;
}

interface PriceSeries {
  id: string;
  label: string;
  points: PricePoint[];
  stats: SeriesStats;
}

interface PriceHistoryEntity {
  id: string;
  label: string;
  kind: "product" | "item";
  series: PriceSeries[];
}

interface PriceHistoryPayload {
  rangeDays: number;
  ecommerce: PriceHistoryEntity[];
  local: PriceHistoryEntity[];
}

interface PriceHistoryTabProps {
  addToast: (message: string, type?: "success" | "error" | "info", details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
}

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

const RANGES = [
  { label: "TUDO", days: 0 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
];

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "up" | "down";
}) {
  const color =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-crimson";
  return (
    <div className="hud-border bg-black/40 p-3">
      <div className="text-[8px] font-mono text-crimson/60 tracking-widest uppercase">{label}</div>
      <div className={`font-mono text-lg font-bold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

export function PriceHistoryTab({ addToast, playSound }: PriceHistoryTabProps) {
  const [data, setData] = useState<PriceHistoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"ecommerce" | "local">("ecommerce");
  const [entityId, setEntityId] = useState<string>("");
  const [rangeDays, setRangeDays] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/price-history?rangeDays=${rangeDays}`)
      .then((r) => r.json())
      .then((payload: PriceHistoryPayload) => {
        if (cancelled) return;
        setData(payload);
        setLoading(false);
        const entities = scope === "ecommerce" ? payload.ecommerce : payload.local;
        setEntityId((prev) => {
          if (entities.some((e) => e.id === prev)) return prev;
          return entities[0]?.id ?? "";
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setLoading(false);
        addToast("Falha ao carregar histórico", "error", e.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, rangeDays]);

  const entities = data ? (scope === "ecommerce" ? data.ecommerce : data.local) : [];
  const entity = entities.find((e) => e.id === entityId) ?? entities[0];

  const chartData = useMemo(() => {
    if (!entity || entity.series.length === 0) return [];
    const keys = entity.series.map((s) => s.label);
    const merged = new Map<string, Record<string, unknown>>();
    for (const series of entity.series) {
      for (const p of series.points) {
        const bucket = merged.get(p.date) ?? { date: p.date };
        bucket[series.label] = p.price;
        merged.set(p.date, bucket);
      }
    }
    const rows = [...merged.values()].sort(
      (a, b) => new Date(a.date as string).getTime() - new Date(b.date as string).getTime()
    );
    return rows.map((r) => ({ ...r, keys }));
  }, [entity]);

  const activeSeries = entity?.series ?? [];
  const stats = activeSeries[0]?.stats ?? null;

  const toneFor = (pct: number | null): "neutral" | "up" | "down" => {
    if (pct === null) return "neutral";
    return pct < 0 ? "down" : pct > 0 ? "up" : "neutral";
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="hud-border bg-black/40 p-5"
      >
        <div className="flex items-center gap-3 mb-4">
          <Activity size={20} className="text-crimson" />
          <h1 className="font-mono text-sm font-bold tracking-[0.3em] text-crimson">
            HISTÓRICO DE PREÇOS
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Scope switch */}
          <div className="flex gap-2">
            <button
              onClick={() => {
                playSound("click");
                setScope("ecommerce");
              }}
              className={`hud-btn px-4 py-2 text-xs font-mono flex items-center gap-2 ${
                scope === "ecommerce" ? "bg-crimson text-white" : ""
              }`}
            >
              <Database size={14} /> E-COMMERCE
            </button>
            <button
              onClick={() => {
                playSound("click");
                setScope("local");
              }}
              className={`hud-btn px-4 py-2 text-xs font-mono flex items-center gap-2 ${
                scope === "local" ? "bg-crimson text-white" : ""
              }`}
            >
              <MapPin size={14} /> LOCAL
            </button>
          </div>

          {/* Entity selector */}
          <select
            value={entity?.id ?? ""}
            onChange={(e) => {
              playSound("click");
              setEntityId(e.target.value);
            }}
            className="hud-input text-xs py-2 px-3 w-auto!"
          >
            {entities.length === 0 && <option value="">SÉRIE VAZIA</option>}
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>

          {/* Range */}
          <div className="flex gap-2 ml-auto">
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => {
                  playSound("click");
                  setRangeDays(r.days);
                }}
                className={`hud-btn px-3 py-2 text-xs font-mono ${
                  rangeDays === r.days ? "bg-crimson text-white" : ""
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="mt-6 py-16 text-center font-mono text-crimson/50 animate-pulse">
            LENDO SÉRIES TEMPORAIS...
          </div>
        )}
      </motion.div>

      {/* Stats */}
      {!loading && stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="ATUAL" value={stats.current !== null ? fmtBRL(stats.current) : "--"} tone="neutral" />
          <StatCard label="MÍN" value={stats.min !== null ? fmtBRL(stats.min) : "--"} tone="down" />
          <StatCard label="MÁX" value={stats.max !== null ? fmtBRL(stats.max) : "--"} tone="up" />
          <StatCard label="MÉDIA" value={stats.avg !== null ? fmtBRL(stats.avg) : "--"} tone="neutral" />
          <StatCard
            label={`VARIAÇÃO (${stats.count} pts)`}
            value={stats.changePct !== null ? `${stats.changePct.toFixed(1)}%` : "--"}
            tone={toneFor(stats.changePct)}
          />
        </div>
      )}

      {/* Chart */}
      {!loading && entity && entity.series.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="hud-border bg-black/40 p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-mono text-crimson/70 tracking-[0.3em]">
              {scope === "ecommerce" ? "PRODUTO" : "ITEM"}: {entity.label.toUpperCase()}
            </h2>
            <div className="flex items-center gap-2 text-[10px] font-mono text-crimson/50">
              {entity.series.map((s) => (
                <span key={s.id} className="flex items-center gap-1">
                  {s.points.length > 1 &&
                    (s.stats.changePct !== null && s.stats.changePct < 0 ? (
                      <TrendingDown size={12} className="text-emerald-400" />
                    ) : s.stats.changePct !== null && s.stats.changePct > 0 ? (
                      <TrendingUp size={12} className="text-red-400" />
                    ) : (
                      <Minus size={12} className="text-crimson/50" />
                    ))}
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <div className="h-80">
            {chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center font-mono text-crimson/30">
                SEM PONTOS NO PERÍODO
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="#444"
                    fontSize={10}
                    fontFamily="monospace"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(iso) => fmtDate(iso as string)}
                  />
                  <YAxis
                    stroke="#444"
                    fontSize={10}
                    fontFamily="monospace"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => fmtBRL(Number(val))}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#000", border: "1px solid #900", borderRadius: "0px", fontFamily: "monospace" }}
                    itemStyle={{ color: "#f00" }}
                    labelFormatter={(label) => fmtDate(label as string)}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, fontFamily: "monospace" }} />
                  {entity.series.map((s, idx) => (
                    <Line
                      key={s.id}
                      type="monotone"
                      dataKey={s.label}
                      stroke={idx % 2 === 0 ? "#f00" : "#f97316"}
                      strokeWidth={2}
                      dot={{ r: 3, fill: idx % 2 === 0 ? "#f00" : "#f97316", strokeWidth: 0 }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && entities.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="hud-border bg-black/40 p-10 text-center font-mono text-crimson/40"
        >
          NENHUMA SÉRIE NO ESCOPO {scope.toUpperCase()}.<br />
          <span className="text-[10px]">
            {scope === "ecommerce"
              ? "Adicione produtos às listas e realize scans para acumular price_history."
              : "Registre observações de preço local para acumular price_observations."}
          </span>
        </motion.div>
      )}
    </div>
  );
}
