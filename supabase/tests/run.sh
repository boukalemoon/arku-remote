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
  $P -f "$mig/20261011000100_ensure_connection_id_atomic.sql"
  $P -f "$mig/20261012000100_app_config_min_version.sql"
fi
$P -f "$here/10_denetim_20261007.sql"
bash "$here/20_connection_id_race.sh" "$db"
if [[ "${1:-}" != "--baseline" ]]; then
  $P -f "$here/30_app_config.sql"
  # Tekrar uygulanabilirlik: ikinci uygulama elle yukseltilen degeri ezmemeli.
  $P -f "$mig/20261012000100_app_config_min_version.sql"
  v=$($P -At -c "select value from public.app_config where key='min_desktop_version'")
  [[ "$v" == "1.7.0" ]] || { echo "FAIL AC5: tekrar uygulama degeri ezdi ($v)"; exit 1; }
  echo "PASS AC5 (migration tekrar uygulanabilir, deger korunuyor)"
fi
