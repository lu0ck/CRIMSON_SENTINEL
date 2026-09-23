import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/cn";
import {
  Store,
  ShoppingCart,
  Percent,
  MapPin,
  Plus,
  Trash2,
  Navigation,
  ChevronRight,
  ChevronDown,
  Loader2,
  CheckCircle2,
  Clock,
  Download,
  Upload,
  Merge,
} from "lucide-react";
import type {
  Establishment,
  ShoppingListItem,
  PriceObservation,
  Promotion,
} from "../types";
import { MapPicker } from "./MapPicker";
import { ITEM_UNITS, type ItemUnit } from "../lib/units";

interface MercadoTabProps {
  addToast: (message: string, type?: "success" | "error" | "info", details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
  profileId?: string;
  pollJob: (
    jobId: string,
    signal?: AbortSignal,
    intervalMs?: number,
    timeoutMs?: number,
    queue?: string
  ) => Promise<any>;
}

type ToastType = "success" | "error" | "info";

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function apiJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const inputCls =
  "hud-input text-xs py-1 px-2 w-full";
const labelCls = "text-[8px] font-mono text-crimson/70 tracking-widest uppercase";

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-mono text-crimson/50 tracking-[0.3em] flex items-center gap-2">
      {icon}
      {children}
    </h2>
  );
}

export function MercadoTab({ addToast, playSound, pollJob, profileId }: MercadoTabProps) {
  const [establishments, setEstablishments] = useState<Establishment[]>([]);
  const [items, setItems] = useState<ShoppingListItem[]>([]);
  const [observations, setObservations] = useState<PriceObservation[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);

  const [showEstForm, setShowEstForm] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [showPromoForm, setShowPromoForm] = useState(false);
  const [showObsForm, setShowObsForm] = useState(false);
  const [showEstMap, setShowEstMap] = useState(false);

  const [estName, setEstName] = useState("");
  const [estCep, setEstCep] = useState("");
  const [estLat, setEstLat] = useState("");
  const [estLng, setEstLng] = useState("");
  const [estAddress, setEstAddress] = useState("");
  const [estCity, setEstCity] = useState("");
  const [estCategory, setEstCategory] = useState("");
  const [estPriceUrl, setEstPriceUrl] = useState("");
  const [estInstagram, setEstInstagram] = useState("");
  const [estWhatsapp, setEstWhatsapp] = useState("");

  const [itemName, setItemName] = useState("");
  const [itemQty, setItemQty] = useState("1");
  const [itemUnit, setItemUnit] = useState<ItemUnit>("UN");
  const [itemCategory, setItemCategory] = useState("");
  const [itemTarget, setItemTarget] = useState("");

  const [promoEstId, setPromoEstId] = useState("");
  const [promoProduct, setPromoProduct] = useState("");
  const [promoRegular, setPromoRegular] = useState("");
  const [promoPrice, setPromoPrice] = useState("");
  const [promoEnd, setPromoEnd] = useState("");

  const [obsItemId, setObsItemId] = useState("");
  const [obsEstId, setObsEstId] = useState("");
  const [obsPrice, setObsPrice] = useState("");
  const [obsNotes, setObsNotes] = useState("");

  const [locCepLoading, setLocCepLoading] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const [expandedObs, setExpandedObs] = useState<string | null>(null);

  const toast = (message: string, type: ToastType, details?: string) =>
    addToast(message, type, details);

  const lookupLocationByCep = async (
    cep: string,
    setLat: (v: string) => void,
    setLng: (v: string) => void,
    setAddress: (v: string) => void,
    setCity?: (v: string) => void
  ) => {
    const cleaned = cep.replace(/\D/g, "");
    if (cleaned.length !== 8) return;
    setLocCepLoading(true);
    try {
      const data = await apiJson(`/api/cep/${cleaned}`);
      if (data) {
        const fullAddress = `${data.logradouro}, ${data.bairro}, ${data.localidade} - ${data.uf}`;
        setAddress(fullAddress);
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(fullAddress)}`,
          { headers: { "User-Agent": "CrimsonSentinel/1.0", "Accept-Language": "pt-BR" } }
        );
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData.length > 0) {
          setLat(geoData[0].lat);
          setLng(geoData[0].lon);
        }
        if (setCity) setCity(data.localidade);
        toast("CEP LOCALIZADO", "success", fullAddress);
      }
    } catch (err: any) {
      toast("FALHA AO BUSCAR CEP", "error", String(err?.message || err));
    } finally {
      setLocCepLoading(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [e, i, o, p] = await Promise.all([
        apiJson("/api/establishments"),
        apiJson("/api/shopping-list-items"),
        apiJson("/api/price-observations"),
        apiJson("/api/promotions"),
      ]);
      setEstablishments(e);
      setItems(i);
      setObservations(o);
      setPromotions(p);
    } catch (err: any) {
      toast("FALHA AO CARREGAR MÓDULO MERCADO", "error", String(err?.message || err));
    } finally {
      setLoading(false);
    }
    loadDupPairs();
  };

  useEffect(() => {
    loadAll();
    loadLocalScanSettings();
    loadLocalScanStatus();
    const t = setInterval(() => {
      loadLocalScanStatus();
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [scanningEstId, setScanningEstId] = useState<string | null>(null);
  const [localScanIntervalMs, setLocalScanIntervalMs] = useState<number>(6 * 60 * 60 * 1000);
  const [nextLocalPriceScanMinutes, setNextLocalPriceScanMinutes] = useState<number | null>(null);
  const [savingLocalInterval, setSavingLocalInterval] = useState(false);

  const loadLocalScanSettings = async () => {
    try {
      const data = await apiJson("/api/local-price-scan/settings");
      setLocalScanIntervalMs(data.intervalMs ?? 6 * 60 * 60 * 1000);
    } catch {
      // settings indisponíveis — mantém default
    }
  };

  const loadLocalScanStatus = async () => {
    try {
      const data = await apiJson("/api/status");
      setNextLocalPriceScanMinutes(data.nextLocalPriceScanMinutes ?? null);
    } catch {
      setNextLocalPriceScanMinutes(null);
    }
  };

  const fmtNextScan = (mins: number | null) => {
    if (mins === null) return "SEM AGENDAMENTO";
    if (mins <= 0) return "AGORA";
    if (mins >= 1440) return `EM ${Math.round(mins / 1440)} DIAS`;
    if (mins >= 60) return `EM ${Math.floor(mins / 60)}H ${mins % 60}MIN`;
    return `EM ${mins} MIN`;
  };

  const updateLocalInterval = async (ms: number) => {
    setSavingLocalInterval(true);
    try {
      await apiJson("/api/local-price-scan/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMs: ms }),
      });
      setLocalScanIntervalMs(ms);
      toast(`SCAN LOCAL A CADA ${Math.round(ms / 60000)} MIN`, "success");
    } catch (err: any) {
      toast("FALHA AO SALVAR AGENDAMENTO", "error", String(err?.message || err));
    } finally {
      setSavingLocalInterval(false);
    }
  };

  // ---- Shopping list export/import ------------------------------------------

  const exportShoppingList = async (format: "json" | "csv") => {
    try {
      const res = await fetch(`/api/shopping-list-items/export?format=${format}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lista-compras.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`LISTA EXPORTADA (${format.toUpperCase()})`, "success");
    } catch (err: any) {
      toast("FALHA AO EXPORTAR LISTA", "error", String(err?.message || err));
    }
  };

  const importShoppingList = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        toast("ARQUIVO INVÁLIDO", "error", "Esperado um array JSON de itens");
        return;
      }
      const res = await apiJson("/api/shopping-list-items/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      toast("LISTA IMPORTADA", "success", `${res.imported} itens importados`);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO IMPORTAR LISTA", "error", String(err?.message || err));
    }
  };

  const saveItem = async () => {
    if (!itemName.trim()) {
      toast("NOME DO ITEM É OBRIGATÓRIO", "error");
      return;
    }
    const qty = parseFloat(itemQty);
    if (isNaN(qty) || qty <= 0) {
      toast("QUANTIDADE DEVE SER MAIOR QUE ZERO", "error");
      return;
    }
    try {
      const item: ShoppingListItem = {
        id: newId("item"),
        name: itemName.trim(),
        quantity: qty,
        unit: itemUnit,
        category: itemCategory.trim() || undefined,
        targetPrice: itemTarget ? parseFloat(itemTarget) : undefined,
        checked: false,
      };
      await apiJson("/api/shopping-list-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      playSound("click");
      toast(`ITEM ADICIONADO: ${item.name.toUpperCase()}`, "success");
      setItemName(""); setItemQty("1"); setItemUnit("UN"); setItemCategory(""); setItemTarget("");
      setShowItemForm(false);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO SALVAR ITEM", "error", String(err?.message || err));
    }
  };

  const toggleItem = async (item: ShoppingListItem) => {
    try {
      await apiJson("/api/shopping-list-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...item, checked: !item.checked }),
      });
      playSound("click");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO ATUALIZAR ITEM", "error", String(err?.message || err));
    }
  };

  const deleteItem = async (id: string) => {
    try {
      await apiJson(`/api/shopping-list-items/${id}`, { method: "DELETE" });
      playSound("click");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR ITEM", "error", String(err?.message || err));
    }
  };

  // ---- Estabelecimentos ------------------------------------------------------

  const saveEstablishment = async () => {
    if (!estName.trim() || !estLat || !estLng) {
      toast("NOME, LAT E LNG SÃO OBRIGATÓRIOS", "error");
      return;
    }
    try {
      const est: Establishment = {
        id: newId("est"),
        name: estName.trim(),
        lat: parseFloat(estLat),
        lng: parseFloat(estLng),
        address: estAddress.trim() || undefined,
        city: estCity.trim() || undefined,
        category: estCategory.trim() || undefined,
        priceUrl: estPriceUrl.trim() || undefined,
        instagramHandle: estInstagram.trim() || undefined,
        whatsappNumber: estWhatsapp.trim() || undefined,
      };
      await apiJson("/api/establishments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(est),
      });
      playSound("click");
      toast(`ESTABELECIMENTO REGISTRADO: ${est.name.toUpperCase()}`, "success");
      setEstName(""); setEstLat(""); setEstLng(""); setEstAddress(""); setEstCity(""); setEstCategory(""); setEstPriceUrl(""); setEstCep(""); setEstInstagram(""); setEstWhatsapp("");
      setShowEstForm(false);
      setShowEstMap(false);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO SALVAR ESTABELECIMENTO", "error", String(err?.message || err));
    }
  };

  const deleteEstablishment = async (id: string) => {
    try {
      await apiJson(`/api/establishments/${id}`, { method: "DELETE" });
      playSound("click");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR ESTABELECIMENTO", "error", String(err?.message || err));
    }
  };

  // ---- Dedup (FASE 13) -------------------------------------------------------

  const [dupPairs, setDupPairs] = useState<{
    keepId: string; keepName: string; removeId: string; removeName: string;
    matchType: string; reason: string;
  }[]>([]);
  const [dupLoading, setDupLoading] = useState(false);
  const [mergingDupId, setMergingDupId] = useState<string | null>(null);

  const loadDupPairs = async () => {
    setDupLoading(true);
    try {
      const data = await apiJson("/api/establishments/duplicates");
      setDupPairs(data.pairs ?? []);
    } catch {
      // endpoint indisponível — mantém vazio
    } finally {
      setDupLoading(false);
    }
  };

  const mergePair = async (keepId: string, removeId: string, removeName: string) => {
    if (!window.confirm(`Mesclar "${removeName.toUpperCase()}" em "${keepId}"? Obs/promoções/paradas serão repontadas e o duplicado excluído.`)) return;
    setMergingDupId(removeId);
    try {
      const r = await apiJson("/api/establishments/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, removeId }),
      });
      playSound("success");
      toast(
        `MESCLADO: ${r.repointedObservations} obs, ${r.repointedPromotions} promo, ${r.repointedStops} paradas repontadas`,
        "success",
        r.dedupedPromotions + r.dedupedObservations > 0
          ? `${r.dedupedPromotions} promoções e ${r.dedupedObservations} obs exatas deduplicadas`
          : undefined
      );
      loadAll();
      loadDupPairs();
    } catch (err: any) {
      toast("FALHA AO MESCLAR", "error", String(err?.message || err));
    } finally {
      setMergingDupId(null);
    }
  };

  // ---- Scan de preços locais -------------------------------------------------

  const scanEstablishmentPrices = async (id: string) => {
    try {
      setScanningEstId(id);
      const data = await apiJson("/api/local-price-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ establishmentId: id, profileId }),
      });
      const result = await pollJob(data.jobId, undefined, 3000, 600_000, "scan");
      const rv = result || {};
      const summary = `REGISTRADAS ${rv.recorded ?? 0} • DUP ${rv.duplicates ?? 0} • ERROS ${rv.errors ?? 0}`;
      playSound("scan");
      toast(`SCAN DE PREÇOS CONCLUÍDO (${rv.establishments ?? 0} EST.)`, "success", summary);
      loadAll();
    } catch (err: any) {
      toast("FALHA NO SCAN DE PREÇOS", "error", String(err?.message || err));
    } finally {
      setScanningEstId(null);
    }
  };

  // ---- Observações de preço --------------------------------------------------

  const saveObservation = async () => {
    if (!obsItemId || !obsEstId || !obsPrice) {
      toast("ITEM, ESTABELECIMENTO E PREÇO SÃO OBRIGATÓRIOS", "error");
      return;
    }
    try {
      const obs: PriceObservation = {
        shoppingListItemId: obsItemId,
        establishmentId: obsEstId,
        price: parseFloat(obsPrice),
        currency: "BRL",
        observedAt: new Date().toISOString(),
        source: "manual",
        notes: obsNotes.trim() || undefined,
      };
      await apiJson("/api/price-observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obs),
      });
      playSound("click");
      toast("OBSERVAÇÃO DE PREÇO REGISTRADA", "success");
      setObsItemId(""); setObsEstId(""); setObsPrice(""); setObsNotes("");
      setShowObsForm(false);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO REGISTRAR OBSERVAÇÃO", "error", String(err?.message || err));
    }
  };

  // ---- Promoções -------------------------------------------------------------

  const savePromotion = async () => {
    if (!promoEstId || !promoProduct.trim() || !promoPrice) {
      toast("ESTABELECIMENTO, PRODUTO E PREÇO PROMOCIONAL SÃO OBRIGATÓRIOS", "error");
      return;
    }
    try {
      const promo: Promotion = {
        id: newId("promo"),
        establishmentId: promoEstId,
        productName: promoProduct.trim(),
        regularPrice: promoRegular ? parseFloat(promoRegular) : undefined,
        promoPrice: parseFloat(promoPrice),
        currency: "BRL",
        startDate: new Date().toISOString(),
        endDate: promoEnd || undefined,
        source: "manual",
        detectedAt: new Date().toISOString(),
        isActive: true,
      };
      await apiJson("/api/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promo),
      });
      playSound("click");
      toast(`PROMOÇÃO REGISTRADA: ${promo.productName.toUpperCase()}`, "success");
      setPromoEstId(""); setPromoProduct(""); setPromoRegular(""); setPromoPrice(""); setPromoEnd("");
      setShowPromoForm(false);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO SALVAR PROMOÇÃO", "error", String(err?.message || err));
    }
  };

  const deletePromotion = async (id: string) => {
    try {
      await apiJson(`/api/promotions/${id}`, { method: "DELETE" });
      playSound("click");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR PROMOÇÃO", "error", String(err?.message || err));
    }
  };

  // ---- Render -------------------------------------------------------------

  const estNameById = (id: string) =>
    establishments.find((e) => e.id === id)?.name || id;

  const itemNameById = (id: string) => items.find((i) => i.id === id)?.name || id;

  const obsByItem = (itemId: string) =>
    observations.filter((o) => o.shoppingListItemId === itemId);

  return (
    <div className="flex flex-col gap-10">
      {loading && (
        <div className="hud-border p-6 flex items-center gap-3 text-crimson/60 font-mono text-xs">
          <Loader2 size={16} className="animate-spin" /> CARREGANDO MÓDULO MERCADO...
        </div>
      )}

      {/* ===== LISTA DE COMPRAS ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<ShoppingCart size={16} />}>LISTA DE COMPRAS ({items.length})</SectionTitle>
          <div className="flex gap-2">
            <button
              onClick={() => exportShoppingList("json")}
              className="hud-button flex items-center gap-1.5 text-[10px] px-2 py-1"
              title="Exportar como JSON"
            >
              <Download size={12} /> JSON
            </button>
            <button
              onClick={() => exportShoppingList("csv")}
              className="hud-button flex items-center gap-1.5 text-[10px] px-2 py-1"
              title="Exportar como CSV"
            >
              <Download size={12} /> CSV
            </button>
            <button
              onClick={() => importFileRef.current?.click()}
              className="hud-button flex items-center gap-1.5 text-[10px] px-2 py-1"
              title="Importar lista de JSON"
            >
              <Upload size={12} /> IMPORTAR
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importShoppingList(f); e.target.value = ""; }}
            />
            <button
              onClick={() => { playSound("click"); setShowItemForm(!showItemForm); }}
              className="hud-button flex items-center gap-2"
            >
              <Plus size={16} /> ADICIONAR ITEM
            </button>
          </div>
        </div>

        <AnimatePresence>
          {showItemForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="hud-border bg-black/40 p-5 mt-4 overflow-hidden"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1 md:col-span-3">
                  <label className={labelCls}>NOME DO ITEM *</label>
                  <input className={inputCls} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="ARROZ 5KG" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>QUANTIDADE</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className={inputCls}
                    value={itemQty}
                    onChange={(e) => setItemQty(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>UNIDADE</label>
                  <select
                    className={inputCls}
                    value={itemUnit}
                    onChange={(e) => setItemUnit(e.target.value as ItemUnit)}
                  >
                    {ITEM_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>PREÇO ALVO (OPCIONAL)</label>
                  <input type="number" step="0.01" className={inputCls} value={itemTarget} onChange={(e) => setItemTarget(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1 md:col-span-3">
                  <label className={labelCls}>CATEGORIA</label>
                  <input className={inputCls} value={itemCategory} onChange={(e) => setItemCategory(e.target.value)} placeholder="MERCADO / HORTIFRUTI / FARMÁCIA..." />
                </div>
              </div>
              <button onClick={saveItem} className="hud-button flex items-center gap-2 mt-4">
                <CheckCircle2 size={14} /> SALVAR ITEM
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className="hud-border bg-black/40 p-4 flex flex-col gap-3">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => toggleItem(item)}
                  className={cn(
                    "w-5 h-5 border flex items-center justify-center shrink-0 transition-all",
                    item.checked
                      ? "bg-green-500 border-green-500 text-black"
                      : "border-crimson/40 hover:border-crimson"
                  )}
                >
                  {item.checked && <CheckCircle2 size={12} />}
                </button>
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className={cn(
                    "font-mono text-sm font-bold",
                    item.checked && "text-crimson/40 line-through"
                  )}>
                    {item.name.toUpperCase()}
                  </span>
                  <span className="text-[10px] font-mono text-crimson/50">
                    QTD {item.quantity ?? 1}
                    {item.unit ? ` ${item.unit.toUpperCase()}` : ""}
                    {item.category ? ` • ${item.category.toUpperCase()}` : ""}
                    {item.targetPrice !== undefined ? ` • ALVO ${fmtBRL(item.targetPrice)}` : ""}
                  </span>
                </div>
                <button
                  onClick={() => { playSound("click"); setExpandedObs(expandedObs === item.id ? null : item.id); }}
                  className="text-[10px] font-mono text-crimson/50 hover:text-crimson flex items-center gap-1"
                >
                  {expandedObs === item.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  PREÇOS ({obsByItem(item.id).length})
                </button>
                <button onClick={() => deleteItem(item.id)} className="text-crimson/30 hover:text-crimson">
                  <Trash2 size={14} />
                </button>
              </div>

              <AnimatePresence>
                {expandedObs === item.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden flex flex-col gap-3"
                  >
                    {obsByItem(item.id).map((obs) => (
                      <div key={obs.id} className="flex items-center justify-between text-[10px] font-mono text-crimson/60 border-b border-crimson/10 pb-2">
                        <div className="flex flex-col gap-0.5">
                          <span>{estNameById(obs.establishmentId).toUpperCase()}</span>
                          <span className="text-crimson/30">
                            {new Date(obs.observedAt).toLocaleString("pt-BR")}
                            {obs.notes ? ` • ${obs.notes}` : ""}
                          </span>
                        </div>
                        <span className="font-bold text-white">{fmtBRL(obs.price)}</span>
                      </div>
                    ))}
                    {obsByItem(item.id).length === 0 && (
                      <span className="text-[10px] font-mono text-crimson/30">
                        SEM OBSERVAÇÕES REGISTRADAS
                      </span>
                    )}
                    {!showObsForm && (
                      <button
                        onClick={() => { playSound("click"); setObsItemId(item.id); setObsEstId(establishments[0]?.id || ""); setShowObsForm(true); }}
                        className="text-[10px] font-mono text-crimson border border-crimson/30 px-2 py-1 hover:bg-crimson hover:text-black transition-all self-start"
                      >
                        + REGISTRAR PREÇO
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
          {items.length === 0 && (
            <div className="hud-border p-10 text-center text-crimson/30 font-mono">
              LISTA DE COMPRAS VAZIA
            </div>
          )}
        </div>
      </section>

      {/* ===== ESTABELECIMENTOS ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<Store size={16} />}>ESTABELECIMENTOS ({establishments.length})</SectionTitle>
          <div className="flex items-center gap-3">
            {nextLocalPriceScanMinutes !== null && (
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-crimson/50">
                <Clock size={12} />
                <span>PRÓXIMO SCAN {fmtNextScan(nextLocalPriceScanMinutes)}</span>
              </div>
            )}
            <select
              className="hud-input w-auto! text-[10px] py-1 px-2"
              value={localScanIntervalMs}
              disabled={savingLocalInterval}
              onChange={(e) => updateLocalInterval(Number(e.target.value))}
              title="Frequência do scan automático de preços locais"
            >
              <option value={60 * 60 * 1000}>SCAN A CADA 1H</option>
              <option value={6 * 60 * 60 * 1000}>SCAN A CADA 6H</option>
              <option value={12 * 60 * 60 * 1000}>SCAN A CADA 12H</option>
              <option value={24 * 60 * 60 * 1000}>SCAN A CADA 24H</option>
            </select>
            <button
              onClick={() => { playSound("click"); setShowEstForm(!showEstForm); }}
              className="hud-button flex items-center gap-2"
            >
              <Plus size={16} /> ADICIONAR
            </button>
          </div>
        </div>

        <AnimatePresence>
          {showEstForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="hud-border-map bg-black/40 p-5 mt-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1 md:col-span-3">
                  <label className={labelCls}>NOME *</label>
                  <input className={inputCls} value={estName} onChange={(e) => setEstName(e.target.value)} placeholder="MERCADO CENTRAL" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>CEP</label>
                  <div className="flex gap-2">
                    <input className={inputCls} value={estCep} onChange={(e) => setEstCep(e.target.value)} placeholder="00000-000" maxLength={9} />
                    <button
                      onClick={() => lookupLocationByCep(estCep, setEstLat, setEstLng, setEstAddress, setEstCity)}
                      disabled={locCepLoading || estCep.replace(/\D/g, "").length !== 8}
                      className="hud-button text-[10px] px-2 py-1 shrink-0 disabled:opacity-50"
                    >
                      <MapPin size={12} />
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>LATITUDE *</label>
                  <input className={inputCls} value={estLat} onChange={(e) => setEstLat(e.target.value)} placeholder="-23.5505" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>LONGITUDE *</label>
                  <input className={inputCls} value={estLng} onChange={(e) => setEstLng(e.target.value)} placeholder="-46.6333" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>CATEGORIA</label>
                  <input className={inputCls} value={estCategory} onChange={(e) => setEstCategory(e.target.value)} placeholder="SUPERMERCADO" />
                </div>
                <div className="flex flex-col gap-1 md:col-span-2">
                  <label className={labelCls}>ENDEREÇO</label>
                  <input className={inputCls} value={estAddress} onChange={(e) => setEstAddress(e.target.value)} placeholder="RUA, Nº" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>CIDADE</label>
                  <input className={inputCls} value={estCity} onChange={(e) => setEstCity(e.target.value)} placeholder="SÃO PAULO" />
                </div>
                <div className="flex flex-col gap-1 md:col-span-3">
                  <label className={labelCls}>URL DE PREÇO LOCAL</label>
                  <input className={inputCls} value={estPriceUrl} onChange={(e) => setEstPriceUrl(e.target.value)} placeholder="https://site.com/busca?q={term}" />
                  <span className="text-[9px] font-mono text-crimson/40">
                    USE {"{term}"} NO LUGAR DO NOME DO ITEM — EX: https://mercado.com.br/busca?q={"{"}term{"}"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>INSTAGRAM</label>
                  <input className={inputCls} value={estInstagram} onChange={(e) => setEstInstagram(e.target.value)} placeholder="@supermercado ou URL" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>WHATSAPP</label>
                  <input className={inputCls} value={estWhatsapp} onChange={(e) => setEstWhatsapp(e.target.value)} placeholder="+55 11 99999-9999" />
                </div>
              </div>

              <button
                onClick={() => setShowEstMap(!showEstMap)}
                className="hud-button flex items-center gap-2 text-xs mt-2"
              >
                <MapPin size={14} /> {showEstMap ? "FECHAR MAPA" : "MARCAR LOCAL NO MAPA"}
              </button>

              {showEstMap && (
                <MapPicker
                  lat={parseFloat(estLat) || -23.5505}
                  lng={parseFloat(estLng) || -46.6333}
                  onChange={(lat, lng) => { setEstLat(String(lat)); setEstLng(String(lng)); }}
                  onAddressFound={(addr) => setEstAddress(addr)}
                  height="280px"
                />
              )}
              <button onClick={saveEstablishment} className="hud-button flex items-center gap-2 mt-4">
                <CheckCircle2 size={14} /> SALVAR ESTABELECIMENTO
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {establishments.map((est) => (
            <div
              key={est.id}
              className={`hud-border bg-black/40 p-4 flex items-center gap-4 ${est.priceUrl ? "cursor-pointer hover:border-crimson/40" : ""}`}
              onClick={() => est.priceUrl && window.open(est.priceUrl, "_blank")}
            >
              <div className="w-10 h-10 bg-crimson/5 border border-crimson/20 flex items-center justify-center shrink-0">
                <Store size={16} className="text-crimson/70" />
              </div>
              <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                <span className="font-mono text-sm font-bold truncate">{est.name.toUpperCase()}</span>
                <span className="text-[10px] font-mono text-crimson/50">
                  ({est.lat.toFixed(5)}, {est.lng.toFixed(5)})
                  {est.city ? ` • ${est.city.toUpperCase()}` : ""}
                  {est.category ? ` • ${est.category.toUpperCase()}` : ""}
                </span>
                {est.address && (
                  <span className="text-[10px] font-mono text-crimson/30 truncate">{est.address}</span>
                )}
                {est.priceUrl && (
                  <span className="text-[9px] font-mono text-crimson/40 truncate">{est.priceUrl}</span>
                )}
              </div>
              {est.priceUrl && (
                <button
                  onClick={(e) => { e.stopPropagation(); scanEstablishmentPrices(est.id); }}
                  disabled={scanningEstId === est.id}
                  className="hud-button flex items-center gap-1.5 text-[10px] px-2 py-1.5 shrink-0"
                >
                  {scanningEstId === est.id ? <Loader2 size={12} className="animate-spin" /> : <Navigation size={12} />}
                  SCAN PREÇOS
                </button>
              )}
              <button onClick={(e) => { e.stopPropagation(); deleteEstablishment(est.id); }} className="text-crimson/30 hover:text-crimson shrink-0">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {establishments.length === 0 && (
            <div className="hud-border p-10 text-center text-crimson/30 font-mono md:col-span-2">
              NENHUM ESTABELECIMENTO CADASTRADO
            </div>
          )}
        </div>

        <AnimatePresence>
          {dupPairs.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 hud-border border-amber-500/20 bg-amber-500/5 p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[10px] text-amber-500/80 tracking-widest">
                  <Merge size={12} className="inline mr-1" />
                  DUPLICADOS SUSPEITOS ({dupPairs.length}) — MESCLAR TRANSFERE DADOS PARA O SOBREVIVENTE
                </span>
                {dupLoading && <Loader2 size={12} className="animate-spin text-amber-500/60" />}
              </div>
              <div className="flex flex-col gap-2">
                {dupPairs.map((p) => (
                  <div key={p.keepId + p.removeId} className="flex items-center gap-3 bg-black/30 border border-crimson/10 px-3 py-2">
                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono truncate">
                        <span className="text-amber-400">{p.removeName.toUpperCase()}</span>
                        <span className="text-crimson/40"> → </span>
                        <span className="text-green-500">{p.keepName.toUpperCase()}</span>
                      </span>
                      <span className="text-[9px] font-mono text-crimson/40">
                        {p.reason.toUpperCase()} • MATCH: {p.matchType.toUpperCase()} • REMOVE: #{p.removeId.slice(0, 8)}
                      </span>
                    </div>
                    <button
                      onClick={() => mergePair(p.keepId, p.removeId, p.removeName)}
                      disabled={mergingDupId === p.removeId}
                      className="hud-button flex items-center gap-1.5 text-[10px] px-2 py-1.5 shrink-0 disabled:opacity-50"
                    >
                      {mergingDupId === p.removeId ? <Loader2 size={12} className="animate-spin" /> : <Merge size={12} />}
                      {mergingDupId === p.removeId ? "MESCLANDO..." : "MESCLAR"}
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* ===== PROMOÇÕES ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<Percent size={16} />}>PROMOÇÕES ({promotions.filter((p) => p.isActive !== false).length})</SectionTitle>
          <button
            onClick={() => { playSound("click"); setShowPromoForm(!showPromoForm); }}
            className="hud-button flex items-center gap-2"
          >
            <Plus size={16} /> ADICIONAR
          </button>
        </div>

        <AnimatePresence>
          {showPromoForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="hud-border bg-black/40 p-5 mt-4 overflow-hidden"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>ESTABELECIMENTO *</label>
                  <select className={inputCls} value={promoEstId} onChange={(e) => setPromoEstId(e.target.value)}>
                    <option value="">SELECIONE...</option>
                    {establishments.map((est) => (
                      <option key={est.id} value={est.id}>{est.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 md:col-span-2">
                  <label className={labelCls}>PRODUTO *</label>
                  <input className={inputCls} value={promoProduct} onChange={(e) => setPromoProduct(e.target.value)} placeholder="CAFÉ 500G" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>PREÇO PROMOCIONAL *</label>
                  <input type="number" step="0.01" className={inputCls} value={promoPrice} onChange={(e) => setPromoPrice(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>PREÇO REGULAR</label>
                  <input type="number" step="0.01" className={inputCls} value={promoRegular} onChange={(e) => setPromoRegular(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>VÁLIDO ATÉ</label>
                  <input type="date" className={inputCls} value={promoEnd} onChange={(e) => setPromoEnd(e.target.value)} />
                </div>
              </div>
              <button onClick={savePromotion} className="hud-button flex items-center gap-2 mt-4">
                <CheckCircle2 size={14} /> SALVAR PROMOÇÃO
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 flex flex-col gap-2">
          {promotions.map((promo) => {
            const discount =
              promo.regularPrice && promo.regularPrice > promo.promoPrice
                ? Math.round((1 - promo.promoPrice / promo.regularPrice) * 100)
                : null;
            const validDate = promo.expiresAt ?? promo.endDate;
            const isEstimated = !validDate;
            return (
              <div key={promo.id} className="hud-border bg-black/40 p-4 flex items-center gap-4">
                <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold truncate">{promo.productName.toUpperCase()}</span>
                    {promo.isFlash && (
                      <span className="text-[8px] font-mono bg-red-500/30 text-red-400 px-1.5 py-0.5 animate-pulse">
                        RELÂMPAGO
                      </span>
                    )}
                    {promo.source && (
                      <span className="text-[8px] font-mono bg-blue-500/20 text-blue-400 px-1.5 py-0.5 uppercase">
                        {promo.source}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-crimson/50">
                    {estNameById(promo.establishmentId).toUpperCase()}
                    {validDate
                      ? ` • ATÉ ${new Date(validDate).toLocaleDateString("pt-BR")}`
                      : " • ESTIMADO"}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  {promo.regularPrice && (
                    <span className="text-[10px] font-mono text-crimson/40 line-through">{fmtBRL(promo.regularPrice)}</span>
                  )}
                  <span className="font-mono text-sm font-bold text-green-500">{fmtBRL(promo.promoPrice)}</span>
                  {discount !== null && (
                    <span className="text-[8px] font-mono bg-green-500/20 text-green-400 px-1.5 py-0.5">
                      -{discount}%
                    </span>
                  )}
                </div>
                <button onClick={() => deletePromotion(promo.id)} className="text-crimson/30 hover:text-crimson shrink-0">
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          {promotions.length === 0 && (
            <div className="hud-border p-10 text-center text-crimson/30 font-mono">
              NENHUMA PROMOÇÃO REGISTRADA
            </div>
          )}
        </div>
      </section>

      {/* ===== OBSERVAÇÃO DE PREÇO (modal simples) ===== */}
      <AnimatePresence>
        {showObsForm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="hud-border bg-[#0a0a0a] w-full max-w-md p-8 relative"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-mono text-crimson tracking-[0.3em] glow-text">REGISTRAR PREÇO</h2>
                <button onClick={() => setShowObsForm(false)} className="text-crimson/50 hover:text-crimson">
                  <ChevronRight className="rotate-90" />
                </button>
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>ITEM</label>
                  <span className="font-mono text-xs font-bold">{itemNameById(obsItemId).toUpperCase()}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>ESTABELECIMENTO *</label>
                  <select className={inputCls} value={obsEstId} onChange={(e) => setObsEstId(e.target.value)}>
                    <option value="">SELECIONE...</option>
                    {establishments.map((est) => (
                      <option key={est.id} value={est.id}>{est.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>PREÇO *</label>
                  <input type="number" step="0.01" className={inputCls} value={obsPrice} onChange={(e) => setObsPrice(e.target.value)} placeholder="12.90" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className={labelCls}>NOTAS</label>
                  <input className={inputCls} value={obsNotes} onChange={(e) => setObsNotes(e.target.value)} placeholder="EMBALAGEM 2KG" />
                </div>
                <button onClick={saveObservation} className="hud-button flex items-center justify-center gap-2 py-3">
                  <CheckCircle2 size={14} /> REGISTRAR
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
