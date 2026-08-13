#!/bin/sh
set -eu

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if [ "${OPENBROWSE_VNC_BRIDGE_URL:-}" != "" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 1440x960x24 -nolisten tcp &
  x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport 5900 &
  websockify 6080 localhost:5900 &
fi

exec node dist/index.js
