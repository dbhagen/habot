ARG BUILD_FROM
FROM node:22-alpine AS builder

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /build

# Cache buster — deploy.sh updates this file to force a clean rebuild
COPY .deploy-timestamp* ./

# Install server dependencies (includes native module compilation)
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm ci

# Install frontend dependencies
COPY frontend/package.json frontend/package-lock.json* frontend/
RUN cd frontend && npm ci

# Build server
COPY server/ server/
RUN cd server && npm run build

# Build frontend
COPY frontend/ frontend/
RUN cd frontend && npm run build

# ------- Runtime -------
# Use node:22-alpine directly to avoid s6-overlay init issues with HA base
FROM node:22-alpine

# python3 needed to parse Supervisor API config response
RUN apk add --no-cache sqlite-libs python3 curl bash
ENV SHELL=/bin/bash

WORKDIR /app

# Copy built server
COPY --from=builder /build/server/dist ./dist
COPY --from=builder /build/server/node_modules ./node_modules
COPY --from=builder /build/server/package.json ./

# Copy built frontend
COPY --from=builder /build/frontend/dist ./public

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
