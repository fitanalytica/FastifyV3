#!/bin/sh
# Rebuilds a LOCAL database from scratch. Never point this at anything but localhost.
# Usage: sh reset.sh                              the development database, fitanalytica_dev (your imported data is lost)
#        DB=fitanalytica_test sh reset.sh         the database the tests run in (the tests never touch fitanalytica_dev)
# (needs the Homebrew Postgres 18 tools on the PATH)
set -e
cd "$(dirname "$0")"
PSQL=${PSQL:-/opt/homebrew/opt/postgresql@18/bin/psql}
DB=${DB:-fitanalytica_dev}
$PSQL -d postgres -qc "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
for f in 01-roles.sql 02-postgis-standin.sql 03-schema-current.sql 04-migration-v3.sql 05-feed-v3.sql 06-posts-v3.sql 07-account-deletion-v3.sql 08-billing-standin.sql; do
  echo "== $f"; $PSQL -d $DB -q -v ON_ERROR_STOP=1 -f $f
done
echo "ready: $DB"
