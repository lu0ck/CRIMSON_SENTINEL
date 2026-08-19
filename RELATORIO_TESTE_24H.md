# RELATÓRIO DE TESTE DE ESTABILIDADE — 24H

- **Período**: 2026-08-18 12:42:36 → 2026-08-18 12:51:49 UTC
- **Duração**: 553s (~0,2h)
- **Amostras coletadas**: 2
- **Uptime da API (/api/status)**: 0,0%
- **Falhas de amostragem**: 2
- **Latência média da API**: 16ms
- **Latência máxima**: 18ms
- **Jobs em falha no scan-queue (delta)**: ?
- **Log completo**: `/tmp/crimson-stress/crimson-stress-20260818-124236.log`

## Status do processo (baseline)
  (pm2 indisponível na consolidação)

## Métricas de filas BullMQ (última amostra)

```
ts=2026-08-18 12:47:37 status=failed code=000000 lat=15
```

## Resumo

- **REVISAR**: verifique as falhas abaixo no log e nos logs do PM2 (`pm2 logs`).

- Processos: `pm2 ls` — todos devem estar "online".
- Sem Redis: `docker compose ps`.
