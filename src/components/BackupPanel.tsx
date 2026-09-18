import { useState, useRef } from "react";
import { Loader2, Download, Upload } from "lucide-react";

interface BackupPanelProps {
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

export function BackupPanel({ addToast, playSound }: BackupPanelProps) {
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const backupFileRef = useRef<HTMLInputElement>(null);

  const toast = (message: string, type: "success" | "error" | "info", details?: string) =>
    addToast(message, type, details);

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
      playSound("success");
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
      JSON.parse(text);
      if (!confirm("ATENÇÃO: Isso SUBSTITUIRÁ todos os dados atuais. Continuar?")) {
        setRestoreLoading(false);
        return;
      }
      const res = await apiJson("/api/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      playSound("success");
      toast("BACKUP RESTAURADO", "success", JSON.stringify(res.imported));
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      toast("FALHA AO IMPORTAR BACKUP", "error", String(err?.message || err));
    } finally {
      setRestoreLoading(false);
    }
  };

  return (
    <div className="hud-border bg-black/40 p-6 flex flex-col gap-4">
      <p className="text-[10px] font-mono text-crimson/50">
        EXPORTE TODOS OS DADOS DO APLICATIVO (PERFIS, PRODUTOS, ESTABELECIMENTOS, LISTAS, PROMOÇÕES, ROTAS, FONTES SOCIAIS E CONFIGURAÇÕES) COMO ARQUIVO JSON.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={exportBackup}
          disabled={backupLoading}
          className="hud-button flex items-center gap-2 disabled:opacity-50"
        >
          {backupLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {backupLoading ? "EXPORTANDO..." : "EXPORTAR BACKUP COMPLETO"}
        </button>
        <button
          onClick={() => backupFileRef.current?.click()}
          disabled={restoreLoading}
          className="hud-button flex items-center gap-2 disabled:opacity-50"
        >
          {restoreLoading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {restoreLoading ? "RESTAURANDO..." : "RESTAURAR BACKUP"}
        </button>
        <input
          ref={backupFileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ""; }}
        />
      </div>
      <p className="text-[9px] font-mono text-red-400/50">
        ⚠ A RESTAURAÇÃO SUBSTITUIRÁ TODOS OS DADOS ATUAIS. FAÇA UM BACKUP ANTES DE RESTAURAR.
      </p>
    </div>
  );
}