# Build from the `be` directory so local deps resolve:
#   docker build -f services/incident-service/Dockerfile .

# -------- builder --------
FROM node:22-alpine AS builder

WORKDIR /app/services/incident-service

COPY services/incident-service/package*.json ./
COPY services/incident-service/tsconfig.json ./
COPY services/incident-service/prisma ./prisma
COPY shared/express-swagger /app/shared/express-swagger

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

# file:../../shared/express-swagger is a symlink; include the link target
COPY --from=builder --chown=nodejs:nodejs /app/shared/express-swagger /app/shared/express-swagger

COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/tsconfig.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/services/incident-service/prisma ./prisma

USER nodejs

EXPOSE 3001

CMD ["npm", "run", "start:production"]
