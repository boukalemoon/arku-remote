#!/usr/bin/env bash
# turnserver.conf regresyon testi (denetim 2026-10-07, O8).
#
# Depodaki turnserver.conf'u yalnızca 127.0.0.1'de dinleyen geçici bir coturn
# ile çalıştırır ve turnutils_uclient ile hangi eş adreslerine relay izni
# verildiğini dener. Dış ağa paket GÖNDERİLMEZ: istemci `-n 0` ile çalışır,
# yani eş adresine yalnızca izin (ChannelBind) istenir ve hiç veri relay
# edilmez; karar coturn içinde verilir. (Çıktıdaki tot_send_msgs=0 bunu
# doğrular.)
#
# Gereken: coturn paketi (turnserver, turnutils_uclient).
# Kullanım: bash tests/turn/peer_deny_test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
conf_src="$here/../../turnserver.conf"
work="$(mktemp -d)"
trap 'kill "${pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
port=34780

# Üretim dosyasını yerel teste uyarlar: yalnızca loopback, TLS yok, test sırrı.
tr -d '\r' < "$conf_src" | sed \
  -e 's/^external-ip=.*/external-ip=127.0.0.1/' \
  -e 's/^listening-ip=.*/listening-ip=127.0.0.1/' \
  -e "s/^listening-port=.*/listening-port=$port/" \
  -e 's/^tls-listening-port=.*/no-tls\nno-dtls/' \
  -e '/^cert=/d' -e '/^pkey=/d' \
  -e 's/^static-auth-secret=.*/static-auth-secret=testsecret/' \
  > "$work/t.conf"

turnserver -c "$work/t.conf" > "$work/server.log" 2>&1 &
pid=$!
sleep 2

if grep -qi 'Bad configuration format' "$work/server.log"; then
  echo "FAIL: coturn yapilandirmayi tanimiyor:"; grep -i 'Bad configuration format' "$work/server.log"
  exit 1
fi

fail=0
n=0
check() { # $1 = eş IP, $2 = beklenen (izin|red)
  local out got
  n=$((n + 1))
  # Her denemede ayrı kullanıcı adı: user-quota ayrı sayılsın.
  out=$(timeout 10 turnutils_uclient -p "$port" -W testsecret -u "denetim$n" \
          -e "$1" -r 9 -n 0 -m 1 -l 100 -c 127.0.0.1 2>&1 || true)
  if grep -qi 'Forbidden IP' <<<"$out"; then got=red
  elif grep -qiE 'error [0-9]+' <<<"$out"; then got="hata: $(grep -oiE 'error [0-9]+ \([^)]*\)' <<<"$out" | head -1)"
  elif grep -q 'tot_send_msgs=0' <<<"$out"; then got=izin
  else got="belirsiz"; fi
  if [[ "$got" == "$2" ]]; then echo "PASS $1 -> $got"; else echo "FAIL $1 -> $got (beklenen $2)"; fail=1; fi
}

# Genel adresler relay alabilmeli (eski `denied-peer-ip=::` hepsini engelliyordu).
check 8.8.8.8 izin
check 1.1.1.1 izin
# Özel ve ayrılmış aralıklar reddedilmeli.
check 10.0.0.1 red
check 172.16.0.1 red
check 192.168.1.1 red
check 127.0.0.1 red
check 169.254.169.254 red
check 100.64.0.1 red
check 198.18.0.1 red

exit $fail
