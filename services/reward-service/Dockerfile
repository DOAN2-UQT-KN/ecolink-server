# Build from the `be` directory so local deps resolve:
#   docker build -f services/reward-service/Dockerfile .

# -------- builder --------
FROM node:22-alpine AS builder

WORKDIR /app/services/reward-service

COPY shared/da2-constants /app/shared/da2-constants
RUN cd /app/shared/da2-constants && npm ci && npm run build && npm cache clean --force

COPY shared/da2-queue /app/shared/da2-queue
RUN cd /app/shared/da2-queue && npm ci && npm cache clean --force

COPY shared/express-swagger /app/shared/express-swagger

COPY services/reward-service/package*.json ./
COPY services/reward-service/tsconfig.json ./
COPY services/reward-service/prisma ./prisma

RUN npm ci && npm cache clean --force

COPY services/reward-service/ .

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

# Same layout as builder so node_modules/@da2/* symlinks resolve
WORKDIR /app/services/reward-service

COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/package*.json ./

COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-constants /app/shared/da2-constants
COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-queue /app/shared/da2-queue
COPY --from=builder --chown=nodejs:nodejs /app/shared/express-swagger /app/shared/express-swagger

COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/tsconfig.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/services/reward-service/prisma ./prisma

USER nodejs

EXPOSE 3002

CMD ["npm", "run", "start:production"]

