# FlowFrame in a container.
#
# It is a desktop app, so this image carries a desktop with it: a virtual
# display, a window manager and a VNC server published over HTTP. You open the
# app in a browser at http://localhost:6080/ — which is what makes this work
# from a Windows or macOS host, where an X11 socket cannot simply be shared.
#
#   docker compose up --build      then open http://localhost:6080/
#
# Nothing leaves the container: the same offline app, with its project files on
# a volume instead of in your Documents folder.

# ----------------------------------------------------------------- build
FROM node:22-bookworm AS build
WORKDIR /app

# Dependencies first, so a source edit does not re-download Electron.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json electron.vite.config.ts ./
COPY src ./src
COPY resources ./resources
RUN npm run build

# ------------------------------------------------------------------- run
FROM node:22-bookworm-slim AS run

# Chromium's runtime libraries, plus the desktop the app needs to draw on.
# `--no-install-recommends` keeps the image from pulling a full X session.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 \
      libdrm2 libgbm1 libasound2 libcups2 libxkbcommon0 libpango-1.0-0 \
      libcairo2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      ca-certificates fonts-liberation dbus-x11 \
      xvfb x11-utils x11vnc fluxbox novnc websockify \
    && rm -rf /var/lib/apt/lists/*

# noVNC ships its client as vnc.html; the symlink is what lets the published
# port be opened as a plain URL with nothing after it.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

WORKDIR /app
# --chown on the copy itself, rather than a chown afterwards: node_modules holds
# Electron, and rewriting its permissions in a later layer would store the whole
# thing twice.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/out ./out
COPY --from=build --chown=node:node /app/resources ./resources
COPY --chown=node:node package.json ./
COPY docker/entrypoint.sh /usr/local/bin/flowframe-entrypoint
RUN chmod +x /usr/local/bin/flowframe-entrypoint

# Projects live on a volume rather than in Documents, which does not exist here.
ENV FLOWFRAME_DATA_DIR=/data
RUN mkdir -p /data /screenshots && chown node:node /data /screenshots

# Chromium is happier not being root, and so is anything that writes to /data.
USER node

EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/flowframe-entrypoint"]
