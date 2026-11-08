#!/bin/sh
# Creates `.env` for a new client install from `.env.example`, with random secrets.
# Usage (in the deploy folder):  ./bootstrap.sh
# Then review the non secret values in .env and run: docker compose --env-file .env up -d
set -eu

cd "$(dirname "$0")"

if [ -e .env ]; then
  echo "bootstrap: .env already exists; refusing to overwrite it." >&2
  exit 1
fi

secret() {
  # 32 random bytes, hex encoded (safe inside URLs and env files).
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

umask 077
POSTGRES_PASSWORD="$(secret)"
BETTER_AUTH_SECRET="$(secret)"
APP_DB_PASSWORD="$(secret)"
CONNECTOR_SECRET_KEY="$(secret)"
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=${APP_DB_PASSWORD}|"   -e "s|^CONNECTOR_SECRET_KEY=.*|CONNECTOR_SECRET_KEY=${CONNECTOR_SECRET_KEY}|" \
  .env.example > .env
chmod 600 .env

echo "bootstrap: wrote .env with fresh secrets. Set CLIENT_ID, SSD_VERSION, SITE_ADDRESS and PUBLIC_URL next."
echo "bootstrap: then start the install:  docker compose --env-file .env up -d"
echo "bootstrap: next step, create the first admin (prints a temporary password once):"
echo "  docker compose --env-file .env run --rm api node dist/create-admin.js --email <email> --name <name>"
echo "bootstrap: do not capture or log that output. First check \`docker info --format '{{.LoggingDriver}}'\` prints json-file or local; change the password at first sign in."
