#!/bin/sh
set -eu

token_file=/secrets/headscale_api_key
key_id_file=/secrets/headscale_api_key.id
ready_file=/tmp/headscale-ready
expiration=${HEADSCALE_API_KEY_EXPIRATION:-90d}
rotate_after_days=${HEADSCALE_API_KEY_ROTATE_AFTER_DAYS:-60}
rotate_check_seconds=${HEADSCALE_API_KEY_ROTATE_CHECK_SECONDS:-43200}
# Grace period so CovaFlux (which re-reads the key file on change) has
# switched to the new key before the old one is expired.
rotate_grace_seconds=${HEADSCALE_API_KEY_ROTATE_GRACE_SECONDS:-120}

# Fix ownership of volumes created by older (root) images, then drop to the
# unprivileged headscale user. Root has only CHOWN/SETUID/SETGID here (no
# DAC_READ_SEARCH, no FOWNER), so it must chmod while it still owns a path and
# only recurse into paths it still owns.
if [ "$(id -u)" = "0" ]; then
  for dir in /var/lib/headscale /var/run/headscale; do
    [ "$(stat -c %u "$dir")" = "10000" ] || chown -R headscale:headscale "$dir"
  done
  if [ "$(stat -c %u /secrets)" != "10000" ]; then
    for file in "$token_file" "$key_id_file"; do
      if [ -e "$file" ] && [ "$(stat -c %u "$file")" != "10000" ]; then
        chmod 0440 "$file"
        chown headscale:secrets "$file"
      fi
    done
    # setgid: files created here belong to the secrets group CovaFlux reads with
    chmod 2750 /secrets
    chown headscale:secrets /secrets
  fi
  exec su-exec headscale "$0" "$@"
fi

# Secrets are created owner/group-only from the first byte (no chmod race).
umask 027

# Id of the Headscale API key stored in $1. `apikeys list` shows each key's
# public prefix as "<prefix>-***"; the stored key starts with "<prefix>-".
key_id_for_file() {
  key=$(cat "$1") || return 1
  headscale apikeys list -o json \
    | jq -r --arg key "$key" '.[]? | select(.prefix as $p | $key | startswith($p | rtrimstr("***"))) | .id' \
    | head -n 1
}

write_secret() {
  chgrp secrets "$1" && chmod 0440 "$1"
}

# Create a key and publish it (and its id) atomically. Any failure leaves the
# current key and id untouched.
create_key() {
  tmp="$token_file.tmp.$$"
  id_tmp="$key_id_file.tmp.$$"
  rm -f "$tmp" "$id_tmp"
  if ! headscale apikeys create --expiration "$expiration" > "$tmp" || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    return 1
  fi
  new_id=$(key_id_for_file "$tmp") || new_id=""
  if [ -z "$new_id" ]; then
    rm -f "$tmp"
    return 1
  fi
  if ! printf '%s\n' "$new_id" > "$id_tmp" || ! write_secret "$tmp" || ! write_secret "$id_tmp"; then
    rm -f "$tmp" "$id_tmp"
    return 1
  fi
  mv -f "$tmp" "$token_file" && mv -f "$id_tmp" "$key_id_file"
}

# Rotate when the key is older than the rotation age, or when its id is
# unknown (keys written by older images): such a key is otherwise never expired.
rotate_key_if_due() {
  [ -s "$token_file" ] || return 0
  old_id=$(cat "$key_id_file" 2>/dev/null || true)
  if [ -z "$old_id" ]; then
    old_id=$(key_id_for_file "$token_file") || old_id=""
  elif [ -z "$(find "$token_file" -mtime +"$rotate_after_days" 2>/dev/null)" ]; then
    return 0
  fi
  create_key || return 1
  echo "headscale-entrypoint: rotated CovaFlux API key" >&2
  if [ -n "$old_id" ]; then
    sleep "$rotate_grace_seconds"
    headscale apikeys expire --id "$old_id" --force >/dev/null \
      || echo "headscale-entrypoint: failed to expire old API key $old_id" >&2
  fi
}

rm -f "$ready_file"
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
  create_key
fi
# Read by the compose healthcheck: CovaFlux starts only once a key exists.
touch "$ready_file"

(
  while true; do
    rotate_key_if_due || echo "headscale-entrypoint: API key rotation failed" >&2
    sleep "$rotate_check_seconds"
  done
) &

wait "$headscale_pid"
