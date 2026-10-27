#!/bin/sh
# Host tests for the firmware's pure C++ (no ESPHome needed): compiles and runs every *_test.cpp.
# Each test gets core's device protocol fixture as its argument; tests that don't need it ignore it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
fixture="${FRIDAY_PROTOCOL_FIXTURE:-$here/../../packages/core/test/fixtures/device-protocol.json}"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
status=0
for src in "$here"/*_test.cpp; do
  name=$(basename "$src" .cpp)
  echo "== $name"
  c++ -std=c++17 -O2 -Wall -Wextra -Werror -I "$here/../components" -I "$here" "$src" -o "$out/$name"
  "$out/$name" "$fixture" || status=1
done
exit $status
