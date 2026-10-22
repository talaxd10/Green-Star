#!/usr/bin/env bash
# Starts Green Star on its host (the Dockerfile's command).
#
# 1. Brings the database up to date, as the login that owns it (DATABASE_URL).
# 2. Makes sure the app's own login exists (gs_app, password APP_DB_PASSWORD).
#    It can add to the ledger and never change it.
# 3. On an empty database, makes the CEO's account from CEO_NAME, CEO_PHONE
#    and CEO_PASSWORD. Once there is an account they are not read again.
# 4. Runs the API and the worker next to the office app. Only the office app
#    faces the internet, on $PORT; it passes /v1 on to the API.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL is not set: the database owner login}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is not set}"

echo "Bringing the database up to date"
node packages/db/scripts/migrate.ts

psql -X -q -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" "$DATABASE_URL" <<'SQL'
select format('create role gs_app login password %L', :'pw')
 where not exists (select from pg_roles where rolname = 'gs_app') \gexec
select format('alter role gs_app login password %L', :'pw') \gexec
grant green_star_app to gs_app;
select format('grant connect on database %I to gs_app', current_database()) \gexec
SQL

APP_DATABASE_URL="$(node -e '
  const url = new URL(process.env.DATABASE_URL);
  url.username = "gs_app";
  url.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  process.stdout.write(url.href);
')"
export APP_DATABASE_URL

users="$(psql -X -A -t -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'select count(*) from users')"
if [ "$users" = "0" ]; then
  if [ -n "${CEO_PHONE:-}" ] && [ -n "${CEO_PASSWORD:-}" ]; then
    GS_PASSWORD="$CEO_PASSWORD" node apps/api/scripts/create-ceo.ts --name "${CEO_NAME:-CEO}" --phone "$CEO_PHONE"
  else
    echo "There is no account yet. Set CEO_PHONE and CEO_PASSWORD, then restart." >&2
  fi
fi

export NODE_ENV=production
WEB_PORT="${PORT:-3000}"
ORIGIN="${WEB_ORIGINS:-${RENDER_EXTERNAL_URL:-http://localhost:$WEB_PORT}}"

trap 'kill 0' TERM INT

PORT=4000 HOST=127.0.0.1 WEB_ORIGINS="$ORIGIN" TRUST_PROXY=true node apps/api/src/main.ts &
node apps/worker/src/main.ts &
(cd apps/web && exec node_modules/.bin/next start -H 0.0.0.0 -p "$WEB_PORT") &

# If any of the three stops, stop the rest: the host starts it all again.
wait -n
echo "A process stopped; stopping the others so the host restarts them." >&2
kill 0
