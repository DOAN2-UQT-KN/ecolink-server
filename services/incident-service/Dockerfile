# Build from the `be` directory so local deps resolve:
#   docker build -f services/incident-service/Dockerfile .

# -------- builder --------
FROM node:22-alpine AS builder

WORKDIR /app/services/incident-service

COPY shared/da2-constants /app/shared/da2-constants
RUN cd /app/shared/da2-constants && npm ci && npm run build && npm cache clean --force

COPY shared/da2-queue /app/shared/da2-queue
RUN cd /app/shared/da2-queue && npm ci && npm cache clean --force

COPY shared/express-swagger /app/shared/express-swagger

COPY services/incident-service/package*.json ./
COPY services/incident-service/tsconfig.json ./
COPY services/incident-service/prisma ./prisma

RUN npm ci && npm cache clean --force

COPY services/incident-service/ .

# Generate Prisma client before build
RUN npm run prisma:generate

RUN npm run build

RUN npm prune --omit=dev


# -------- runtime --------
FROM node:22-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Same layout as builder so node_modules/@da2/express-swagger symlink resolves
WORKDIR /app/services/incident-service

COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/package*.json ./

COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-constants /app/shared/da2-constants
COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-queue /app/shared/da2-queue
COPY --from=builder --chown=nodejs:nodejs /app/shared/express-swagger /app/shared/express-swagger

COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/tsconfig.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/prisma ./prisma

USER nodejs

EXPOSE 3001

CMD ["npm", "run", "start:production"]
