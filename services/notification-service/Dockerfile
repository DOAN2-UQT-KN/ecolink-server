# Build from the `be` directory:
#   docker build -f services/notification-service/Dockerfile .

FROM node:22-alpine AS builder

WORKDIR /app/services/notification-service

COPY shared/da2-constants /app/shared/da2-constants
RUN cd /app/shared/da2-constants && npm ci && npm run build && npm cache clean --force

COPY shared/da2-queue /app/shared/da2-queue
RUN cd /app/shared/da2-queue && npm ci && npm cache clean --force

COPY shared/express-swagger /app/shared/express-swagger

COPY services/notification-service/package*.json ./
COPY services/notification-service/tsconfig.json ./
COPY services/notification-service/prisma ./prisma

RUN npm ci && npm cache clean --force

COPY services/notification-service/ .

RUN npm run prisma:generate

RUN npm run build

RUN npm prune --omit=dev

FROM node:22-alpine

RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app/services/notification-service

COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/package*.json ./

COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-constants /app/shared/da2-constants
COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-queue /app/shared/da2-queue
COPY --from=builder --chown=nodejs:nodejs /app/shared/express-swagger /app/shared/express-swagger

COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/tsconfig.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/services/notification-service/templates ./templates

USER nodejs

EXPOSE 3003

CMD ["npm", "run", "start:production"]
