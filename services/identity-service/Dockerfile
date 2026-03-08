# -------- builder --------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci && npm cache clean --force

COPY . .

RUN npm run build

RUN npm prune --omit=dev


# -------- runtime --------
FROM node:20-alpine

# FIX: cần openssl cho prisma
RUN apk add --no-cache openssl1.1-compat

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

USER nodejs

EXPOSE 8080

CMD ["node", "dist/index.js"]