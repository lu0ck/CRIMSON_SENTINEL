// Bootstrap para pm2 cluster mode em Node < 22 (sem native type stripping).
// O cluster exige que o script seja JS carregável direto pelo node; aqui
// registramos o hook ESM do tsx em-processo e importamos o worker real,
// preservando o IPC do cluster (cli.mjs spawnaria um filho e quebraria).
import { register } from "tsx/esm/api";
register();
await import("../src/workers/scanWorkerEntry.ts");
