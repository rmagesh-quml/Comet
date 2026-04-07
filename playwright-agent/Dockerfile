# ── Stage: deps ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage: runtime ────────────────────────────────────────────────────────────
FROM node:20-alpine

# Playwright's bundled Chromium requires glibc, which Alpine (musl) lacks.
# We install the system Chromium from Alpine's package registry instead,
# which is musl-compatible, then point Playwright at it.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    # Needed for headless stability in containers
    udev \
    # Runtime deps sometimes required
    libstdc++

# Tell Playwright to skip its own download and use the system browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Non-root user for security
RUN addgroup -S playwright && adduser -S playwright -G playwright
USER playwright

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "index.js"]
