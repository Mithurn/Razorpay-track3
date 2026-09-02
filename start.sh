#!/usr/bin/env bash
# Recovery Room — one command to bring the whole thing up.
#   ./start.sh          infra + schema + seed the room + run API and web
#   ./start.sh --bare   just API + web (keep whatever is already in the DB)
set -euo pipefail
cd "$(dirname "$0")"

BARE=${1:-}

[ -d node_modules ] || { echo "→ installing dependencies"; npm install --silent; }

echo "→ bringing up Postgres and Redis"
docker compose up -d >/dev/null
for _ in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U recovery -d recovery >/dev/null 2>&1 && break
  sleep 1
done

echo "→ applying the schema (idempotent)"
npm run --silent db:schema >/dev/null

if [ "$BARE" != "--bare" ]; then
  echo "→ seeding the Recovery Room from the recorded run (free, no model calls)"
  npm run --silent seed:room
fi

echo
echo "→ API on :3000, web on :5173  —  open http://localhost:5173  ·  Ctrl-C to stop"
echo
exec npm run dev
