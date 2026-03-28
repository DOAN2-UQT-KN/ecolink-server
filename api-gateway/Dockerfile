# Build from the `be` directory so local deps resolve:
#   docker build -f api-gateway/Dockerfile .

# Multi-stage build for Node.js/TypeScript API Gateway
FROM node:20-alpine AS builder

WORKDIR /app/api-gateway

COPY api-gateway/package*.json ./
COPY api-gateway/tsconfig.json ./
COPY shared/express-swagger /app/shared/express-swagger

RUN npm ci && \
    npm cache clean --force

COPY api-gateway/ .

RUN npm run build

RUN npm prune --omit=dev

# Production stage
FROM node:20-alpine

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/api-gateway/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/api-gateway/package*.json ./

COPY --from=builder --chown=nodejs:nodejs /app/api-gateway/dist ./dist

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
