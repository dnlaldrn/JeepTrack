#!/usr/bin/env bash
# Stage 0 acceptance checks. Requires: docker compose up -d, bootstrap-broker.js run.
set -uo pipefail
cd "$(dirname "$0")"
set -a; . ../.env; set +a
export MSYS_NO_PATHCONV=1
dc() { docker compose -f docker-compose.yml --env-file ../.env "$@"; }
pass=0; fail=0
check() { if [ "$1" = ok ]; then echo "PASS $2"; pass=$((pass+1)); else echo "FAIL $2"; fail=$((fail+1)); fi; }

dc exec -T mosquitto mosquitto_pub --cafile /mosquitto/certs/ca.crt -h localhost -p 8883 \
  -u "$MQTT_SERVER_USER" -P "$MQTT_SERVER_PASS" -t smoke -m x -q 1 >/dev/null 2>&1 \
  && check ok "TLS publish with valid user" || check no "TLS publish with valid user"

dc exec -T mosquitto mosquitto_pub --cafile /mosquitto/certs/ca.crt -h localhost -p 8883 \
  -u "$MQTT_SERVER_USER" -P wrong-password -t smoke -m x -q 1 >/dev/null 2>&1 \
  && check no "TLS publish with wrong password is refused" || check ok "TLS publish with wrong password is refused"

v=$(dc exec -T db psql -U jeeptrack -d jeeptrack -tAc 'SELECT PostGIS_Version();' 2>/dev/null)
[ -n "$v" ] && check ok "PostGIS_Version() = $v" || check no "PostGIS_Version()"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
