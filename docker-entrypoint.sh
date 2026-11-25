#!/bin/sh
# Start as root just long enough to make /data writable, then run drocsid as a normal user.
# PUID/PGID pick that user (Unraid's template sets 99/100 = nobody:users). Without them, the
# user who already owns /data is kept, so existing installs don't change; a brand-new (root-owned)
# folder falls back to the image's "node" user (1000:1000).
set -e
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA"

if [ "$(id -u)" != "0" ]; then
  exec "$@"   # already started as a non-root user (docker run --user): nothing to change
fi

owner_uid=$(stat -c %u "$DATA")
owner_gid=$(stat -c %g "$DATA")
if [ -n "$PUID" ]; then
  uid="$PUID"; gid="${PGID:-$PUID}"
elif [ "$owner_uid" != "0" ]; then
  uid="$owner_uid"; gid="$owner_gid"
else
  uid=1000; gid=1000
fi

# Fix ownership only where it's wrong (cheap on every start, even with a large poster cache).
find "$DATA" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown "$uid:$gid" {} + 2>/dev/null || true
chmod u+rwx "$DATA" 2>/dev/null || true

export HOME=/tmp
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
