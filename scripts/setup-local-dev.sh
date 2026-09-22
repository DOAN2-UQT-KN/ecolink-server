#!/bin/bash
# Setup script for local development - databases and dependencies only
# Usage: ./scripts/setup-local-dev.sh

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICES_DIR="$PROJECT_ROOT/services"

echo "🚀 Setting up DA2 local development environment..."
echo "📁 Project root: $PROJECT_ROOT"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Start PostgreSQL (PostGIS) + localstack via docker compose
echo "📦 Starting PostgreSQL (PostGIS) on port 5433..."
cd "$PROJECT_ROOT"
docker compose up -d postgres localstack

echo ""
echo "⏳ Waiting for the database to be ready..."
for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
        echo "  ✅ postgres is ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  ❌ postgres did not become ready in time"
        docker compose logs --tail 30 postgres
        exit 1
    fi
    sleep 2
done

# Discover all services
echo ""
echo "🔍 Discovering services..."
SERVICES=()
# Check services directory
for service_dir in "$SERVICES_DIR"/*; do
    if [ -d "$service_dir" ] && [ -f "$service_dir/package.json" ]; then
        service_name=$(basename "$service_dir")
        SERVICES+=("services/$service_name")
        echo "  ✅ Found: services/$service_name"
    fi
done
# Check api-gateway directory
if [ -d "$PROJECT_ROOT/api-gateway" ] && [ -f "$PROJECT_ROOT/api-gateway/package.json" ]; then
    SERVICES+=("api-gateway")
    echo "  ✅ Found: api-gateway"
fi

if [ ${#SERVICES[@]} -eq 0 ]; then
    echo "  ❌ No services found in $SERVICES_DIR"
    exit 1
fi

# Check .env files exist for all services
echo ""
echo "📝 Checking .env files..."

MISSING_ENV=()
for service in "${SERVICES[@]}"; do
    SERVICE_DIR="$PROJECT_ROOT/$service"
    
    if [ ! -f "$SERVICE_DIR/.env" ]; then
        MISSING_ENV+=("$service")
        echo "  ❌ Missing: $service/.env"
    else
        echo "  ✅ Found: $service/.env"
    fi
done

if [ ${#MISSING_ENV[@]} -gt 0 ]; then
    echo ""
    echo "❌ Error: Missing .env files for ${#MISSING_ENV[@]} service(s)"
    echo ""
    echo "Please create .env files for:"
    for service in "${MISSING_ENV[@]}"; do
        echo "  - $PROJECT_ROOT/$service/.env"
    done
    echo ""
    echo "💡 Tip: Copy from .env.example if available"
    exit 1
fi

# Install dependencies for all services
echo ""
echo "📦 Installing dependencies..."

for service in "${SERVICES[@]}"; do
    SERVICE_DIR="$PROJECT_ROOT/$service"
    cd "$SERVICE_DIR"
    
    if [ ! -d "node_modules" ]; then
        echo "  📥 Installing $service..."
        npm install
    else
        echo "  ⏭️  $service dependencies already installed"
    fi
done

# Run migrations for services with Prisma
echo ""
echo "🔄 Running database migrations..."

for service in "${SERVICES[@]}"; do
    SERVICE_DIR="$PROJECT_ROOT/$service"
    
    if [ -f "$SERVICE_DIR/prisma/schema.prisma" ]; then
        echo "  📊 Migrating $service..."
        cd "$SERVICE_DIR"
        npx prisma migrate dev --name init 2>/dev/null || npx prisma migrate deploy
    fi
done

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Database info (Shared Instance):"
echo "   Identity DB:  postgresql://postgres:password@localhost:5433/identitydb"
echo "   (same instance also hosts incidentdb / notificationdb / rewarddb / aidb)"
echo ""
echo "🚀 To start services manually:"
for service in "${SERVICES[@]}"; do
    echo "   cd $PROJECT_ROOT/$service && npm run dev"
done
echo ""
echo "🛑 To stop databases:"
echo "   docker compose stop postgres localstack"
