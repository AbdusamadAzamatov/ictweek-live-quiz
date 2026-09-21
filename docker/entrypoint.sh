#!/bin/sh
# ICTWEEK app entrypoint: apply migrations, then start the server.
set -e
cd /app/apps/server
./node_modules/.bin/prisma migrate deploy
exec node dist/index.js
