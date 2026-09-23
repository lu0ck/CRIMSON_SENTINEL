// Datas/horas de SQLite — FONTE ÚNICA (#27).
// sqlite datetime('now') grava UTC como "YYYY-MM-DD HH:MM:SS" (sem Z).
// Interpretar com new Date(str) direto trata como horário LOCAL → bug de fuso.

/** Converte timestamp SQLite UTC para Date (local). Aceita também ISO com T/Z. */
export function sqlUtcToDate(value: string): Date {
  if (!value) return new Date(NaN);
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Date(iso);
}

/** Timestamp SQLite/ISO → string local pt-BR. */
export function formatLocalDateTime(value: string): string {
  const d = sqlUtcToDate(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("pt-BR");
}
