#!/usr/bin/env bash
# Instala (o actualiza) el Visor Multicámara en un servidor Ubuntu propio.
#
# Uso, como root en el servidor:
#   curl -fsSL https://raw.githubusercontent.com/edualexis10/zonas-pagas-red/main/deploy/install.sh | bash
#
# Volver a ejecutarlo actualiza la app a la última versión de GitHub sin
# perder los videos ni la configuración.
#
# Variables opcionales (se escriben antes de "bash"):
#   PORT=3010          puerto interno (Caddy lo publica hacia afuera)
#   MAX_JOBS=1         videos que se procesan a la vez
#   BRANCH=main        rama de GitHub
set -euo pipefail

REPO="https://github.com/edualexis10/zonas-pagas-red.git"
BRANCH="${BRANCH:-main}"
APP_DIR="/opt/zonas-pagas-red"
DATA_DIR="/var/lib/zonas-pagas-red"
ENV_FILE="/etc/zonas-pagas-red.env"
SERVICE="zonas-pagas-red"
APP_USER="visor"
PORT="${PORT:-3010}"
MAX_JOBS="${MAX_JOBS:-1}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Ejecútalo como root (o con sudo)."
command -v apt-get >/dev/null || fail "Este instalador es para Ubuntu/Debian."

# Si ya estaba instalado, se respeta el puerto configurado.
if [ -f "$ENV_FILE" ] && grep -q '^PORT=' "$ENV_FILE"; then
  PORT="$(grep '^PORT=' "$ENV_FILE" | cut -d= -f2)"
fi

say "Paquetes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  say "Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

say "Usuario y carpetas"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

say "Código de la app ($BRANCH)"
# La carpeta pertenece al usuario de la app; root la puede actualizar igual.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || git config --global --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
git -C "$APP_DIR" log --oneline -1

say "Dependencias (incluye ffmpeg; puede tardar 1-2 minutos)"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    fail "El puerto $PORT ya lo usa otra app. Vuelve a ejecutar con otro, por ejemplo: PORT=3011"
  fi
  say "Configuración inicial ($ENV_FILE)"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
DATA_DIR=$DATA_DIR
MAX_JOBS=$MAX_JOBS
NODE_ENV=production
# Contraseña para entrar a la app (vacía = sin contraseña):
APP_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
fi

say "Servicio del sistema"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Visor Multicámara (zonas-pagas-red)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
# Menor prioridad que las demás apps del servidor (intranet, etc.): una
# conversión de video no debe ponerlas lentas.
Nice=10
CPUWeight=30
IOWeight=30
MemoryMax=2500M

[Install]
WantedBy=multi-user.target
EOF
say "Actualización automática (revisa GitHub cada 30 minutos)"
cat > "/etc/systemd/system/$SERVICE-update.service" <<UNIT
[Unit]
Description=Actualiza el Visor Multicámara desde GitHub si hay cambios

[Service]
Type=oneshot
Environment=BRANCH=$BRANCH
ExecStart=/bin/bash $APP_DIR/deploy/update.sh
UNIT
cat > "/etc/systemd/system/$SERVICE-update.timer" <<UNIT
[Unit]
Description=Revisar actualizaciones del Visor Multicámara

[Timer]
OnBootSec=10min
OnUnitActiveSec=30min
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl enable -q --now "$SERVICE-update.timer"
systemctl restart "$SERVICE"

say "Comprobando que responde"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "OK: la app responde en http://127.0.0.1:$PORT"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || {
  journalctl -u "$SERVICE" -n 30 --no-pager
  fail "La app no respondió. Arriba están sus últimos mensajes."
}

cat <<EOF

Listo. Falta publicarla con Caddy. Agrega esto a /etc/caddy/Caddyfile
(cambia el dominio por el tuyo; ese dominio debe apuntar a este servidor):

  videos.TU-DOMINIO.cl {
      reverse_proxy 127.0.0.1:$PORT
  }

y luego:  systemctl reload caddy

Comandos útiles:
  Ver estado:      systemctl status $SERVICE
  Ver mensajes:    journalctl -u $SERVICE -f
  Contraseña:      nano $ENV_FILE   (APP_PASSWORD=...) y luego  systemctl restart $SERVICE
  Actualizar app:  es automático (cada 30 min, solo si no hay videos procesándose)
                   Para forzarlo ahora:  systemctl start $SERVICE-update
EOF
