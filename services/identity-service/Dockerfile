# Build from the `be` directory so local deps resolve:
#   docker build -f services/identity-service/Dockerfile .

# -------- builder --------
FROM node:18.19.1-alpine AS builder

WORKDIR /app/services/identity-service

COPY services/identity-service/package*.json ./
COPY services/identity-service/tsconfig.json ./
COPY services/identity-service/prisma ./prisma
COPY shared/express-swagger /app/shared/express-swagger

RUN npm ci && npm cache clean --force

COPY services/identity-service/ .

# Generate Prisma client before build
RUN npm run prisma:generate

RUN npm run build

RUN npm prune --omit=dev


# -------- runtime --------
FROM node:20-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/services/identity-service/prisma ./prisma

USER nodejs

EXPOSE 8080

CMD ["npm", "run", "start:production"]
