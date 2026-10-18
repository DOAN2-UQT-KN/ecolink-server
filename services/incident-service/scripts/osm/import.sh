#!/usr/bin/env bash
# Weekly OSM context import (specs/012 research R2). Run from the incident-service folder:
#   npm run osm:import                        # download vietnam-latest.osm.pbf, import, swap in
#   OSM_PBF=./hcm.osm.pbf npm run osm:import  # use a local extract (e.g. cut with osmium extract)
# Cron example: 0 3 * * 1  cd <incident-service> && npm run osm:import >> osm-import.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v osm2pgsql >/dev/null 2>&1; then
  echo "[osm] osm2pgsql not found. Install: brew install osm2pgsql osmium-tool  (or apt install osm2pgsql osmium-tool)" >&2
  exit 1
fi
version=$(osm2pgsql --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
if [ "$(printf '%s\n1.8\n' "$version" | sort -V | head -1)" != "1.8" ]; then
  echo "[osm] osm2pgsql >= 1.8 is required (found $version)" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
DB="${DATABASE_URL%%\?*}"   # osm2pgsql/libpq does not accept Prisma's ?schema=

if [ -z "${OSM_PBF:-}" ]; then
  dir="${OSM_PBF_DIR:-./.osm}"
  mkdir -p "$dir"
  OSM_PBF="$dir/vietnam-latest.osm.pbf"
  echo "[osm] downloading Vietnam extract from Geofabrik"
  curl -fL --retry 3 -z "$OSM_PBF" -o "$OSM_PBF" https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
fi
[ -s "$OSM_PBF" ] || { echo "[osm] $OSM_PBF is missing or empty" >&2; exit 1; }

if command -v osmium >/dev/null 2>&1; then
  DATA_AT=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$OSM_PBF" 2>/dev/null || true)
fi
if [ -z "${DATA_AT:-}" ]; then
  DATA_AT=$(date -u -r "$OSM_PBF" +%Y-%m-%dT%H:%M:%SZ)
fi

echo "[osm] importing $OSM_PBF (data at $DATA_AT)"
osm2pgsql --create --slim --drop --middle-schema=osm --output=flex --style scripts/osm/osm-context.lua -d "$DB" "$OSM_PBF"
npx ts-node scripts/osm/finalize.ts "$DATA_AT"
