#!/bin/sh
set -eu

# Started as root only to fix ownership of volumes created by older images,
# then drops to the unprivileged `node` user for the actual process.
if [ "$(id -u)" = "0" ]; then
  # Only volumes still owned by someone else (root lacks DAC_READ_SEARCH).
  [ "$(stat -c %u /data)" = "$(id -u node)" ] || chown -R node:node /data
  exec setpriv --reuid=node --regid=node --groups="${SECRETS_GID:-10001}" --inh-caps=-all -- "$0" "$@"
fi

exec "$@"
