#!/bin/bash
# Setup do microserviço Instagram (instagrapi)
# Uso: bash scripts/setup-instagram.sh
set -e

VENV_DIR="python_instagram/.venv"
REQ_FILE="python_instagram/requirements.txt"

if [ ! -d "$VENV_DIR" ]; then
  echo "[instagram] Criando venv em $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi

echo "[instagram] Instalando dependências ..."
"$VENV_DIR/bin/pip" install -q --upgrade pip
"$VENV_DIR/bin/pip" install -q -r "$REQ_FILE"

echo "[instagram] Setup concluído!"
echo ""
echo "Para iniciar:"
echo "  $VENV_DIR/bin/uvicorn python_instagram.server:app --host 127.0.0.1 --port 8721"
echo ""
echo "Variáveis de ambiente necessárias (no mesmo terminal ou .env):"
echo "  IG_USERNAME=seu_usuario"
echo "  IG_PASSWORD=sua_senha"
