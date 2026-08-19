#!/usr/bin/env bash
#
# Crimson Sentinel — teste de estresse de 24h
# -------------------------------------------------
# Uso:
#   bash scripts/stress-test-24h.sh [duracao_horas] [intervalo_min]
#
# Exemplos:
#   bash scripts/stress-test-24h.sh 24 5       # 24h, amostra a cada 5min
#   DURATION_MINUTES=10 bash scripts/stress-test-24h.sh   # rápido p/ validar
#
# O script amostra /api/status, as filas BullMQ (via redis-cli) e o estado do
# PM2, registra tudo num log em /tmp/crimson-stress/ e ao final gera
# RELATORIO_TESTE_24H.md na raiz do projeto.
#
set -uo pipefail

API_URL="${API_URL:-http://localhost:3000}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"

DURATION_HOURS="${1:-24}"
SAMPLE_MINUTES="${2:-5}"
# Permite rodar em minutos para validar rápido: DURATION_MINUTES=10
if [ -n "${DURATION_MINUTES:-}" ]; then
  DURATION_SECONDS=$((DURATION_MINUTES * 60))
else
  DURATION_SECONDS=$((DURATION_HOURS * 3600))
fi

LOG_DIR="/tmp/crimson-stress"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/crimson-stress-$(date +%Y%m%d-%H%M%S).log"
REPORT_FILE="RELATORIO_TESTE_24H.md"

START_TS=$(date +%s)
END_TS=$((START_TS + DURATION_SECONDS))
SAMPLE_SECONDS=$((SAMPLE_MINUTES * 60))

say()  { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }
mark() { echo "$1" >> "$LOG_FILE"; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

finalize() {
  local end_ts=$(date +%s)
  local total=$((end_ts - START_TS))
  say "== FINALIZANDO =="

  # Consolida métricas a partir do log
  local samples=$(grep -c '^SAMPLE ' "$LOG_FILE" || true)
  local fails=$(grep '^SAMPLE ' "$LOG_FILE" | grep -c 'status=.*failed' || true)
  local ok=$((samples - fails))
  local avg_lat="?"
  if [ "$samples" -gt 0 ]; then
    avg_lat=$(grep '^SAMPLE ' "$LOG_FILE" | sed -n 's/.*lat=\([0-9]*\).*/\1/p' \
      | awk '{ s+=$1; n++ } END { if (n>0) printf "%.0f", s/n; else print "0" }')
  fi
  local max_lat="?"
  if [ "$samples" -gt 0 ]; then
    max_lat=$(grep '^SAMPLE ' "$LOG_FILE" | sed -n 's/.*lat=\([0-9]*\).*/\1/p' \
      | awk '{ if ($1>m) m=$1 } END { print m+0 }')
  fi

  local up_pct="?"
  if [ "$samples" -gt 0 ]; then
    up_pct=$(awk -v ok="$ok" -v n="$samples" 'BEGIN { printf "%.1f", 100*ok/n }')
  fi

  say "Amostras: $samples | Falhas: $fails | Uptime API: ${up_pct}%"
  say "Latência média: ${avg_lat}ms | Máxima: ${max_lat}ms"
  say "Duração: ${total}s (~$(awk -v t="$total" 'BEGIN { printf "%.1f", t/3600 }')h)"

  # Baseline para o relatório
  local baseline_scan_wait=$(grep -m1 '^BASELINE ' "$LOG_FILE" | sed -n 's/.*scan.wait=\([0-9]*\).*/\1/p')
  local baseline_scan_failed=$(grep -m1 '^BASELINE ' "$LOG_FILE" | sed -n 's/.*scan.failed=\([0-9]*\).*/\1/p')
  local final_scan_failed=$(grep '^SAMPLE ' "$LOG_FILE" | tail -n1 | sed -n 's/.*scan.failed=\([0-9]*\).*/\1/p')
  local jobs_failed_delta="?"
  if [ -n "${baseline_scan_failed}" ] && [ -n "${final_scan_failed}" ]; then
    jobs_failed_delta=$((final_scan_failed - baseline_scan_failed))
  fi

  cat > "$REPORT_FILE" <<EOF
# RELATÓRIO DE TESTE DE ESTABILIDADE — 24H

- **Período**: $(date -d @$START_TS '+%F %T') → $(date -d @$end_ts '+%F %T') UTC
- **Duração**: ${total}s (~$(awk -v t="$total" 'BEGIN { printf "%.1f", t/3600 }')h)
- **Amostras coletadas**: ${samples}
- **Uptime da API (/api/status)**: ${up_pct}%
- **Falhas de amostragem**: ${fails}
- **Latência média da API**: ${avg_lat}ms
- **Latência máxima**: ${max_lat}ms
- **Jobs em falha no scan-queue (delta)**: ${jobs_failed_delta}
- **Log completo**: \`${LOG_FILE}\`

## Status do processo (baseline)
EOF
  pm2 jlist 2>/dev/null | grep -o '"name":"[^"]*","pm2_env":{[^}]*"status":"[^"]*"' \
    | sed 's/"name":/  - /; s/","pm2_env":.*"status":/ → /; s/"$//' >> "$REPORT_FILE" \
    || echo "  (pm2 indisponível na consolidação)" >> "$REPORT_FILE"

  cat >> "$REPORT_FILE" <<EOF

## Métricas de filas BullMQ (última amostra)

\`\`\`
$(grep '^SAMPLE ' "$LOG_FILE" | tail -n1 | sed 's/^SAMPLE //')
\`\`\`

## Resumo

$([ "$fails" -eq 0 ] && [ "${up_pct}" = "100.0" ] \
  && echo "- **APROVADO**: nenhuma falha durante o período." \
  || echo "- **REVISAR**: verifique as falhas abaixo no log e nos logs do PM2 (\`pm2 logs\`).")

- Processos: \`pm2 ls\` — todos devem estar "online".
- Sem Redis: \`docker compose ps\`.
EOF

  say "Relatório gerado: $REPORT_FILE"
}

sample() {
  local ts=$(date '+%F %T')
  local now=$(date +%s)
  local line="SAMPLE ts=$ts"

  # 1) API /api/status (latência em ms)
  local start_ms code end_ms lat
  start_ms=$(date +%s%3N)
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$API_URL/api/status" 2>/dev/null || echo "000")
  end_ms=$(date +%s%3N)
  lat=$((end_ms - start_ms))
  if [ "$code" = "200" ]; then
    line="$line status=ok lat=$lat"
  else
    line="$line status=failed code=$code lat=$lat"
  fi

  # 2) Filas BullMQ via redis-cli (opcional)
  if have_cmd redis-cli; then
    for q in scan-queue route-queue social-monitor-queue; do
      local w a f c d
      w=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "bull:$q:wait" 2>/dev/null || echo "?")
      a=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "bull:$q:active" 2>/dev/null || echo "?")
      f=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "bull:$q:failed" 2>/dev/null || echo "?")
      c=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "bull:$q:completed" 2>/dev/null || echo "?")
      d=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw ZCARD "bull:$q:delayed" 2>/dev/null || echo "?")
      line="$line $q.wait=$w $q.active=$a $q.failed=$f $q.completed=$c $q.delayed=$d"
    done
  fi

  # 3) Processos PM2 online
  if have_cmd pm2; then
    local procs
    procs=$(pm2 jlist 2>/dev/null | grep -o '"status":"online"' | wc -l)
    line="$line processes=$procs"
  fi

  mark "$line"
  say "$line"
}

main() {
  say "== CRIMSON SENTINEL — TESTE DE ESTRESSE =="
  say "API: $API_URL | Redis: $REDIS_HOST:$REDIS_PORT"
  say "Duração: ${DURATION_SECONDS}s | Amostra a cada ${SAMPLE_MINUTES}min"
  say "Log: $LOG_FILE"

  # Pré-requisitos
  for cmd in curl; do
    have_cmd "$cmd" || { say "ERRO: comando '$cmd' não encontrado."; exit 1; }
  done
  if ! have_cmd redis-cli; then
    say "AVISO: redis-cli não encontrado — métricas de fila serão omitidas."
  fi
  if ! have_cmd pm2; then
    say "AVISO: pm2 não encontrado — contagem de processos será omitida."
  fi

  # Baseline (estado inicial das filas e processos)
  local bline="BASELINE ts=$(date '+%F %T')"
  if have_cmd redis-cli; then
    for q in scan-queue route-queue social-monitor-queue; do
      bline="$bline $q.failed=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "bull:$q:failed" 2>/dev/null || echo '?')"
    done
  fi
  if have_cmd pm2; then
    bline="$bline processes=$(pm2 jlist 2>/dev/null | grep -o '"status":"online"' | wc -l)"
  fi
  mark "$bline"
  say "$bline"

  # Loop de amostragem
  while [ "$(date +%s)" -lt "$END_TS" ]; do
    sample
    sleep "$SAMPLE_SECONDS"
  done

  finalize
  exit 0
}

trap 'say "== INTERROMPIDO (Ctrl+C) — consolidando... =="; finalize; exit 130' INT TERM
main "$@"
