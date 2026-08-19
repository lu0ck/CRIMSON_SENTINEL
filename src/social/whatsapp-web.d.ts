// Declarações de tipo mínimas para whatsapp-web.js e qrcode-terminal.
// A lib whatsapp-web.js não publica types oficiais; este arquivo evita erros TS.

declare module "whatsapp-web.js" {
  export interface ClientOptions {
    authStrategy?: any;
    puppeteer?: any;
  }

  export class Client {
    constructor(options?: ClientOptions);
    initialize(): Promise<void>;
    on(event: string, callback: (...args: any[]) => void): void;
    getChats(): Promise<any[]>;
    getState?(): Promise<string>;
  }

  export class LocalAuth {
    constructor(options?: { dataPath?: string });
  }

  const _default: {
    Client: typeof Client;
    LocalAuth: typeof LocalAuth;
  };

  export default _default;
}

declare module "qrcode-terminal" {
  export function generate(
    text: string,
    options: { small?: boolean },
    callback: (out: string) => void
  ): void;
}
