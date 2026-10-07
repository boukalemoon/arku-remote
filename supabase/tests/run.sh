#!/usr/bin/env bash
# Yerel, ağsız Postgres'te denetim testlerini çalıştırır.
# Kullanım: PGHOST=/tmp PGPORT=5499 PGUSER=postgres ./run.sh [--baseline]
#   --baseline: düzeltme migration'larını UYGULAMADAN çalışır (testlerin
#               hatayı yakaladığını göstermek için; FAIL beklenir).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"
db="${PGDATABASE:-arku_test}"
psql -q -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null
P="psql -q -X -v ON_ERROR_STOP=1 -d $db"
$P -f "$here/00_mock_supabase.sql"
$P -f "$here/01_prefix_functions.sql"
if [[ "${1:-}" != "--baseline" ]]; then
  $P -f "$mig/20261007000100_fix_ensure_connection_id.sql"
  $P -f "$mig/20261007000200_org_takeover_and_seat_limit.sql"
fi
$P -f "$here/10_denetim_20261007.sql"
