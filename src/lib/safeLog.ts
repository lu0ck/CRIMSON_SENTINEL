// Helper de log compartilhado entre API e workers.
// Mantém o formato idêntico ao `safeLog` antigo do server.ts (string-safe JSON).

export function safeLog(msg: unknown): void {
  if (typeof msg === "string") {
    console.log(msg);
  } else {
    try {
      console.log(JSON.stringify(msg));
    } catch {
      console.log(String(msg));
    }
  }
}
