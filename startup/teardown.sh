#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# teardown.sh — Stop all User Search containers and optionally remove data
#
# Usage:  ./startup/teardown.sh              (stop containers, keep data)
#         ./startup/teardown.sh --destroy    (stop containers, remove all data)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

# ── Resolve repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Compose fragments ────────────────────────────────────────────────────────
COMPOSE_FILES=(
  docker-compose.postgres.yml
  docker-compose.app.yml
  docker-compose.etl-ad-line.yml
  docker-compose.etl-netforum-line.yml
  docker-compose.etl-eu-line.yml
  docker-compose.etl-dg-line.yml
  docker-compose.etl-m365-line.yml
  docker-compose.etl-sp-line.yml
  docker-compose.genai.yml
)

compose_cmd() {
  local flags=()
  for f in "${COMPOSE_FILES[@]}"; do
    [ -f "$f" ] && flags+=(-f "$f")
  done
  docker compose "${flags[@]}" "$@"
}

DESTROY=false
if [[ "${1:-}" == "--destroy" ]]; then
  DESTROY=true
fi

echo ""
if [ "$DESTROY" = true ]; then
  warn "This will stop ALL containers, remove Docker volumes, AND delete"
  warn "local data directories (data-output/postgres, model cache, etc.)."
else
  info "This will stop all containers but KEEP data intact."
  info "Run with --destroy to also remove volumes and local data."
fi
echo ""

read -rp "Continue? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  info "Aborted."
  exit 0
fi

# ── Stop containers ──────────────────────────────────────────────────────────
info "Stopping all containers..."
if [ "$DESTROY" = true ]; then
  compose_cmd down -v --remove-orphans 2>/dev/null || true
else
  compose_cmd down --remove-orphans 2>/dev/null || true
fi
info "Containers stopped."

# ── Destroy local data (optional) ────────────────────────────────────────────
if [ "$DESTROY" = true ]; then
  info "Removing local data directories..."

  # Postgres data
  if [ -d "data-output/postgres" ]; then
    rm -rf data-output/postgres
    info "  Removed data-output/postgres/"
  fi

  # Model cache
  if [ -d "data-output/model-cache" ]; then
    rm -rf data-output/model-cache
    info "  Removed data-output/model-cache/"
  fi

  # Remove locally-built images
  info "Removing locally-built images..."
  compose_cmd down --rmi local 2>/dev/null || true

  info "All data and images removed."
fi

echo ""
info "Teardown complete."
if [ "$DESTROY" = false ]; then
  echo ""
  echo "  Data preserved in data-output/. Run ./startup/setup.sh to start again."
fi
echo ""
