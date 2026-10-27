#!/bin/sh
# Boot check: start an image as CI built it and make sure it comes up, serves, and stops cleanly.
#
#   scripts/smoke.sh <image>          e.g. docker build -t friday:smoke . && scripts/smoke.sh friday:smoke
#
# The container gets an empty data directory (a fresh container's own /data), a new master key, no Gemini key and
# the placeholders in smoke.env, and publishes no port: every request is made inside the container, to 127.0.0.1,
# with the image's own node. Then, within 60 s, /health answers 200, / serves the built portal and /api/modules
# lists core first and every module as loaded. Finally SIGTERM must end it with exit code 0 within 10 s.
# Any failure prints the container's log and exits 1. The container is always removed.
set -eu

image="${1:?usage: scripts/smoke.sh <image>}"
here=$(cd "$(dirname "$0")" && pwd)
name="friday-smoke-$$"
started=0

cleanup() { [ "$started" = 1 ] && docker rm -f "$name" >/dev/null 2>&1; return 0; }
trap cleanup EXIT

fail() {
  echo "smoke: FAIL: $*" >&2
  if [ "$started" = 1 ]; then
    echo "--- container log ($name)" >&2
    docker logs "$name" >&2 2>&1 || true
  fi
  exit 1
}

# GET a path inside the container; prints the status on the first line and the body after it.
get() {
  docker exec "$name" node -e '
    fetch("http://127.0.0.1:8080" + process.argv[1], { redirect: "manual" })
      .then(async (r) => process.stdout.write(r.status + "\n" + (await r.text())))
      .catch((e) => process.stdout.write("000\n" + e.message));
  ' "$1" 2>/dev/null || printf '000\n'
}
status() { printf '%s\n' "$1" | head -n 1; }

key=$(head -c 32 /dev/urandom | base64)
docker run -d --name "$name" --env-file "$here/smoke.env" -e FRIDAY_MASTER_KEY="$key" "$image" >/dev/null || fail "could not start $image"
started=1
echo "smoke: started $image as $name"

# 1. /health within 60 s.
deadline=$(( $(date +%s) + 60 ))
while :; do
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "the container exited during start-up"
  health=$(get /health)
  [ "$(status "$health")" = 200 ] && break
  [ "$(date +%s)" -lt "$deadline" ] || fail "/health did not answer 200 within 60 s (last: $(status "$health"))"
  sleep 1
done
echo "smoke: /health 200"

# 2. The built portal at /.
root=$(get /)
[ "$(status "$root")" = 200 ] || fail "/ answered $(status "$root")"
case "$root" in *'id="app"'*) ;; *) fail "/ is not the portal (no #app)" ;; esac
case "$root" in *'src="/assets/'*) ;; *) fail "/ is not the built portal (no /assets/ script)" ;; esac
echo "smoke: / serves the portal"

# 3. Every module loaded, core first.
modules=$(docker exec "$name" node -e '
  fetch("http://127.0.0.1:8080/api/modules").then((r) => r.json()).then((list) => {
    const problems = [];
    if (list[0]?.id !== "core") problems.push("core is not listed first");
    for (const m of list) if (m.status !== "loaded") problems.push(`${m.id} is ${m.status}${m.error ? `: ${m.error}` : ""}`);
    if (problems.length) { console.log(problems.join("\n")); process.exit(1); }
    console.log(list.map((m) => m.id).join(", "));
  }).catch((e) => { console.log(`/api/modules: ${e.message}`); process.exit(1); });
' 2>&1) || fail "modules: $modules"
echo "smoke: modules loaded: $modules"

# 4. A clean stop on SIGTERM. docker stop sends SIGKILL after 10 s, which shows as exit code 137.
docker stop -t 10 "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] || fail "exit code $code after SIGTERM (137: it did not stop within 10 s)"
echo "smoke: stopped cleanly"
echo "smoke: OK"
