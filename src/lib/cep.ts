export interface CepResult {
  cep: string;
  logradouro: string;
  bairro: string;
  localidade: string;
  uf: string;
}

export async function lookupCep(cep: string, opts: { timeoutMs?: number } = {}): Promise<CepResult | null> {
  const cleaned = cep.replace(/\D/g, "");
  if (cleaned.length !== 8) return null;
  const url = `https://viacep.com.br/ws/${cleaned}/json/`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CrimsonSentinel/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.erro) return null;
    return { cep: data.cep, logradouro: data.logradouro, bairro: data.bairro, localidade: data.localidade, uf: data.uf };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
