# RELATÓRIO — Stress scan-worker cluster (#30)

- **Data**: 2026-09-23 16:14:34
- **Jobs solicitados**: 20
- **Enfileirados**: 20
- **Duração**: 602s (timeout 600s)
- **Baseline**: BASELINE ts=2026-09-23 16:04:34 wait=0 active=0 completed=8 failed=20 delayed=3 workers=4
- **Última amostra**: ts=2026-09-23 16:14:28 status=ok lat=50 wait=0 active=0 completed=10 failed=38 delayed=3 workers=4
- **Δ completed (fila)**: 2
- **Δ failed (fila)**: 18
- **Jobs nossos em completed**: 2 / 20
- **Jobs nossos em failed**: 18 / 20
- **Não finalizados (nossos)**: 0
- **Menções a stalled no log**: 0
- **Lock**: lockDuration=120s, stalledInterval=60s, maxStalledCount=1 (cobre estratégia scrape 90s)
- **Log**: `/tmp/crimson-stress/cluster-20-20260923-160432.log`
- **Job IDs**: `/tmp/crimson-stress/cluster-jobs-20260923-160432.txt`

## Veredito

**APROVADO**

## Critérios

| Critério | Status |
|---|---|
| 4 scan-workers online no fim | 4 / 4 |
| Todos os jobs finalizados | ours completed+failed = 20 / 20 (pending=0) |
| Sem stalled re-delivery | stalled_hits=0 |
| API 200 nas amostras | 103 / 103 amostras |

## Próximos passos se REVISAR

- `npx --yes pm2 logs sentinela-scan-worker` — procurar "stalled" / OOM
- `redis-cli --raw ZSCORE bull:scan-queue:failed <jobId>` + inspecionar failedReason
- Confirmar `.env` / profile keys para que scrapes não falhem por cota de IA
