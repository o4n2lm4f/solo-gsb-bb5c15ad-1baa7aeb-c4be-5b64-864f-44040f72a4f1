# syntax=docker/dockerfile:1

# ---- production image ----------------------------------------------------
FROM node:20-alpine

# Run as the built-in non-root user; app files are world-readable.
ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source.
COPY src ./src

USER node

# Configuration (overridable at runtime).
ENV HOST=0.0.0.0
ENV PORT=3000
ENV MAX_RANGES=16
ENV MAX_BYTES_MULTIPLIER=2

EXPOSE 3000

# Lightweight container health check against the liveness route.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
