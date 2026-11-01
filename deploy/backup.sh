#!/bin/sh
# Keeps 30 daily consistent copies of the database next to it. Copy this folder
# off the container too: a backup on the same disk won't survive losing it.
set -eu
DB=/var/lib/sparkle-carpets/sparkle.db
DIR=/var/lib/sparkle-carpets/backups
mkdir -p "$DIR"
OUT="$DIR/sparkle-$(date +%F).db"
rm -f "$OUT"
sqlite3 "$DB" "VACUUM INTO '$OUT'"
sqlite3 "$OUT" "PRAGMA integrity_check" | grep -qx ok
gzip -f "$OUT"
find "$DIR" -name 'sparkle-*.db.gz' -mtime +30 -delete
