#!/usr/bin/env bash
# Fails when drop-noop's Drop has a different public API from drop-android's. The Gradle plugin
# swaps one for the other per variant, so apps must compile against either.
# Run after `./gradlew :drop-android:assembleRelease :drop-noop:assembleRelease`.
set -euo pipefail
cd "$(dirname "$0")/.."
api() {
  # Kotlin's synthetic access$ accessors are an implementation detail, not API.
  javap -public "$1/build/intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes/com/r0adkll/drop/Drop.class" | grep -v 'access\$'
}
if ! diff <(api drop-android) <(api drop-noop); then
  echo "drop-noop's Drop differs from drop-android's (< drop-android, > drop-noop)." >&2
  exit 1
fi
echo "drop-noop matches drop-android's public API."
