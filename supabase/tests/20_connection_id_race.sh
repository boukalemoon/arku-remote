#!/usr/bin/env bash
# arku_ensure_connection_id eşzamanlılık testi (2026-10-11).
# Aynı hesap için iki oturum aynı anda kimlik ister. Beklenen: ikisi de AYNI
# numarayı alır ve veritabanında da o numara durur.
# Kullanım: 20_connection_id_race.sh <db>
set -euo pipefail
db="$1"
P="psql -q -X -tA -v ON_ERROR_STOP=1 -d $db"
fail=0

race() {  # $1 = senaryo adı, $2 = satır önceden var mı (yes/no)
  local uid; uid=$($P -c "select gen_random_uuid()")
  $P -c "insert into auth.users(id,email) values ('$uid','race@example.com')"
  if [[ "$2" == yes ]]; then
    $P -c "insert into public.users(id,email) values ('$uid','race@example.com')"
  fi
  local a b
  a=$(mktemp); b=$(mktemp)
  # A: kimliği alır ama işlemi 1.5 sn açık tutar.
  $P -c "begin; select set_config('request.jwt.claim.sub','$uid',true); select public.arku_ensure_connection_id(); select pg_sleep(1.5); commit;" \
    | grep -E '^[0-9]{3}-' > "$a" &
  local pa=$!
  sleep 0.4
  # B: A bitmeden aynı hesap için ister.
  $P -c "begin; select set_config('request.jwt.claim.sub','$uid',true); select public.arku_ensure_connection_id(); commit;" \
    | grep -E '^[0-9]{3}-' > "$b"
  wait $pa
  local ida idb stored
  ida=$(cat "$a"); idb=$(cat "$b"); rm -f "$a" "$b"
  stored=$($P -c "select connection_id from public.users where id='$uid'")
  if [[ -n "$ida" && "$ida" == "$idb" && "$ida" == "$stored" ]]; then
    echo "PASS yaris ($1): iki oturum da $ida aldi"
  else
    echo "FAIL yaris ($1): A=$ida B=$idb veritabani=$stored"
    fail=1
  fi
}

race "yeni hesap" no
race "satir var, kimlik bos" yes

# Atanmış kimlik ikinci çağrıda değişmez.
uid=$($P -c "select gen_random_uuid()")
$P -c "insert into auth.users(id,email) values ('$uid','x@example.com')"
first=$($P -c "select set_config('request.jwt.claim.sub','$uid',false); select public.arku_ensure_connection_id();" | tail -1)
second=$($P -c "select set_config('request.jwt.claim.sub','$uid',false); select public.arku_ensure_connection_id();" | tail -1)
if [[ "$first" == "$second" ]]; then echo "PASS kimlik kalici: $first"; else echo "FAIL kimlik degisti: $first -> $second"; fail=1; fi

exit $fail
