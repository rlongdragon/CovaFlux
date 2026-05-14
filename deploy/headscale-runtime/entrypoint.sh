#!/bin/sh
set -eu

token_file=/secrets/headscale_api_key
expiration=${HEADSCALE_API_KEY_EXPIRATION:-365d}

headscale serve &
headscale_pid=$!

shutdown() {
  kill "$headscale_pid" 2>/dev/null || true
  wait "$headscale_pid" 2>/dev/null || true
}
trap shutdown INT TERM

for _ in $(seq 1 60); do
  if headscale health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [ ! -s "$token_file" ]; then
  headscale apikeys create --expiration "$expiration" > "$token_file"
  chmod 600 "$token_file"
fi

wait "$headscale_pid"
