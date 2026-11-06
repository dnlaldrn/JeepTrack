#!/usr/bin/env bash
# Dev CA + server cert for Mosquitto. Usage: bash infra/gen-certs.sh  (reads LAN_IP from .env)
set -euo pipefail
cd "$(dirname "$0")"
LAN_IP="${LAN_IP:-$(grep -E '^LAN_IP=' ../.env 2>/dev/null | cut -d= -f2)}"
: "${LAN_IP:?set LAN_IP in .env}"
mkdir -p certs && cd certs
export MSYS_NO_PATHCONV=1 # keep "/CN=..." intact on Git Bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout ca.key -out ca.crt -subj "/CN=JeepTrack Dev CA"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:%s\n" "$LAN_IP" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -out server.crt -extfile san.ext
rm -f server.csr san.ext
chmod 644 server.key # mosquitto runs as uid 1883 in the container; dev only
echo "certs written to infra/certs (SAN includes $LAN_IP)"
