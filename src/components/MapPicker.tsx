import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import "leaflet/dist/leaflet.css";

const inputCls = "hud-input text-xs py-1 px-2 w-full";
const labelCls = "text-[8px] font-mono text-crimson/70 tracking-widest uppercase";

interface MapPickerProps {
  lat: number;
  lng: number;
  onChange: (lat: number, lng: number) => void;
  onAddressFound?: (address: string) => void;
  height?: string;
  showCepSearch?: boolean;
}

export function MapPicker({ lat, lng, onChange, onAddressFound, height = "350px", showCepSearch = true }: MapPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [cepInput, setCepInput] = useState("");
  const [cepLoading, setCepLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (mapInstanceRef.current || !mapRef.current) return;

    let cancelled = false;
    const initMap = async () => {
      const L = await import("leaflet");
      if (cancelled || !mapRef.current) return;

      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      const map = L.map(mapRef.current, { zoomControl: true }).setView([lat, lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      const marker = L.marker([lat, lng], { draggable: true }).addTo(map);

      marker.on("dragend", async () => {
        const pos = marker.getLatLng();
        onChange(pos.lat, pos.lng);
        reverseGeocode(pos.lat, pos.lng);
      });

      map.on("click", (e: any) => {
        marker.setLatLng(e.latlng);
        onChange(e.latlng.lat, e.latlng.lng);
        reverseGeocode(e.latlng.lat, e.latlng.lng);
      });

      mapInstanceRef.current = map;
      markerRef.current = marker;
      setMapReady(true);
    };

    initMap();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!markerRef.current) return;
    const current = markerRef.current.getLatLng();
    if (Math.abs(current.lat - lat) > 0.00001 || Math.abs(current.lng - lng) > 0.00001) {
      markerRef.current.setLatLng([lat, lng]);
      mapInstanceRef.current?.setView([lat, lng], mapInstanceRef.current.getZoom());
    }
  }, [lat, lng]);

  const reverseGeocode = async (rLat: number, rLng: number) => {
    if (!onAddressFound) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${rLat}&lon=${rLng}`,
        { headers: { "User-Agent": "CrimsonSentinel/1.0 (price tracker)" } }
      );
      if (res.ok) {
        const data = await res.json();
        onAddressFound(data.display_name || "");
      }
    } catch { /* ignore */ }
  };

  const handleCepSearch = async () => {
    const cleaned = cepInput.replace(/\D/g, "");
    if (cleaned.length !== 8) return;
    setCepLoading(true);
    try {
      const cepRes = await fetch(`https://viacep.com.br/ws/${cleaned}/json/`);
      const cepData = await cepRes.json();
      if (cepData.erro) return;

      const address = `${cepData.logradouro}, ${cepData.bairro}, ${cepData.localidade} - ${cepData.uf}`;
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`,
        { headers: { "User-Agent": "CrimsonSentinel/1.0 (price tracker)", "Accept-Language": "pt-BR" } }
      );
      const nomData = await nomRes.json();
      if (Array.isArray(nomData) && nomData.length > 0) {
        const newLat = parseFloat(nomData[0].lat);
        const newLng = parseFloat(nomData[0].lon);
        onChange(newLat, newLng);
        onAddressFound?.(nomData[0].display_name || address);
        if (mapInstanceRef.current) {
          mapInstanceRef.current.setView([newLat, newLng], 16);
        }
      }
    } catch { /* ignore */ }
    finally { setCepLoading(false); }
  };

  return (
    <div className="flex flex-col gap-2">
      {showCepSearch && (
        <div className="flex gap-2 items-end">
          <div className="flex-1 flex flex-col gap-1">
            <label className={labelCls}>BUSCAR POR CEP</label>
            <input
              className={inputCls}
              value={cepInput}
              onChange={(e) => setCepInput(e.target.value)}
              placeholder="00000-000"
              maxLength={9}
              onKeyDown={(e) => e.key === "Enter" && handleCepSearch()}
            />
          </div>
          <button onClick={handleCepSearch} disabled={cepLoading} className="hud-button text-xs px-3 py-1 flex items-center gap-1 shrink-0 disabled:opacity-50">
            <MapPin size={12} />
            {cepLoading ? "BUSCANDO..." : "LOCALIZAR"}
          </button>
        </div>
      )}
      <div ref={mapRef} style={{ height, width: "100%", borderRadius: 0, border: "1px solid rgba(220,38,38,0.2)" }} />
      {mapReady && (
        <span className="text-[9px] font-mono text-crimson/40">
          LAT: {lat.toFixed(6)} | LNG: {lng.toFixed(6)} — CLIQUE NO MAPA OU ARRASTE O PIN
        </span>
      )}
    </div>
  );
}
