#!/bin/sh
set -eu

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

wait_for_unix_socket() {
  socket_path="$1"
  process_id="$2"
  process_name="$3"
  attempts=0

  while [ ! -S "$socket_path" ]; do
    if ! kill -0 "$process_id" 2>/dev/null; then
      wait "$process_id" || true
      echo "$process_name exited before creating $socket_path" >&2
      return 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      echo "$process_name did not create $socket_path within 10 seconds" >&2
      return 1
    fi
    sleep 0.1
  done
}

wait_for_tcp_port() {
  port="$1"
  process_id="$2"
  process_name="$3"
  attempts=0

  until node -e '
    const socket = require("node:net").connect(Number(process.argv[1]), "127.0.0.1");
    const done = (code) => { socket.destroy(); process.exit(code); };
    socket.once("connect", () => done(0));
    socket.once("error", () => done(1));
    socket.setTimeout(250, () => done(1));
  ' "$port" >/dev/null 2>&1; do
    if ! kill -0 "$process_id" 2>/dev/null; then
      wait "$process_id" || true
      echo "$process_name exited before listening on 127.0.0.1:$port" >&2
      return 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      echo "$process_name did not listen on 127.0.0.1:$port within 10 seconds" >&2
      return 1
    fi
    sleep 0.1
  done
}

if [ "${OPENBROWSE_VNC_BRIDGE_URL:-}" != "" ]; then
  export DISPLAY="${DISPLAY:-:99}"

  if [ ! -d /tmp/.X11-unix ] || [ "$(stat -c %u /tmp/.X11-unix)" != "0" ]; then
    echo "/tmp/.X11-unix must exist and be root-owned; use the supplied Docker Compose configuration" >&2
    exit 1
  fi

  Xvfb "$DISPLAY" -screen 0 1440x960x24 -nolisten tcp &
  xvfb_pid=$!
  wait_for_unix_socket "/tmp/.X11-unix/X${DISPLAY#:}" "$xvfb_pid" "Xvfb"

  x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport 5900 &
  x11vnc_pid=$!
  wait_for_tcp_port 5900 "$x11vnc_pid" "x11vnc"

  websockify 6080 localhost:5900 &
  websockify_pid=$!
  wait_for_tcp_port 6080 "$websockify_pid" "websockify"
fi

exec node dist/index.js
