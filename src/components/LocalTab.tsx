import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/cn";
import {
  Store,
  ShoppingCart,
  Percent,
  Route as RouteIcon,
  MapPin,
  Plus,
  Trash2,
  Navigation,
  ChevronRight,
  ChevronDown,
  Loader2,
  CheckCircle2,
  BrainCircuit,
  Sparkles,
  LocateFixed,
  Radar,
  Clock,
  Download,
  Upload,
  Globe,
  ExternalLink,
  Merge,
} from "lucide-react";
import type {
  Establishment,
  ShoppingListItem,
  PriceObservation,
  Promotion,
  RoutePlan,
  PromotionSite,
} from "../types";
import { MapPicker } from "./MapPicker";

interface LocalTabProps {
  addToast: (message: string, type?: "success" | "error" | "info", details?: string) => void;
  playSound: (type: "click" | "success" | "error" | "scan" | "notify") => void;
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

export function LocalTab({ addToast, playSound, pollJob }: LocalTabProps) {
  const [establishments, setEstablishments] = useState<Establishment[]>([]);
  const [items, setItems] = useState<ShoppingListItem[]>([]);
  const [observations, setObservations] = useState<PriceObservation[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [routes, setRoutes] = useState<RoutePlan[]>([]);
  const [promoSites, setPromoSites] = useState<PromotionSite[]>([]);
  const [loading, setLoading] = useState(true);

  // Formulários
  const [showEstForm, setShowEstForm] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [showPromoForm, setShowPromoForm] = useState(false);
  const [showObsForm, setShowObsForm] = useState(false);
  const [showPsiteForm, setShowPsiteForm] = useState(false);

  // Novo site de promoção
  const [psiteName, setPsiteName] = useState("");
  const [psiteUrl, setPsiteUrl] = useState("");
  const [psiteCategory, setPsiteCategory] = useState("");

  // Novo estabelecimento
  const [estName, setEstName] = useState("");
  const [estLat, setEstLat] = useState("");
  const [estLng, setEstLng] = useState("");
  const [estAddress, setEstAddress] = useState("");
  const [estCity, setEstCity] = useState("");
  const [estCategory, setEstCategory] = useState("");
  const [estPriceUrl, setEstPriceUrl] = useState("");
  const [estCep, setEstCep] = useState("");
  const [showEstMap, setShowEstMap] = useState(false);
  const [showRouteMap, setShowRouteMap] = useState(false);

  // Novo item de compra
  const [itemName, setItemName] = useState("");
  const [itemQty, setItemQty] = useState("1");
  const [itemUnit, setItemUnit] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemTarget, setItemTarget] = useState("");

  // Nova promoção
  const [promoEstId, setPromoEstId] = useState("");
  const [promoProduct, setPromoProduct] = useState("");
  const [promoRegular, setPromoRegular] = useState("");
  const [promoPrice, setPromoPrice] = useState("");
  const [promoEnd, setPromoEnd] = useState("");

  // Nova observação de preço
  const [obsItemId, setObsItemId] = useState("");
  const [obsEstId, setObsEstId] = useState("");
  const [obsPrice, setObsPrice] = useState("");
  const [obsNotes, setObsNotes] = useState("");

  // Roteirização
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [startLat, setStartLat] = useState("-23.5505");
  const [startLng, setStartLng] = useState("-46.6333");
  const [routeName, setRouteName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [latestRouteId, setLatestRouteId] = useState<string | null>(null);

  // B4 — veículo e horário de saída
  const [vehType, setVehType] = useState<"car" | "motorcycle" | "public" | "bike" | "foot">("car");
  const [vehKmPerL, setVehKmPerL] = useState("10");
  const [vehFuelPrice, setVehFuelPrice] = useState("6.0");
  const [vehPublicFare, setVehPublicFare] = useState("4.4");
  const [startTimeMode, setStartTimeMode] = useState<"suggest" | "specific">("suggest");
  const [startTimeSpecific, setStartTimeSpecific] = useState("");

  // B1 — localização do usuário + descoberta de mercados
  const [currentLoc, setCurrentLoc] = useState<any>(null);
  const [locAddress, setLocAddress] = useState("");
  const [locLat, setLocLat] = useState("-23.5505");
  const [locLng, setLocLng] = useState("-46.6333");
  const [locRadiusKm, setLocRadiusKm] = useState("5");
  const [locSaving, setLocSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [locCep, setLocCep] = useState("");
  const [locCepLoading, setLocCepLoading] = useState(false);
  const [showMap, setShowMap] = useState(false);

  // Backup
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const backupFileRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Estado de seções expansíveis (observações por item)
  const [expandedObs, setExpandedObs] = useState<string | null>(null);

  // Insights locais (FASE 7)
  const [insights, setInsights] = useState<any>(null);
  const [insightSummary, setInsightSummary] = useState<string>("");
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [aiText, setAiText] = useState<string>("");
  const [aiMethod, setAiMethod] = useState<string>("");

  const toast = (message: string, type: ToastType, details?: string) =>
    addToast(message, type, details);

  // CEP lookup helper
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

  // Backup functions
  const exportBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await fetch("/api/backup/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sentinela-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("BACKUP EXPORTADO", "success");
    } catch (err: any) {
      toast("FALHA AO EXPORTAR BACKUP", "error", String(err?.message || err));
    } finally {
      setBackupLoading(false);
    }
  };

  const importBackup = async (file: File) => {
    setRestoreLoading(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm("ATENÇÃO: Isso SUBSTITUIRÁ todos os dados atuais. Continuar?")) {
        setRestoreLoading(false);
        return;
      }
      const res = await apiJson("/api/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      toast("BACKUP RESTAURADO", "success", JSON.stringify(res.imported));
      loadAll();
      loadLocation();
    } catch (err: any) {
      toast("FALHA AO IMPORTAR BACKUP", "error", String(err?.message || err));
    } finally {
      setRestoreLoading(false);
    }
  };

  // Shopping list export/import
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

  const loadInsights = async () => {
    setInsightsLoading(true);
    try {
      const data = await apiJson("/api/local-insights");
      setInsights(data.insights);
      setInsightSummary(data.summary);
    } catch (err: any) {
      toast("FALHA AO CALCULAR INSIGHTS", "error", String(err?.message || err));
    } finally {
      setInsightsLoading(false);
    }
  };

  const analyzeWithAI = async () => {
    if (aiAnalyzing) return;
    setAiAnalyzing(true);
    setAiText("");
    try {
      const { jobId } = await apiJson("/api/local-insights/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await pollJob(jobId, undefined, 2000, 600_000, "scan");
      setAiText(result?.text || "");
      setAiMethod(result?.method || "");
      toast("ANÁLISE SENTINELA CONCLUÍDA", "success");
    } catch (err: any) {
      toast("FALHA NA ANÁLISE COM IA", "error", String(err?.message || err));
    } finally {
      setAiAnalyzing(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [e, i, o, p, r, ps] = await Promise.all([
        apiJson("/api/establishments"),
        apiJson("/api/shopping-list-items"),
        apiJson("/api/price-observations"),
        apiJson("/api/promotions"),
        apiJson("/api/routes"),
        apiJson("/api/promotion-sites"),
      ]);
      setEstablishments(e);
      setItems(i);
      setObservations(o);
      setPromotions(p);
      setRoutes(r);
      setPromoSites(ps);
    } catch (err: any) {
      toast("FALHA AO CARREGAR MÓDULO LOCAL", "error", String(err?.message || err));
    } finally {
      setLoading(false);
    }
    loadInsights();
    loadDupPairs();
  };

  const loadLocation = async () => {
    try {
      const data = await apiJson("/api/location");
      setCurrentLoc(data);
      if (data.lat) { setLocLat(String(data.lat)); setLocLng(String(data.lng)); }
      if (data.address) setLocAddress(data.address);
      if (data.cep) setLocCep(data.cep);
      if (data.radiusMeters) setLocRadiusKm(String(Math.round(data.radiusMeters / 1000)));
    } catch {
      // sem localização salva — mantém defaults
    }
  };

  useEffect(() => {
    loadAll();
    loadLocation();
    loadLocalScanSettings();
    loadLocalScanStatus();
    const t = setInterval(() => {
      loadLocalScanStatus();
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLocation = async () => {
    if (locSaving) return;
    const lat = parseFloat(locLat);
    const lng = parseFloat(locLng);
    const validCoords = !isNaN(lat) && !isNaN(lng);
    if (!validCoords && !locAddress.trim()) {
      toast("INFORME ENDEREÇO OU COORDENADAS (LAT/LNG)", "error");
      return;
    }
    setLocSaving(true);
    try {
      const body: any = { radiusKm: parseFloat(locRadiusKm) || 5 };
      if (locCep.trim()) body.cep = locCep.trim();
      if (validCoords) {
        body.lat = lat;
        body.lng = lng;
        if (locAddress.trim()) body.address = locAddress.trim();
      } else {
        body.address = locAddress.trim();
      }
      const data = await apiJson("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setCurrentLoc(data.location);
      playSound("success");
      toast("LOCALIZAÇÃO DEFINIDA", "success", `${data.location.lat}, ${data.location.lng}`);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO DEFINIR LOCALIZAÇÃO", "error", String(err?.message || err));
    } finally {
      setLocSaving(false);
    }
  };

  const discoverNearby = async () => {
    if (discovering) return;
    setDiscovering(true);
    playSound("scan");
    try {
      const { jobId } = await apiJson("/api/establishments/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ radiusMeters: (parseFloat(locRadiusKm) || 5) * 1000 }),
      });
      toast(`DESCOBERTA ENFILEIRADA: JOB ${jobId}`, "info");
      const result = await pollJob(jobId, undefined, 2000, 600_000, "scan");
      const inserted = Number(result?.inserted ?? 0);
      toast(
        `DESCOBERTA CONCLUÍDA — ${inserted} NOVO(S)`,
        inserted > 0 ? "success" : "info",
        `${result?.discovered ?? 0} ENCONTRADOS • ${result?.updated ?? 0} ATUALIZADOS • ${result?.skipped ?? 0} PULADOS`
      );
      playSound("success");
      loadAll();
    } catch (err: any) {
      toast("FALHA NA DESCOBERTA DE MERCADOS", "error", String(err?.message || err));
    } finally {
      setDiscovering(false);
    }
  };

  // ---- Estabelecimentos ----------------------------------------------------

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
      };
      await apiJson("/api/establishments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(est),
      });
      playSound("click");
      toast(`ESTABELECIMENTO REGISTRADO: ${est.name.toUpperCase()}`, "success");
      setEstName(""); setEstLat(""); setEstLng(""); setEstAddress(""); setEstCity(""); setEstCategory(""); setEstPriceUrl("");
      setShowEstForm(false);
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

  // FASE 13 — dedup: sugere pares duplicados e mescla (reponta dados do removido)
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

  const scanEstablishmentPrices = async (id: string) => {
    try {
      setScanningEstId(id);
      const data = await apiJson("/api/local-price-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ establishmentId: id }),
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

  // ---- Itens da lista de compras ------------------------------------------

  const saveItem = async () => {
    if (!itemName.trim()) {
      toast("NOME DO ITEM É OBRIGATÓRIO", "error");
      return;
    }
    try {
      const item: ShoppingListItem = {
        id: newId("item"),
        name: itemName.trim(),
        quantity: parseFloat(itemQty) || 1,
        unit: itemUnit.trim() || undefined,
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
      setItemName(""); setItemQty("1"); setItemUnit(""); setItemCategory(""); setItemTarget("");
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
      setSelectedItemIds((prev) => prev.filter((x) => x !== id));
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR ITEM", "error", String(err?.message || err));
    }
  };

  // ---- Observações de preço -----------------------------------------------

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

  // ---- Promoções ----------------------------------------------------------

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

  // ---- Roteirização -------------------------------------------------------

  const toggleSelectedItem = (id: string) => {
    playSound("click");
    setSelectedItemIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const generateRoute = async () => {
    if (selectedItemIds.length === 0) {
      toast("SELECIONE PELO MENOS UM ITEM DA LISTA DE COMPRAS", "error");
      return;
    }
    const lat = parseFloat(startLat);
    const lng = parseFloat(startLng);
    if (isNaN(lat) || isNaN(lng)) {
      toast("COORDENADAS DE PARTIDA INVÁLIDAS", "error");
      return;
    }
    setGenerating(true);
    playSound("scan");
    try {
      // B4 — monta o payload de veículo de acordo com o tipo selecionado
      const vehicle =
        vehType === "public"
          ? { type: "public" as const, publicFare: parseFloat(vehPublicFare) || undefined }
          : vehType === "car" || vehType === "motorcycle"
          ? {
              type: vehType,
              fuelConsumptionKmPerL: parseFloat(vehKmPerL) || undefined,
              fuelPricePerL: parseFloat(vehFuelPrice) || undefined,
            }
          : { type: vehType };
      const startTime =
        startTimeMode === "specific" && startTimeSpecific
          ? new Date(startTimeSpecific).toISOString()
          : "suggest";
      const queued = await apiJson("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shoppingListItemIds: selectedItemIds,
          startLat: lat,
          startLng: lng,
          name: routeName.trim() || undefined,
          vehicle,
          startTime,
        }),
      });
      if (!queued.jobId) throw new Error(queued.error || "Falha ao enfileirar rota");
      toast(`ROTA ENFILEIRADA: JOB ${queued.jobId}`, "info");
      const result = await pollJob(queued.jobId, undefined, 2000, 600_000, "route");
      setLatestRouteId(result?.routeId || null);
      toast(
        `ROTA CALCULADA: ${result?.stopCount || 0} PARADAS, ${result?.totalDistanceKm || 0} KM, CUSTO ${fmtBRL(result?.totalEstimatedCost || 0)}`,
        "success"
      );
      playSound("success");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO CALCULAR ROTA", "error", String(err?.message || err));
    } finally {
      setGenerating(false);
    }
  };

  const deleteRoute = async (id: string) => {
    try {
      await apiJson(`/api/routes/${id}`, { method: "DELETE" });
      playSound("click");
      if (latestRouteId === id) setLatestRouteId(null);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR ROTA", "error", String(err?.message || err));
    }
  };

  // ---- Sites de promoções ---------------------------------------------------

  const savePsite = async () => {
    if (!psiteName.trim() || !psiteUrl.trim()) {
      toast("NOME E URL SÃO OBRIGATÓRIOS", "error");
      return;
    }
    try {
      const site: PromotionSite = {
        id: `psite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: psiteName.trim(),
        url: psiteUrl.trim(),
        category: psiteCategory.trim() || undefined,
        createdAt: new Date().toISOString(),
      };
      await apiJson("/api/promotion-sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(site),
      });
      playSound("click");
      toast(`SITE ADICIONADO: ${site.name.toUpperCase()}`, "success");
      setPsiteName(""); setPsiteUrl(""); setPsiteCategory("");
      setShowPsiteForm(false);
      loadAll();
    } catch (err: any) {
      toast("FALHA AO SALVAR SITE", "error", String(err?.message || err));
    }
  };

  const deletePsite = async (id: string) => {
    try {
      await apiJson(`/api/promotion-sites/${id}`, { method: "DELETE" });
      playSound("click");
      loadAll();
    } catch (err: any) {
      toast("FALHA AO EXCLUIR SITE", "error", String(err?.message || err));
    }
  };

  // ---- Render -------------------------------------------------------------

  const estNameById = (id: string) =>
    establishments.find((e) => e.id === id)?.name || id;

  const itemNameById = (id: string) => items.find((i) => i.id === id)?.name || id;

  const obsByItem = (itemId: string) =>
    observations.filter((o) => o.shoppingListItemId === itemId);

  const selectedCount = selectedItemIds.length;

  return (
    <div className="flex flex-col gap-10">
      {loading && (
        <div className="flex items-center gap-3 text-crimson/50 font-mono text-xs">
          <Loader2 size={16} className="animate-spin" />
          CARREGANDO MÓDULO LOCAL...
        </div>
      )}

      {/* ===== LOCALIZAÇÃO + DESCOBERTA (B1) ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<MapPin size={16} />}>LOCALIZAÇÃO E DESCOBERTA DE MERCADOS</SectionTitle>
          <span className="text-[9px] font-mono text-crimson/40">
            {currentLoc?.lat
              ? `ATUAL: (${currentLoc.lat}, ${currentLoc.lng})${currentLoc.address ? " — " + currentLoc.address : ""}`
              : "SEM LOCALIZAÇÃO SALVA"}
          </span>
        </div>

        <div className="hud-border-map bg-black/40 p-6 mt-4 flex flex-col gap-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <label className={labelCls}>CEP</label>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  value={locCep}
                  onChange={(e) => setLocCep(e.target.value)}
                  placeholder="00000-000"
                  maxLength={9}
                  onKeyDown={(e) => e.key === "Enter" && lookupLocationByCep(locCep, setLocLat, setLocLng, setLocAddress)}
                />
                <button
                  onClick={() => lookupLocationByCep(locCep, setLocLat, setLocLng, setLocAddress)}
                  disabled={locCepLoading || locCep.replace(/\D/g, "").length !== 8}
                  className="hud-button text-[10px] px-2 py-1 shrink-0 disabled:opacity-50"
                >
                  {locCepLoading ? <Loader2 size={12} className="animate-spin" /> : <MapPin size={12} />}
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <label className={labelCls}>ENDEREÇO (GEOCODING NOMINATIM)</label>
              <input
                className={inputCls}
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
                placeholder="RUA, Nº — CIDADE — UF"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>LATITUDE</label>
              <input className={inputCls} value={locLat} onChange={(e) => setLocLat(e.target.value)} placeholder="-23.5505" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>LONGITUDE</label>
              <input className={inputCls} value={locLng} onChange={(e) => setLocLng(e.target.value)} placeholder="-46.6333" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>RAIO DE BUSCA (KM)</label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                className={inputCls}
                value={locRadiusKm}
                onChange={(e) => setLocRadiusKm(e.target.value)}
              />
            </div>
          </div>

          <button
            onClick={() => setShowMap(!showMap)}
            className="hud-button flex items-center gap-2 text-xs self-start"
          >
            <MapPin size={14} /> {showMap ? "FECHAR MAPA" : "ABRIR MAPA E MARCAR PIN"}
          </button>

          {showMap && (
            <MapPicker
              lat={parseFloat(locLat) || -23.5505}
              lng={parseFloat(locLng) || -46.6333}
              onChange={(lat, lng) => { setLocLat(String(lat)); setLocLng(String(lng)); }}
              onAddressFound={(addr) => setLocAddress(addr)}
            />
          )}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => {
                if (!navigator.geolocation) {
                  toast("GEOLOCALIZAÇÃO NÃO SUPORTADA NESTE NAVEGADOR", "error");
                  return;
                }
                playSound("click");
                navigator.geolocation.getCurrentPosition(
                  (pos) => {
                    setLocLat(String(pos.coords.latitude.toFixed(6)));
                    setLocLng(String(pos.coords.longitude.toFixed(6)));
                    toast("LOCALIZAÇÃO ATUAL DETECTADA", "success", `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`);
                  },
                  (err) => {
                    toast("FALHA AO OBTER LOCALIZAÇÃO", "error", err.message);
                  },
                  { enableHighAccuracy: true, timeout: 10000 }
                );
              }}
              className="hud-button flex items-center gap-2 text-xs"
              title="Detectar minha localização atual via GPS do navegador"
            >
              <Navigation size={14} /> MINHA LOCALIZAÇÃO
            </button>
            <button
              onClick={() => { playSound("click"); saveLocation(); }}
              disabled={locSaving}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
            >
              {locSaving ? <Loader2 size={14} className="animate-spin" /> : <LocateFixed size={14} />}
              {locSaving ? "SALVANDO..." : "SALVAR LOCALIZAÇÃO"}
            </button>
            <button
              onClick={() => { playSound("click"); discoverNearby(); }}
              disabled={discovering || !currentLoc?.lat}
              className="hud-button flex items-center gap-2 disabled:opacity-50"
              title="Varre o OpenStreetMap (Overpass) procurando mercados no raio"
            >
              {discovering ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
              {discovering ? "VARRENDO..." : "DESCOBRIR MERCADOS PRÓXIMOS"}
            </button>
          </div>

          {!currentLoc?.lat && (
            <p className="text-[9px] font-mono text-crimson/40">
              DEFINA A LOCALIZAÇÃO PRIMEIRO PARA HABILITAR A DESCOBERTA VIA OVERPASS.
            </p>
          )}
        </div>
      </section>

      {/* ===== ROTEIRIZAÇÃO ===== */}
      <section>
        <SectionTitle icon={<RouteIcon size={16} />}>ROTEIRIZAÇÃO DE COMPRAS</SectionTitle>
        <div className="hud-border-map bg-black/40 p-6 mt-4 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className={labelCls}>ITENS SELECIONADOS ({selectedCount})</span>
            <div className="flex flex-wrap gap-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => toggleSelectedItem(item.id)}
                  className={cn(
                    "text-[10px] font-mono px-3 py-1 border transition-all",
                    selectedItemIds.includes(item.id)
                      ? "border-crimson bg-crimson/20 text-crimson glow-text"
                      : "border-crimson/30 text-crimson/60 hover:border-crimson/70"
                  )}
                >
                  {item.name.toUpperCase()}
                  {item.quantity ? ` x${item.quantity}` : ""}
                </button>
              ))}
              {items.length === 0 && (
                <span className="text-[10px] font-mono text-crimson/30">
                  ADICIONE ITENS NA LISTA DE COMPRAS ABAIXO
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <label className={labelCls}>LATITUDE INICIAL</label>
              <input className={inputCls} value={startLat} onChange={(e) => setStartLat(e.target.value)} placeholder="-23.5505" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>LONGITUDE INICIAL</label>
              <input className={inputCls} value={startLng} onChange={(e) => setStartLng(e.target.value)} placeholder="-46.6333" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>NOME DA ROTA (OPCIONAL)</label>
              <input className={inputCls} value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="COMPRA DO MÊS" />
            </div>
          </div>

          <button
            onClick={() => setShowRouteMap(!showRouteMap)}
            className="hud-button flex items-center gap-2 text-xs self-start"
          >
            <MapPin size={14} /> {showRouteMap ? "FECHAR MAPA" : "MARCAR PONTO DE PARTIDA NO MAPA"}
          </button>

          {showRouteMap && (
            <MapPicker
              lat={parseFloat(startLat) || -23.5505}
              lng={parseFloat(startLng) || -46.6333}
              onChange={(lat, lng) => { setStartLat(String(lat)); setStartLng(String(lng)); }}
              showCepSearch={false}
              height="300px"
            />
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1">
              <label className={labelCls}>VEÍCULO</label>
              <select className={inputCls} value={vehType} onChange={(e) => setVehType(e.target.value as any)}>
                <option value="car">CARRO</option>
                <option value="motorcycle">MOTO</option>
                <option value="public">TRANSPORTE PÚBLICO</option>
                <option value="bike">BICICLETA</option>
                <option value="foot">A PÉ</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>
                {vehType === "public" ? "TARIFA POR VIAGEM (R$)" : "CONSUMO (KM/L)"}
              </label>
              {vehType === "public" ? (
                <input type="number" step="0.1" className={inputCls} value={vehPublicFare} onChange={(e) => setVehPublicFare(e.target.value)} />
              ) : (
                <input
                  type="number"
                  step="0.1"
                  className={inputCls}
                  value={vehKmPerL}
                  disabled={vehType === "bike" || vehType === "foot"}
                  onChange={(e) => setVehKmPerL(e.target.value)}
                />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>COMBUSTÍVEL (R$/L)</label>
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={vehFuelPrice}
                disabled={vehType === "public" || vehType === "bike" || vehType === "foot"}
                onChange={(e) => setVehFuelPrice(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls}>HORÁRIO DE SAÍDA</label>
              <select className={inputCls} value={startTimeMode} onChange={(e) => setStartTimeMode(e.target.value as any)}>
                <option value="suggest">SUGERIR MENOR MOVIMENTO</option>
                <option value="specific">HORÁRIO ESPECÍFICO</option>
              </select>
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <label className={labelCls}>DATA/HORA (SE ESPECÍFICO)</label>
              <input
                type="datetime-local"
                className={inputCls}
                value={startTimeSpecific}
                disabled={startTimeMode !== "specific"}
                onChange={(e) => setStartTimeSpecific(e.target.value)}
              />
            </div>
          </div>

          <button
            onClick={generateRoute}
            disabled={generating}
            className="hud-button flex items-center justify-center gap-2 py-3 disabled:opacity-40"
          >
            {generating ? (
              <>
                <Loader2 size={16} className="animate-spin" /> CALCULANDO ROTA...
              </>
            ) : (
              <>
                <Navigation size={16} /> GERAR ROTA
              </>
            )}
          </button>
        </div>
      </section>

      {/* ===== ROTAS SALVAS ===== */}
      <section>
        <SectionTitle icon={<MapPin size={16} />}>ROTAS SALVAS ({routes.length})</SectionTitle>
        <div className="mt-4 flex flex-col gap-4">
          {routes.map((route) => (
            <motion.div
              key={route.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "hud-border bg-black/40 p-5 flex flex-col gap-3",
                latestRouteId === route.id && "border-crimson/70 shadow-[0_0_20px_rgba(255,0,0,0.2)]"
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm">
                      {(route.name || `ROTA ${route.id.slice(0, 8)}`).toUpperCase()}
                    </span>
                    {latestRouteId === route.id && (
                      <span className="bg-crimson text-black font-mono text-[8px] px-1.5 py-0.5 font-bold animate-pulse">
                        NOVA
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-[10px] font-mono text-crimson/50">
                    <span>{new Date(route.createdAt).toLocaleString("pt-BR")}</span>
                    <span>{route.stops.length} PARADAS</span>
                    <span>{route.totalDistanceKm?.toFixed(1)} KM</span>
                    {route.vehicleType && (
                      <span>
                        {route.vehicleType === "car" ? "CARRO" : route.vehicleType === "motorcycle" ? "MOTO" : route.vehicleType === "public" ? "ÔNIBUS" : route.vehicleType === "bike" ? "BIKE" : "A PÉ"}
                      </span>
                    )}
                    {route.totalTimeMin !== undefined && (
                      <span>~{route.totalTimeMin} MIN</span>
                    )}
                    {route.travelCost !== undefined && route.travelCost > 0 && (
                      <span>DESLOC {fmtBRL(route.travelCost)}</span>
                    )}
                    {route.totalEstimatedCost !== undefined && (
                      <span>CUSTO {fmtBRL(route.totalEstimatedCost)}</span>
                    )}
                  </div>
                  {(route.suggestedDepartureAt || (route as any).departureTime) && (
                    <div className="flex items-center gap-2 text-[9px] font-mono text-amber-500/70">
                      <Clock size={10} />
                      <span>
                        MELHOR SAÍDA: {new Date(route.suggestedDepartureAt ?? (route as any).departureTime).toLocaleString("pt-BR")}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => deleteRoute(route.id)}
                  className="text-crimson/30 hover:text-crimson"
                  title="EXCLUIR ROTA"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="flex flex-col gap-2 mt-2">
                <div className="flex items-center gap-2 text-[10px] font-mono text-crimson/50">
                  <MapPin size={12} />
                  <span>
                    PARTIDA ({route.startLat}, {route.startLng})
                  </span>
                </div>
                {route.stops.map((stop) => (
                  <div key={stop.stopOrder} className="flex items-start gap-3 pl-4 relative">
                    <div className="absolute left-0 top-3 h-[calc(100%-12px)] w-px bg-crimson/20" />
                    <div className="w-5 h-5 rounded-full border border-crimson/50 flex items-center justify-center shrink-0 relative z-10 bg-black">
                      <span className="text-[8px] font-mono text-crimson font-bold">{stop.stopOrder}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs font-bold">{estNameById(stop.establishmentId).toUpperCase()}</span>
                      {(stop.arrivalTimeEstimate || stop.quietScore !== undefined) && (
                        <span className="text-[9px] font-mono text-crimson/40">
                          {stop.arrivalTimeEstimate
                            ? `CHEGA ${new Date(stop.arrivalTimeEstimate).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                            : ""}
                          {stop.quietScore !== undefined
                            ? `${stop.arrivalTimeEstimate ? " • " : ""}MOVIMENTO ${stop.quietScore}% TRANQUILO`
                            : ""}
                        </span>
                      )}
                      {stop.estimatedCost !== undefined && (
                        <span className="text-[10px] font-mono text-crimson/50">CUSTO ESTIMADO {fmtBRL(stop.estimatedCost)}</span>
                      )}
                      {stop.items && stop.items.length > 0 && (
                        <span className="text-[10px] font-mono text-crimson/30">
                          {stop.items.join(", ").toUpperCase()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ))}
          {routes.length === 0 && (
            <div className="hud-border p-10 text-center text-crimson/30 font-mono">
              NENHUMA ROTA CALCULADA AINDA
            </div>
          )}
        </div>
      </section>

      {/* ===== INSIGHTS LOCAIS (FASE 7) ===== */}
      <section>
        <div className="flex items-center justify-between">
          <SectionTitle icon={<BrainCircuit size={16} />}>INSIGHTS LOCAIS</SectionTitle>
          <button
            onClick={() => { playSound("click"); analyzeWithAI(); }}
            disabled={aiAnalyzing || insightsLoading}
            className="hud-button flex items-center gap-2 disabled:opacity-50"
          >
            {aiAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {aiAnalyzing ? "ANALISANDO..." : "ANALISAR COM IA"}
          </button>
        </div>

        <div className="hud-border bg-black/40 p-5 mt-4 flex flex-col gap-4">
          {insightsLoading ? (
            <div className="flex items-center gap-3 text-crimson/50 font-mono text-xs">
              <Loader2 size={16} className="animate-spin" /> CALCULANDO INSIGHTS...
            </div>
          ) : !insights ? (
            <div className="text-crimson/30 font-mono text-xs italic">
              SEM DADOS — REGISTRE ITENS E PREÇOS PARA ATIVAR A ANÁLISE
            </div>
          ) : (
            <>
              {/* Cartões de estratégia */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="border border-crimson/20 p-4 flex flex-col gap-1">
                  <span className="text-[8px] font-mono text-crimson/50 tracking-widest">MELHOR ROTA MULTI-PARADA</span>
                  <span className="font-mono text-xl font-bold text-green-500">
                    {insights.optimizedTotal > 0 ? fmtBRL(insights.optimizedTotal) : "—"}
                  </span>
                  <span className="text-[9px] font-mono text-crimson/40">
                    {insights.itemsWithPrice}/{insights.totalItems} ITENS COM PREÇO
                  </span>
                </div>
                <div className="border border-crimson/20 p-4 flex flex-col gap-1">
                  <span className="text-[8px] font-mono text-crimson/50 tracking-widest">TUDO EM UM LUGAR</span>
                  <span className="font-mono text-xl font-bold text-white">
                    {insights.singleStoreBest ? fmtBRL(insights.singleStoreBest.totalCost) : "—"}
                  </span>
                  <span className="text-[9px] font-mono text-crimson/40">
                    {insights.singleStoreBest?.establishmentName.toUpperCase() || "SEM PREÇOS"}
                  </span>
                </div>
                <div className="border border-crimson/20 p-4 flex flex-col gap-1">
                  <span className="text-[8px] font-mono text-crimson/50 tracking-widest">ECONOMIA POTENCIAL</span>
                  <span className="font-mono text-xl font-bold text-crimson glow-text">
                    {insights.economyVsSingleStore > 0 ? `-${fmtBRL(insights.economyVsSingleStore)}` : "R$ 0"}
                  </span>
                  <span className="text-[9px] font-mono text-crimson/40">
                    {insights.economyVsSingleStorePct}% ESCOLHENDO A ROTA OTIMIZADA
                  </span>
                </div>
              </div>

              {/* Melhor preço por item */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[8px] font-mono text-crimson/50 tracking-widest">MELHOR PREÇO POR ITEM</span>
                {insights.items.filter((i: any) => i.bestPrice > 0).map((i: any) => (
                  <div key={i.itemId} className="flex items-center justify-between text-[10px] font-mono border-b border-crimson/10 pb-1.5">
                    <span className="text-crimson/60 truncate">
                      {i.itemName.toUpperCase()}
                      {i.withinTarget && <span className="text-green-500 ml-2">● NO ALVO</span>}
                      {i.promotionApplied && <span className="text-amber-500 ml-2">PROMO</span>}
                    </span>
                    <span className="font-bold text-white shrink-0 ml-2">
                      {fmtBRL(i.bestPrice)} <span className="text-crimson/40 font-normal">em {i.bestEstablishmentName.toUpperCase()}</span>
                    </span>
                  </div>
                ))}
                {insights.itemsWithPrice === 0 && (
                  <div className="text-crimson/30 font-mono text-[10px] italic">NENHUM PREÇO REGISTRADO</div>
                )}
              </div>

              {/* Resumo determinístico */}
              {insightSummary && (
                <pre className="text-[10px] font-mono text-crimson/60 whitespace-pre-wrap border-t border-crimson/10 pt-3 font-sans">
                  {insightSummary}
                </pre>
              )}

              {/* Análise IA */}
              <AnimatePresence>
                {aiText && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden border border-crimson/30 bg-crimson/5 p-4"
                  >
                    <div className="flex items-center gap-2 mb-2 text-[8px] font-mono text-crimson/50 tracking-widest">
                      <Sparkles size={12} /> RELATÓRIO SENTINELA
                      {aiMethod && <span className="text-crimson/30">• {aiMethod.toUpperCase()}</span>}
                    </div>
                    <pre className="text-[11px] font-mono text-crimson/80 whitespace-pre-wrap font-sans">
                      {aiText}
                    </pre>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
