// Circuit breaker por domínio para o scraper (FASE 3).
//
// Objetivo: durante uma indisponibilidade de loja ou bloqueio anti-bot, NÃO
// queimar 3-5 launches de Playwright (~10-30s cada) por job. Quando o circuito
// abre, as estratégias pesadas (Playwright) são puladas e só as baratas
// (FETCH_FALLBACK / GEMINI_FALLBACK) são tentadas. Depois do cooldown, o
// circuito entra em half-open: um probe roda o fluxo completo — sucesso
// reinicia, falha re-abre com novo cooldown.
//
// Estado em memória por processo. Como BullMQ já dá retry por job, o breaker é
// uma proteção complementar de recursos, não de consistência.

interface BreakerState {
  failures: number;
  openedAt: number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly states = new Map<string, BreakerState>();

  constructor(threshold = 3, cooldownMs = 5 * 60 * 1000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  isOpen(domain: string): boolean {
    const s = this.states.get(domain);
    if (!s) return false;
    if (s.failures < this.threshold) return false;
    return Date.now() - s.openedAt < this.cooldownMs;
  }

  recordSuccess(domain: string): void {
    this.states.delete(domain);
  }

  recordFailure(domain: string): void {
    const cur = this.states.get(domain) ?? { failures: 0, openedAt: 0 };
    cur.failures += 1;
    if (cur.failures >= this.threshold) {
      cur.openedAt = Date.now();
    }
    this.states.set(domain, cur);
  }

  reset(): void {
    this.states.clear();
  }
}

// Exported singleton usado pelo scraper.
export const scraperBreaker = new CircuitBreaker(3, 5 * 60 * 1000);
