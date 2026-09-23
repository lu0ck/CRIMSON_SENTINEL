#!/usr/bin/env bash
#
# SENTINELA — teste de saturação do scan-worker cluster (#30)
# -------------------------------------------------------------
# Enfileira N jobs type=scrape na scan-queue e observa:
#   - wait/active/completed/failed (BullMQ via redis-cli)
#   - processos pm2 (scan-worker 4×cluster)
#   - stalled/re-delivery (lockDuration 120s × estratégia 90s)
#
# Uso (Redis + API + pm2 cluster online):
#   bash scripts/stress-cluster-20.sh           # 20 jobs (padrão)
#   N_JOBS=20 TIMEOUT_S=300 bash scripts/stress-cluster-20.sh
#
# Critérios de aprovação:
#   - 4 workers scan-worker online durante todo o teste
#   - jobs completed + failed + remaining == N_JOBS (sem perder job)
#   - failed_delta não explode por stalled (failedReason ≠ "stalled" idealmente)
#   - API /api/status responde 200 em todas as amostras
#
set -uo pipefail

API_URL="${API_URL:-http://127.0.0.1:3001}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
N_JOBS="${N_JOBS:-20}"
TIMEOUT_S="${TIMEOUT_S:-300}"
SAMPLE_S="${SAMPLE_S:-2}"
QUEUE="scan-queue"

# Vitrine FASE 14 (8/8) + URLs variadas p/ load realista de Playwright.
# Se PRODUCT_IDS no profile existir, opcionalmente use productId — aqui só URL.
URLS=(
  "https://www.aliexpress.com/item/1005001234567890.html"
  "https://www.aliexpress.com/item/1005002345678901.html"
  "https://www.aliexpress.com/item/1005003456789012.html"
  "https://www.kabum.com.br/produto/123456/ssd-kingston-1tb"
  "https://www.pichau.com.br/hardware/fontes/fonte-xpg-core-reactor-650w"
  "https://www.amazon.com.br/dp/B0C1234567"
  "https://articulo.mercadolibre.com.br/MLB-123456789-kit-fans"
  "https://articulo.mercadolibre.com.br/MLB-987654321-pasta-termica"
  "https://www.magazueluiza.com.br/produto/111111/placa-de-video"
  "https://www.casasbahia.com.br/produto/222222/ar-condicionado"
  "https://www.pontofrio.com.br/produto/333333/micro-ondas"
  "https://www.shopee.com.br/product/44444444/44444444"
  "https://www.olx.com.br/item/5555555555"
  "https://www.terabyteshop.com.br/produto/666666/memoria-ram"
  "https://www.kabum.com.br/produto/777777/placa-mae"
  "https://www.pichau.com.br/produto/888888/gabinete"
  "https://www.amazon.com.br/dp/B0D2345678"
  "https://articulo.mercadolibre.com.br/MLB-111222333/teclado"
  "https://www.magazueluiza.com.br/produto/999999/mouse-gamer"
  "https://www.casasbahia.com.br/produto/10101000/fone-bluetooth"
)

LOG_DIR="/tmp/crimson-stress"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/cluster-20-$(date +%Y%m%d-%H%M%S).log"
REPORT_FILE="RELATORIO_TESTE_CLUSTER.md"

START_TS=$(date +%s)
END_TS=$((START_TS + TIMEOUT_S))
JOB_IDS_FILE="$LOG_DIR/cluster-jobs-$(date +%Y%m%d-%H%M%S).txt"
: > "$JOB_IDS_FILE"

say()  { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }
mark() { echo "$1" >> "$LOG_FILE"; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# pm2 pode não estar no PATH (instalação via npx) — fallback
pm2_cmd() {
  if have_cmd pm2; then pm2 "$@"; else npx --yes pm2 "$@"; fi
}

qlen() {
  # $1 = suffix da chave BullMQ (wait|active|completed|failed|delayed|…)
  # BullMQ: wait/active = LIST (LLEN); completed/failed/delayed = ZSET (ZCARD).
  # redis-cli imprime WRONGTYPE no stdout com exit 0 — validar se é numérico.
  local key="bull:$QUEUE:$1" t out=""
  t=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw TYPE "$key" 2>/dev/null | head -n1 | tr -d '\r')
  case "$t" in
    zset) out=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw ZCARD "$key" 2>/dev/null | head -n1 | tr -d '\r') ;;
    list) out=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw LLEN "$key" 2>/dev/null | head -n1 | tr -d '\r') ;;
    none) out=0 ;;
    *) out="?" ;;
  esac
  case "$out" in
    ''|*[!0-9]*) echo "?" ;;
    *) echo "$out" ;;
  esac
}

# Conta jobs da lista JOB_IDS_FILE presentes no zset informado
count_ids_in_zset() {
  local zset="bull:$QUEUE:$1" n=0 jid sc
  [ -f "$JOB_IDS_FILE" ] || { echo 0; return; }
  while IFS= read -r jid; do
    [ -z "$jid" ] && continue
    sc=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --raw ZSCORE "$zset" "$jid" 2>/dev/null | head -n1 | tr -d '\r')
    case "$sc" in ''|*[!0-9]*) ;; *) n=$((n + 1)) ;; esac
  done < "$JOB_IDS_FILE"
  echo "$n"
}

pm2_scan_workers() {
  pm2_cmd jlist 2>/dev/null | python3 -c '
import json,sys
try:
  apps=json.load(sys.stdin)
except Exception:
  print("?"); sys.exit(0)
n=0
for a in apps:
  if a.get("name")=="sentinela-scan-worker" and a.get("pm2_env",{}).get("status")=="online":
    n+=1
print(n)
' 2>/dev/null || echo "?"
}

enqueue_all() {
  say "Enfileirando $N_JOBS jobs type=scrape..."
  local i=0 ok=0
  while [ "$i" -lt "$N_JOBS" ]; do
    local url="${URLS[$((i % ${#URLS[@]}))]}"
    # Cache-bust: mesma URL 2× pode hitar cache de scraper e não exercitar Playwright
    local sep="?"
    case "$url" in *\?*) sep="&";; esac
    local url2="${url}${sep}stress=${i}-$(date +%s)"
    local resp code
    resp=$(curl -sS -m 20 -w "\n%{http_code}" -X POST "$API_URL/api/scrape" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$url2\"}" 2>>"$LOG_FILE" || true)
    code=$(printf '%s' "$resp" | tail -n1)
    local body
    body=$(printf '%s' "$resp" | sed '$d')
    if [ "$code" = "200" ]; then
      local jid
      jid=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("jobId",""))' 2>/dev/null || true)
      if [ -n "$jid" ]; then
        echo "$jid" >> "$JOB_IDS_FILE"
        ok=$((ok + 1))
        say "  job $jid ← $url2"
      else
        say "  WARN sem jobId: $body"
      fi
    else
      say "  FAIL http=$code url=$url2 body=$body"
    fi
    i=$((i + 1))
    # pequena pausa p/ não estourar rate do Express de uma vez
    sleep 0.15
  done
  say "Enfileirados: $ok / $N_JOBS"
  echo "$ok"
}

baseline_metrics() {
  echo "wait=$(qlen wait) active=$(qlen active) completed=$(qlen completed) failed=$(qlen failed) delayed=$(qlen delayed) workers=$(pm2_scan_workers)"
}

finalize() {
  local end_ts=$(date +%s)
  local total=$((end_ts - START_TS))
  local b_wait b_failed b_completed
  b_wait=$(echo "$BASELINE" | sed -n 's/.*wait=\([0-9]*\).*/\1/p')
  b_failed=$(echo "$BASELINE" | sed -n 's/.*failed=\([0-9]*\).*/\1/p')
  b_completed=$(echo "$BASELINE" | sed -n 's/.*completed=\([0-9]*\).*/\1/p')

  local last wait active completed failed workers
  last=$(grep '^SAMPLE ' "$LOG_FILE" | tail -n1 | sed 's/^SAMPLE //')
  wait=$(echo "$last" | sed -n 's/.*wait=\([0-9]*\).*/\1/p')
  active=$(echo "$last" | sed -n 's/.*active=\([0-9]*\).*/\1/p')
  completed=$(echo "$last" | sed -n 's/.*completed=\([0-9]*\).*/\1/p')
  failed=$(echo "$last" | sed -n 's/.*failed=\([0-9]*\).*/\1/p')
  workers=$(echo "$last" | sed -n 's/.*workers=\([0-9]*\).*/\1/p')

  local d_completed=0 d_failed=0
  case "${b_completed:-}" in ''|*[!0-9]*) ;; *) case "${completed:-}" in ''|*[!0-9]*) ;; *) d_completed=$((completed - b_completed)) ;; esac ;; esac
  case "${b_failed:-}" in ''|*[!0-9]*) ;; *) case "${failed:-}" in ''|*[!0-9]*) ;; *) d_failed=$((failed - b_failed)) ;; esac ;; esac

  # Contagem real dos NOSSOS jobs no final (baseline pode ter entradas antigas)
  local our_completed our_failed accounted pending
  our_completed=$(count_ids_in_zset completed)
  our_failed=$(count_ids_in_zset failed)
  accounted=$((our_completed + our_failed))
  pending=$((N_JOBS - accounted))
  local stalled_hits
  stalled_hits=$(grep '^SAMPLE \|^BASELINE \|Enfileir\|job \|status=' "$LOG_FILE" | grep -ci 'stalled' || true)

  local api_ok api_total
  # mark() grava "^SAMPLE"; say() grava "[ts] SAMPLE" — contar só o mark()
  api_ok=$(grep '^SAMPLE ' "$LOG_FILE" | grep -c 'status=ok' || true)
  api_total=$(grep -c '^SAMPLE ' "$LOG_FILE" || true)

  local verdict="REVISAR"
  if [ "${workers:-0}" = "4" ] && [ "$pending" -eq 0 ] && [ "$stalled_hits" -eq 0 ] \
     && [ "$api_ok" -eq "$api_total" ] && [ "$api_total" -gt 0 ]; then
    # failed pode ser >0 (URLs fake de stress) — ok se todos finalizaram sem stalled
    verdict="APROVADO"
  fi

  cat > "$REPORT_FILE" <<EOF
# RELATÓRIO — Stress scan-worker cluster (#30)

- **Data**: $(date '+%F %T')
- **Jobs solicitados**: $N_JOBS
- **Enfileirados**: ${ENQUEUED:-?}
- **Duração**: ${total}s (timeout ${TIMEOUT_S}s)
- **Baseline**: $BASELINE
- **Última amostra**: $last
- **Δ completed (fila)**: $d_completed
- **Δ failed (fila)**: $d_failed
- **Jobs nossos em completed**: $our_completed / $N_JOBS
- **Jobs nossos em failed**: $our_failed / $N_JOBS
- **Não finalizados (nossos)**: $pending
- **Menções a stalled no log**: $stalled_hits
- **Lock**: lockDuration=120s, stalledInterval=60s, maxStalledCount=1 (cobre estratégia scrape 90s)
- **Log**: \`${LOG_FILE}\`
- **Job IDs**: \`${JOB_IDS_FILE}\`

## Veredito

**$verdict**

## Critérios

| Critério | Status |
|---|---|
| 4 scan-workers online no fim | ${workers:-?} / 4 |
| Todos os jobs finalizados | ours completed+failed = $accounted / $N_JOBS (pending=$pending) |
| Sem stalled re-delivery | stalled_hits=$stalled_hits |
| API 200 nas amostras | $api_ok / $api_total amostras |

## Próximos passos se REVISAR

- \`npx --yes pm2 logs sentinela-scan-worker\` — procurar "stalled" / OOM
- \`redis-cli --raw ZSCORE bull:scan-queue:failed <jobId>\` + inspecionar failedReason
- Confirmar \`.env\` / profile keys para que scrapes não falhem por cota de IA
EOF

  say "Relatório: $REPORT_FILE → $verdict"
}

sample() {
  local ts
  ts=$(date '+%F %T')
  local start_ms code end_ms lat
  start_ms=$(date +%s%3N 2>/dev/null || date +%s000)
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$API_URL/api/status" 2>/dev/null || echo "000")
  end_ms=$(date +%s%3N 2>/dev/null || date +%s000)
  lat=$((end_ms - start_ms))
  local line="SAMPLE ts=$ts"
  if [ "$code" = "200" ]; then line="$line status=ok"; else line="$line status=failed code=$code"; fi
  line="$line lat=$lat wait=$(qlen wait) active=$(qlen active) completed=$(qlen completed) failed=$(qlen failed) delayed=$(qlen delayed) workers=$(pm2_scan_workers)"
  mark "$line"
  say "$line"
}

main() {
  say "== SENTINELA — STRESS CLUSTER SCAN-WORKER (#30) =="
  say "API=$API_URL jobs=$N_JOBS timeout=${TIMEOUT_S}s sample=${SAMPLE_S}s"
  say "Log=$LOG_FILE"

  have_cmd curl || { say "ERRO: curl obrigatório"; exit 1; }
  if ! have_cmd redis-cli; then
    say "ERRO: redis-cli obrigatório para métricas da fila"; exit 1
  fi
  if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -qi pong; then
    say "ERRO: Redis não responde em $REDIS_HOST:$REDIS_PORT"; exit 1
  fi
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$API_URL/api/status" || echo 000)
  if [ "$http_code" != "200" ]; then
    say "ERRO: API $API_URL/api/status → $http_code (suba sentinela-api)"; exit 1
  fi
  local w0
  w0=$(pm2_scan_workers)
  if [ "$w0" != "4" ] && [ "$w0" != "?" ]; then
    say "AVISO: scan-workers online=$w0 (esperado 4). Continuando..."
  elif [ "$w0" = "?" ]; then
    say "AVISO: pm2 indisponível no PATH — workers=?"
  fi

  BASELINE="BASELINE ts=$(date '+%F %T') $(baseline_metrics)"
  mark "$BASELINE"
  say "$BASELINE"

  ENQUEUED=$(enqueue_all | tail -n1)
  say "Enfileirados=$ENQUEUED"

  # Amostra até timeout ou filas zeradas (wait+active == 0 após jobs)
  while [ "$(date +%s)" -lt "$END_TS" ]; do
    sample
    local w a d
    w=$(qlen wait); a=$(qlen active); d=$(qlen delayed)
    # delayed de backoff ainda conta (retry attempts:3)
    if [ "$w" = "0" ] && [ "$a" = "0" ] && [ "$d" = "0" ] && [ -n "$ENQUEUED" ] && [ "$ENQUEUED" -gt 0 ]; then
      # deixa 1 amostra final
      sleep "$SAMPLE_S"
      sample
      break
    fi
    sleep "$SAMPLE_S"
  done

  finalize
}

trap 'say "== INTERROMPIDO — consolidando =="; finalize; exit 130' INT TERM
main "$@"
