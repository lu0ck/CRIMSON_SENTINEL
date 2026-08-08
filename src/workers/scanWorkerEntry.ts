import { startScanWorker } from "./scanWorker";

startScanWorker();

// Mantém o processo vivo; pm2 faz o restart automático em crash.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
