#!/bin/sh
# Compatibility entry point; npm run native:build also works on Windows without Bash.
set -eu
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/scripts/build-native.mjs"
