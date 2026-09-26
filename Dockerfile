# LANShare — signaling server
#
# Only negotiates the WebRTC handshake (SDP + ICE). File bytes never reach this
# process: they travel directly between browsers over an encrypted DataChannel.

FROM node:20-alpine AS build
WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Runs unprivileged. `node` is provided by the base image.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
