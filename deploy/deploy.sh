#!/bin/sh
# Builds on this machine and copies the result to the container.
# Usage: deploy/deploy.sh root@container-address
set -eu
TARGET="${1:?usage: deploy/deploy.sh root@container-address}"
npm run build
npm run build:server
rsync -rlptz --delete --chown=sparkle:sparkle --relative \
  dist/client dist/server db/migrations deploy "$TARGET:/opt/sparkle-carpets/"
ssh "$TARGET" systemctl restart sparkle-carpets
ssh "$TARGET" 'sleep 2; curl -fsS -o /dev/null http://127.0.0.1:8787/api/pricing && echo "deployed and answering"'
