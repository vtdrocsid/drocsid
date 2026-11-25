#!/bin/sh
# Build the image and run it like real installs do, then save settings through the setup API.
#  1. fresh Unraid install: root-owned App data folder, PUID=99 PGID=100 (template defaults)
#  2. no PUID/PGID, root-owned folder: falls back to 1000
#  3. existing install whose files belong to 1000 (folder 1000), no PUID: stays 1000
set -eu
IMG=drocsid:test
docker build -q -t "$IMG" . >/dev/null
fail=0
run_case() { # name dir expected_uid extra-docker-args...
  name=$1 dir=$2 want=$3; shift 3
  cid=$(docker run -d -p 3999:3005 -v "$dir:/data" "$@" "$IMG")
  ok=""
  for i in $(seq 1 40); do
    code=$(docker logs "$cid" 2>&1 | sed -n 's/.*setup code: *\([A-Z0-9-]*\).*/\1/p' | head -1)
    [ -n "$code" ] && curl -sf http://127.0.0.1:3999/api/config >/dev/null 2>&1 && { ok=1; break; }
    sleep 0.5
  done
  if [ -z "$ok" ]; then echo "  ✗ $name: did not start"; docker logs "$cid" 2>&1 | tail -20; fail=1; docker rm -f "$cid" >/dev/null; return; fi
  jar=$(mktemp)
  curl -s -c "$jar" -H 'Content-Type: application/json' -d "{\"code\":\"$code\"}" http://127.0.0.1:3999/api/setup/unlock >/dev/null
  status=$(curl -s -o /tmp/put.json -w '%{http_code}' -b "$jar" -X PUT -H 'Content-Type: application/json' -d '{"publicUrl":"https://example.domain.com"}' http://127.0.0.1:3999/api/connections/public-url)
  owner=$(sudo stat -c %u "$dir/connections.json" 2>/dev/null || echo none)
  proc=$(docker exec "$cid" sh -c 'cat /proc/1/status | awk "/^Uid:/{print \$2}"')
  if [ "$status" = 200 ] && [ "$owner" = "$want" ] && [ "$proc" = "$want" ]; then
    echo "  ✓ $name (runs as $proc, settings saved, owned by $owner)"
  else
    echo "  ✗ $name: save=$status owner=$owner process=$proc (want $want)"; cat /tmp/put.json; echo; docker logs "$cid" 2>&1 | tail -10; fail=1
  fi
  docker rm -f "$cid" >/dev/null; rm -f "$jar"
}
echo "Docker image"
d1=$(mktemp -d); sudo chown 0:0 "$d1"; sudo chmod 755 "$d1"
run_case "fresh install, root-owned folder, PUID 99/PGID 100" "$d1" 99 -e PUID=99 -e PGID=100
d2=$(mktemp -d); sudo chown 0:0 "$d2"; sudo chmod 755 "$d2"
run_case "no PUID, root-owned folder" "$d2" 1000
d3=$(mktemp -d); echo '{}' > "$d3/settings.json"; sudo chown -R 1000:1000 "$d3"
run_case "existing install owned by 1000, no PUID" "$d3" 1000
[ "$fail" = 0 ] && echo "All checks passed" || { echo "Docker checks failed"; exit 1; }
