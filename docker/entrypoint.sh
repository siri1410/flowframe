#!/bin/sh
# FlowFrame is a desktop app, so the container has to provide a desktop: a
# virtual display for it to draw on, a window manager so the window is sized and
# movable, and a VNC server published over the web so any host — Windows and
# macOS included, where an X11 socket cannot be shared — can open it in a
# browser.
set -e

: "${DISPLAY:=:99}"
: "${FLOWFRAME_SCREEN:=1600x1000x24}"
: "${FLOWFRAME_WEB_PORT:=6080}"
export DISPLAY

Xvfb "$DISPLAY" -screen 0 "$FLOWFRAME_SCREEN" -nolisten tcp &

# Wait for the display rather than racing it; Electron exits immediately if it
# starts before X is accepting connections.
i=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "The virtual display never came up." >&2; exit 1; }
  sleep 0.1
done

fluxbox >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -rfbport 5900 >/dev/null 2>&1 &
websockify --web=/usr/share/novnc "$FLOWFRAME_WEB_PORT" localhost:5900 >/dev/null 2>&1 &

echo "FlowFrame is at http://localhost:${FLOWFRAME_WEB_PORT}/"

# --no-sandbox is a container requirement, not a relaxation of the app: the
# renderer keeps contextIsolation and its CSP either way. Chromium's own
# sandbox needs user namespaces the container does not have.
# The real binary, not the npm wrapper: `exec`ing the wrapper would leave a
# node process between Docker and Electron, and stopping the container would
# have to wait for a timeout instead of a signal.
ELECTRON=$(node -p "require('electron')")

exec "$ELECTRON" out/main/index.js \
  --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"
