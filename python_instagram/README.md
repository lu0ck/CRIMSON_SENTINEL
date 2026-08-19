# ⚠️ AVISO IMPORTANTE — LEIA ANTES DE USAR ⚠️
#
# Este microserviço usa a biblioteca NÃO-OFICIAL `instagrapi` (Python) que se
# conecta ao Instagram via API privada reversa-engineered. Isso VIOLA os
# Termos de Serviço do Instagram e pode resultar em BANIMENTO PERMANENTE
# da conta usada, sobretudo se houver logins repetidos ou uso agressivo.
#
# RISCOS:
#   1. Bloqueio temporário ("suspicious login") ou banimento definitivo.
#   2. Perda da conta + todo histórico (Stories, posts, DMs).
#   3. Em casos extremos, suspensão de contas MMeta associadas (Facebook/WhatsApp).
#
# REGRAS OBRIGATÓRIAS para reduzir risco:
#   - Use SEMPRE uma conta secundária dedicada (e-mail descartável, número fictício).
#   - NUNCA use sua conta pessoal ou profissional.
#   - Sessão é persistida em disco (session.json) para evitar re-logins.
#   - Throttle: 1 req por vez, 30-60 min entre stories de cada handle.
#   - Habilite apenas via .env: INSTAGRAM_ENABLED=true + SOCIAL_MONITORING_ENABLED=true
#
# Como rodar:
#   pip install -r python_instagram/requirements.txt
#   uvicorn python_instagram.server:app --port 8721
#
# O usuário deste projeto ACEITA todos os riscos acima.
# =============================================================================
