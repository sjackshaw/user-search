#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# setup.sh — Bootstrap the full User Search proof-of-concept stack
#
# Usage:  ./startup/setup.sh          (from repo root)
#         cd startup && ./setup.sh    (from startup dir)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "\n${CYAN}── Step $1 ──${NC}"; }

# ── Resolve repo root (works from any directory) ─────────────────────────────
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
  docker-compose.etl-claims-line.yml
  docker-compose.genai.yml
  docker-compose.member-benefits-app.yml
)

compose_cmd() {
  local flags=()
  for f in "${COMPOSE_FILES[@]}"; do
    flags+=(-f "$f")
  done
  docker compose "${flags[@]}" "$@"
}

# ── Pre-flight checks ────────────────────────────────────────────────────────
step "0/6 — Pre-flight checks"

command -v docker >/dev/null 2>&1 || error "Docker is not installed. Please install Docker Desktop first."
docker compose version >/dev/null 2>&1 || error "Docker Compose v2 is not available. Please update Docker Desktop."
docker info >/dev/null 2>&1 || error "Docker daemon is not running. Please start Docker Desktop."

info "Docker $(docker --version | awk '{print $3}') — Compose $(docker compose version --short)"

# Verify all compose fragments exist
for f in "${COMPOSE_FILES[@]}"; do
  [ -f "$f" ] || error "Missing compose file: $f"
done
info "All ${#COMPOSE_FILES[@]} compose fragments found."

# ── Check for .env file ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  warn "No .env file found — creating one with development defaults..."
  cat > .env <<'EOF'
# ── Postgres ──────────────────────────────────────
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=appdb
PGHOST=postgres
PGPORT=5432
PGDATABASE=appdb
PGUSER=postgres
PGPASSWORD=postgres

# ── ETL ───────────────────────────────────────────
CRON_SCHEDULE=0 * * * *
BATCH_SIZE=64

# ── App ───────────────────────────────────────────
API_KEY=dev-key-please-change
EOF
  info "Created .env with development defaults."
fi

# ── Step 1: Clean slate check ─────────────────────────────────────────────────
step "1/6 — Checking Postgres data directory"

PG_DATA_DIR="data-output/postgres"
if [ -d "$PG_DATA_DIR" ] && [ "$(ls -A "$PG_DATA_DIR" 2>/dev/null)" ]; then
  warn "Postgres data directory ($PG_DATA_DIR) already contains data."
  warn "Init scripts (infra/db/init/) only run on FIRST initialisation."
  echo ""
  read -rp "  Remove existing data and start fresh? (y/N): " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    info "Removing existing Postgres data..."
    rm -rf "$PG_DATA_DIR"
    mkdir -p "$PG_DATA_DIR"
    info "Data directory cleaned."
  else
    info "Keeping existing data — init scripts will be skipped by Postgres."
  fi
fi

# ── Step 2: Build all images ─────────────────────────────────────────────────
step "2/6 — Building all Docker images"

compose_cmd build --parallel
info "All images built."

# ── Step 3: Start Postgres and wait for healthy ──────────────────────────────
step "3/6 — Starting Postgres"

compose_cmd up -d postgres
info "Waiting for Postgres to accept connections..."

RETRIES=30
until compose_cmd exec -T postgres pg_isready -U postgres -q 2>/dev/null; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo ""
    error "Postgres did not become ready in time. Check logs with:\n  docker compose -f docker-compose.postgres.yml logs postgres"
  fi
  printf "."
  sleep 2
done
echo ""
info "Postgres is ready (port 5433 on host, 5432 inside Docker network)."

# ── Step 4: Verify schema was created ─────────────────────────────────────────
step "4/6 — Verifying database schema"

TABLE_COUNT=$(compose_cmd exec -T postgres psql -U postgres -d appdb -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null || echo "0")

if [ "$TABLE_COUNT" -gt 0 ]; then
  info "Database has $TABLE_COUNT table(s) in public schema."
else
  warn "No tables found — init scripts may not have run. Applying manually..."
  INIT_DIR="infra/db/init"
  for sql_file in $(find "$INIT_DIR" -name '*.sql' -type f | sort); do
    filename=$(basename "$sql_file")
    info "  Applying: $filename"
    compose_cmd exec -T postgres psql -U postgres -d appdb < "$sql_file" >/dev/null 2>&1
  done
  info "All init scripts applied."
fi

# ── Step 5: Start all remaining services ──────────────────────────────────────
step "5/6 — Starting all services"

compose_cmd up -d
info "All containers started."

# ── Step 6: Pull Ollama model (first run) ─────────────────────────────────────
step "6/6 — Checking Ollama model"

info "Waiting for Ollama to be ready..."
RETRIES=20
OLLAMA_READY=false
until [ "$RETRIES" -le 0 ]; do
  if compose_cmd exec -T ollama ollama list >/dev/null 2>&1; then
    OLLAMA_READY=true
    break
  fi
  RETRIES=$((RETRIES - 1))
  printf "."
  sleep 3
done
echo ""

if [ "$OLLAMA_READY" = true ]; then
  MODEL_EXISTS=$(compose_cmd exec -T ollama ollama list 2>/dev/null | grep -c "qwen2.5:3b" || true)
  if [ "$MODEL_EXISTS" -eq 0 ]; then
    info "Pulling qwen2.5:3b model (this may take a few minutes on first run)..."
    compose_cmd exec -T ollama ollama pull qwen2.5:3b
    info "Model downloaded."
  else
    info "Ollama model qwen2.5:3b already available."
  fi
else
  warn "Ollama did not become ready in time. You can pull the model manually later:"
  warn "  docker exec user-search-ollama-1 ollama pull qwen2.5:3b"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Application:   http://localhost:3000"
echo "  GenAI service:  http://localhost:3001"
echo "  Postgres:       localhost:5433  (user: postgres / db: appdb)"
echo ""
echo "  Useful commands:"
echo "    View all logs:           docker compose -f docker-compose.postgres.yml -f docker-compose.app.yml logs -f"
echo "    View ETL logs:           docker compose -f docker-compose.etl-ad-line.yml logs -f"
echo "    Connect to Postgres:     docker compose -f docker-compose.postgres.yml exec postgres psql -U postgres -d appdb"
echo "    Seed change history:     python3 seed_change_logs.py && docker exec -i user-search-postgres-1 psql -U postgres -d appdb < seed_change_logs.sql"
echo "    Teardown (keep data):    ./startup/teardown.sh"
echo "    Teardown (destroy data): ./startup/teardown.sh --destroy"
echo ""

# Show running services
compose_cmd ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || compose_cmd ps
