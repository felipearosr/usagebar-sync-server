#!/usr/bin/env bash
# Create a Sync Group, push a blob, and read it back with curl.
# Usage: scripts/smoke.sh [base-url]   (default http://127.0.0.1:8787)
# Set ENROLLMENT_TOKEN when the server runs with ENROLLMENT=optional or required.
# Requires: curl, openssl.
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}/v1"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl rand 32 > "$tmp/auth-key"
auth_key=$(b64url < "$tmp/auth-key")
auth_key_hash=$(openssl dgst -sha256 -binary < "$tmp/auth-key" | b64url)
group_id=$(openssl rand 16 | b64url)
machine_id=$(openssl rand 16 | b64url)

echo "== GET /info"
curl -fsS "$BASE/info"; echo

echo "== POST /groups ($group_id)"
enrollment=()
[ -n "${ENROLLMENT_TOKEN:-}" ] && enrollment=(-H "authorization: Enrollment $ENROLLMENT_TOKEN")
curl -fsS -X POST "$BASE/groups" -H 'content-type: application/json' "${enrollment[@]}" \
  -d "{\"groupId\":\"$group_id\",\"authKeyHash\":\"$auth_key_hash\"}"; echo

# Stand-in envelope: version byte 0x01 + random bytes. The server never looks inside.
{ printf '\x01'; openssl rand 64; } > "$tmp/envelope"
blob="$BASE/groups/$group_id/machines/$machine_id/blobs/day-2026-09-23"

echo "== PUT blob"
curl -fsS -X PUT "$blob" -H "authorization: Bearer $auth_key" \
  -H 'content-type: application/octet-stream' --data-binary @"$tmp/envelope"; echo

echo "== GET blob"
curl -fsS "$blob" -H "authorization: Bearer $auth_key" -o "$tmp/readback"
cmp "$tmp/envelope" "$tmp/readback" && echo "blob round-trip OK ($(wc -c < "$tmp/readback") bytes)"

echo "== GET changes"
curl -fsS "$BASE/groups/$group_id/changes" -H "authorization: Bearer $auth_key"; echo

echo "== wrong key must look like an unknown group"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/groups/$group_id/changes" \
  -H "authorization: Bearer $(openssl rand 32 | b64url)")
[ "$status" = 404 ] && echo "wrong key -> 404 OK" || { echo "expected 404, got $status"; exit 1; }

echo "== DELETE group"
curl -fsS -X DELETE "$BASE/groups/$group_id" -H "authorization: Bearer $auth_key"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/groups/$group_id/changes" -H "authorization: Bearer $auth_key")
[ "$status" = 404 ] && echo "deleted group -> 404 OK" || { echo "expected 404, got $status"; exit 1; }
