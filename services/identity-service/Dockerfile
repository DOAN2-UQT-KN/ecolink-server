# Build from the `be` directory so local deps resolve:
#   docker build -f services/identity-service/Dockerfile .

# -------- builder --------
FROM node:22-alpine AS builder

WORKDIR /app/services/identity-service

COPY shared/da2-constants /app/shared/da2-constants
RUN cd /app/shared/da2-constants && npm ci && npm run build && npm cache clean --force

COPY shared/express-swagger /app/shared/express-swagger

COPY services/identity-service/package*.json ./
COPY services/identity-service/tsconfig.json ./
COPY services/identity-service/prisma ./prisma

RUN npm ci && npm cache clean --force

COPY services/identity-service/ .

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
WORKDIR /app/services/identity-service

COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/package*.json ./

# file: deps — include link targets
COPY --from=builder --chown=nodejs:nodejs /app/shared/da2-constants /app/shared/da2-constants
COPY --from=builder --chown=nodejs:nodejs /app/shared/express-swagger /app/shared/express-swagger

COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/tsconfig.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/prisma ./prisma

USER nodejs

EXPOSE 3000

CMD ["npm", "run", "start:production"]
