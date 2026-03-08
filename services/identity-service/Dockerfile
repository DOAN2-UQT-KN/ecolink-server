# Multi-stage build for Node.js/TypeScript service
# Build context should be /home/triuq/projects/DA2/be
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY services/identity-service/package*.json ./
COPY services/identity-service/tsconfig.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci && \
    npm cache clean --force

# Copy source code and prisma schema
COPY services/identity-service ./

# Environment file handling
ARG APP_ENV=development
RUN if [ "$APP_ENV" = "production" ] && [ -f ".env.production" ]; then \
        cp .env.production .env; \
    fi

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Remove devDependencies for runtime image
RUN npm prune --omit=dev

# Production stage
FROM node:20-alpine

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies and built files from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# Copy Prisma schema
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/index.js"]
