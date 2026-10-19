#!/usr/bin/env bash
# Lo ejecuta cada 30 minutos el temporizador zonas-pagas-red-update.timer:
# si hay una versión nueva en GitHub y la app no está procesando videos, la
# instala con el mismo instalador (que reinicia la app).
set -euo pipefail
APP_DIR="/opt/zonas-pagas-red"
BRANCH="${BRANCH:-main}"
PORT="$(grep '^PORT=' /etc/zonas-pagas-red.env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3010}"

git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || git config --global --add safe.directory "$APP_DIR"
git -C "$APP_DIR" fetch -q origin "$BRANCH"
if [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")" ]; then
  exit 0 # ya está al día
fi
if curl -fsS "http://127.0.0.1:$PORT/healthz/busy" 2>/dev/null | grep -q '"busy":true'; then
  echo "Hay una versión nueva, pero la app está procesando videos: se reintenta en 30 minutos."
  exit 0
fi
echo "Actualizando a: $(git -C "$APP_DIR" log --oneline -1 "origin/$BRANCH")"
BRANCH="$BRANCH" bash "$APP_DIR/deploy/install.sh"
