#!/bin/sh
# Host tests for the firmware's pure C++ (no ESPHome needed): compiles and runs every *_test.cpp.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
status=0
for src in "$here"/*_test.cpp; do
  name=$(basename "$src" .cpp)
  echo "== $name"
  c++ -std=c++17 -O2 -Wall -Wextra -Werror -I "$here/../components" -I "$here" "$src" -o "$out/$name"
  "$out/$name" || status=1
done
exit $status
